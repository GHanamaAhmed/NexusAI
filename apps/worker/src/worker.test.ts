import { parseCallWindow } from "@nexus/core"
import type { Db } from "@nexus/db"
import { createTestDb, resetTestDb } from "@nexus/db/testing"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { deliverWebhooks } from "./deliver.js"
import { isHealthy, purgeExpiredTasks } from "./housekeeping.js"
import { type CheckRequest, promoteDueTasks } from "./promote.js"

const window = parseCallWindow("09:00-20:00")
const noon = new Date("2026-10-30T11:00:00Z") // 12:00 in Algiers
const night = new Date("2026-10-30T22:00:00Z") // 23:00 in Algiers

describe("worker", () => {
  let db: Db

  beforeAll(async () => {
    db = await createTestDb()
  })
  beforeEach(() => resetTestDb(db))
  afterAll(() => db.destroy())

  async function makeTask(overrides: { attempts?: number } = {}) {
    const account = await db
      .insertInto("account")
      .values({ name: "One", webhook_secret: "secret" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const store = await db
      .insertInto("client_store")
      .values({ account_id: account.id, external_id: "store-1", name: "Store" })
      .returning("id")
      .executeTakeFirstOrThrow()
    return db
      .insertInto("task")
      .values({
        account_id: account.id,
        client_store_id: store.id,
        type: "order_confirmation",
        external_id: "order-1",
        idempotency_key: "order-1",
        payload: JSON.stringify({}),
        language: "ar",
        mode: "keypad",
        outcome_url: "https://client.example.com/outcome",
        check_url: "https://client.example.com/check",
        next_attempt_at: new Date(noon.getTime() - 60_000),
        purge_after: new Date(noon.getTime() + 86_400_000),
        attempts: overrides.attempts ?? 0,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  }

  const readTask = (id: string) =>
    db
      .selectFrom("task")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  const attemptsOf = (id: string) =>
    db.selectFrom("attempt").selectAll().where("task_id", "=", id).execute()

  describe("promoteDueTasks", () => {
    it("queues the next attempt when the client still wants the call", async () => {
      const { id } = await makeTask({ attempts: 1 })
      const check = vi.fn(async (_request: CheckRequest) => true)
      expect(await promoteDueTasks(db, { window, check, now: noon })).toBe(1)

      expect(check).toHaveBeenCalledWith({
        url: "https://client.example.com/check",
        secret: "secret",
        externalStoreId: "store-1",
        externalId: "order-1",
      })
      const task = await readTask(id)
      expect(task.status).toBe("calling")
      expect(task.attempts).toBe(2)
      const attempts = await attemptsOf(id)
      expect(attempts.map((a) => [a.number, a.status])).toEqual([[2, "queued"]])
    })

    it("cancels a task the client no longer wants", async () => {
      const { id } = await makeTask()
      await promoteDueTasks(db, {
        window,
        check: async () => false,
        now: noon,
      })
      expect((await readTask(id)).status).toBe("cancelled")
      expect(await attemptsOf(id)).toEqual([])
    })

    it("tries the check again later when the client can't answer", async () => {
      const { id } = await makeTask()
      await promoteDueTasks(db, {
        window,
        check: async () => {
          throw new Error("down")
        },
        now: noon,
      })
      const task = await readTask(id)
      expect(task.status).toBe("scheduled")
      expect(task.next_attempt_at).toEqual(new Date(noon.getTime() + 300_000))
      expect(await attemptsOf(id)).toEqual([])
    })

    it("holds due tasks until call hours, without asking the client", async () => {
      const { id } = await makeTask()
      const check = vi.fn()
      expect(await promoteDueTasks(db, { window, check, now: night })).toBe(0)
      expect(check).not.toHaveBeenCalled()
      const task = await readTask(id)
      expect(task.status).toBe("scheduled")
      expect(task.next_attempt_at).toEqual(new Date("2026-10-31T08:00:00Z"))
    })

    it("leaves tasks that aren't due", async () => {
      const { id } = await makeTask()
      const early = new Date(noon.getTime() - 3_600_000)
      await promoteDueTasks(db, { window, check: async () => true, now: early })
      expect((await readTask(id)).status).toBe("scheduled")
    })
  })

  describe("deliverWebhooks", () => {
    async function makeDelivery(tries = 0) {
      const { id: taskId } = await makeTask()
      const { id: attemptId } = await db
        .insertInto("attempt")
        .values({ task_id: taskId, number: 1 })
        .returning("id")
        .executeTakeFirstOrThrow()
      return db
        .insertInto("webhook_delivery")
        .values({
          task_id: taskId,
          attempt_id: attemptId,
          event: "task.completed",
          body: JSON.stringify({ outcome: "confirmed" }),
          next_try_at: new Date(noon.getTime() - 1000),
          tries,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    }

    const readDelivery = (id: string) =>
      db
        .selectFrom("webhook_delivery")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow()

    it("marks a delivered result", async () => {
      const { id } = await makeDelivery()
      const send = vi.fn(async () => ({ ok: true as const }))
      await deliverWebhooks(db, { send, now: noon })
      expect(send).toHaveBeenCalledWith({
        url: "https://client.example.com/outcome",
        secret: "secret",
        deliveryId: id,
        body: '{"outcome":"confirmed"}',
      })
      const delivery = await readDelivery(id)
      expect(delivery.status).toBe("delivered")
      expect(delivery.tries).toBe(1)
    })

    it("tries a failed result again later", async () => {
      const { id } = await makeDelivery()
      await deliverWebhooks(db, {
        send: async () => ({ ok: false, error: "answered 500" }),
        now: noon,
      })
      const delivery = await readDelivery(id)
      expect(delivery.status).toBe("pending")
      expect(delivery.last_error).toBe("answered 500")
      expect(delivery.next_try_at).toEqual(new Date(noon.getTime() + 60_000))
    })

    it("gives up after the last try", async () => {
      const { id } = await makeDelivery(23)
      await deliverWebhooks(db, {
        send: async () => ({ ok: false, error: "down" }),
        now: noon,
      })
      expect((await readDelivery(id)).status).toBe("failed")
    })

    it("doesn't send a result twice at once", async () => {
      await makeDelivery()
      const send = vi.fn(async () => ({ ok: false as const, error: "down" }))
      await Promise.all([
        deliverWebhooks(db, { send, now: noon }),
        deliverWebhooks(db, { send, now: noon }),
      ])
      expect(send).toHaveBeenCalledTimes(1)
    })
  })

  describe("housekeeping", () => {
    it("deletes tasks past their retention", async () => {
      const { id } = await makeTask()
      const later = new Date(noon.getTime() + 2 * 86_400_000)
      expect(await purgeExpiredTasks(db, noon)).toBe(0)
      expect(await purgeExpiredTasks(db, later)).toBe(1)
      await expect(readTask(id)).rejects.toThrow()
    })

    it("is healthy only while a line registered recently", async () => {
      expect(await isHealthy(db, noon)).toBe(false)
      await db
        .insertInto("line_status")
        .values({ line: "line01", registered: true, updated_at: noon })
        .execute()
      expect(await isHealthy(db, noon)).toBe(true)
      const later = new Date(noon.getTime() + 6 * 60_000)
      expect(await isHealthy(db, later)).toBe(false)
    })
  })
})
