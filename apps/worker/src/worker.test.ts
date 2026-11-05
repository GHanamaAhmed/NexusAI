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
import { finishAttempts } from "./finish.js"
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

    it("calls at night for an account whose hours are open then", async () => {
      const { id } = await makeTask()
      const { account_id } = await readTask(id)
      await db
        .insertInto("voice_settings")
        .values({
          account_id,
          settings: JSON.stringify({
            call_hours: { opens: "00:00", closes: "24:00" },
          }),
        })
        .execute()
      const check = vi.fn(async (_: CheckRequest) => true)
      expect(await promoteDueTasks(db, { window, check, now: night })).toBe(1)
      expect(check).toHaveBeenCalledOnce()
    })

    it("leaves tasks that aren't due", async () => {
      const { id } = await makeTask()
      const early = new Date(noon.getTime() - 3_600_000)
      await promoteDueTasks(db, { window, check: async () => true, now: early })
      expect((await readTask(id)).status).toBe("scheduled")
    })
  })

  describe("finishAttempts", () => {
    async function finished(values: {
      number?: number
      outcome: string
      note?: string
      callback_at?: Date
      change?: { wilaya_code: number; commune_ar: string; commune_fr: string }
      answered_at?: Date
      ended_at?: Date
      cost?: Record<string, number | string>
    }) {
      const number = values.number ?? 1
      const { id: taskId } = await makeTask({ attempts: number })
      await db
        .updateTable("task")
        .set({ status: "calling" })
        .where("id", "=", taskId)
        .execute()
      const { id: attemptId } = await db
        .insertInto("attempt")
        .values({
          task_id: taskId,
          number,
          status: "done",
          line: "line01",
          started_at: noon,
          answered_at: values.answered_at ?? null,
          ended_at: values.ended_at ?? noon,
          cost: values.cost ? JSON.stringify(values.cost) : null,
          outcome: values.outcome,
          note: values.note ?? null,
          callback_at: values.callback_at ?? null,
          change: values.change ? JSON.stringify(values.change) : null,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      return { taskId, attemptId }
    }

    const deliveriesOf = (taskId: string) =>
      db
        .selectFrom("webhook_delivery")
        .selectAll()
        .where("task_id", "=", taskId)
        .execute()

    it("completes the task on a final answer, and sends the result", async () => {
      const change = {
        wilaya_code: 1,
        commune_ar: "رقان",
        commune_fr: "Reggane",
      }
      const { taskId, attemptId } = await finished({
        outcome: "request_change",
        note: "تبديل لرقان",
        change,
      })
      expect(await finishAttempts(db, { window, now: noon })).toBe(1)
      expect(await readTask(taskId)).toMatchObject({
        status: "done",
        outcome: "request_change",
        completed_at: noon,
      })
      const [delivery] = await deliveriesOf(taskId)
      expect(delivery).toMatchObject({
        event: "task.completed",
        attempt_id: attemptId,
        status: "pending",
        next_try_at: noon,
      })
      expect(delivery!.body).toEqual({
        event: "task.completed",
        task_id: taskId,
        attempt_id: attemptId,
        external_store_id: "store-1",
        external_id: "order-1",
        reference: null,
        attempt: 1,
        max_attempts: 3,
        outcome: "request_change",
        note: "تبديل لرقان",
        callback_at: null,
        change,
        ended_at: noon.toISOString(),
        usage: { model: null, answered_seconds: 0, usd: 0 },
      })
    })

    it("reports what an answered call used", async () => {
      const { taskId } = await finished({
        outcome: "confirmed",
        answered_at: noon,
        ended_at: new Date(noon.getTime() + 61_500),
        cost: { usd: 0.03, prompt_audio_tokens: 900, model: "voice-1" },
      })
      await finishAttempts(db, { window, now: noon })
      const [delivery] = await deliveriesOf(taskId)
      expect(delivery!.body).toMatchObject({
        usage: { model: "voice-1", answered_seconds: 62, usd: 0.03 },
      })
    })

    it("reports an answered call with no cost as costing nothing", async () => {
      const { taskId } = await finished({
        outcome: "no_input",
        answered_at: noon,
        ended_at: new Date(noon.getTime() + 5_000),
      })
      await finishAttempts(db, { window, now: noon })
      const [delivery] = await deliveriesOf(taskId)
      expect(delivery!.body).toMatchObject({
        usage: { model: null, answered_seconds: 5, usd: 0 },
      })
    })

    it("reports nothing used by a call nobody answered", async () => {
      const { taskId } = await finished({ outcome: "no_answer" })
      await finishAttempts(db, { window, now: noon })
      const [delivery] = await deliveriesOf(taskId)
      expect(delivery!.body).toMatchObject({
        usage: { model: null, answered_seconds: 0, usd: 0 },
      })
    })

    it("schedules the next try after no answer, and tells the client", async () => {
      const { taskId } = await finished({ outcome: "no_answer" })
      await finishAttempts(db, { window, now: noon })
      const task = await readTask(taskId)
      expect(task.status).toBe("scheduled")
      expect(task.next_attempt_at).toEqual(new Date(noon.getTime() + 3_600_000))
      expect(task.outcome).toBeNull()
      const [delivery] = await deliveriesOf(taskId)
      expect(delivery!.event).toBe("task.attempted")
      expect(delivery!.body).toMatchObject({ attempt: 1, outcome: "no_answer" })
    })

    it("completes the task after the last try", async () => {
      const { taskId } = await finished({ number: 3, outcome: "busy" })
      await finishAttempts(db, { window, now: noon })
      expect(await readTask(taskId)).toMatchObject({
        status: "done",
        outcome: "busy",
      })
      expect((await deliveriesOf(taskId))[0]!.event).toBe("task.completed")
    })

    it("passes on when to call back", async () => {
      const when = new Date("2026-10-31T15:00:00Z")
      const { taskId } = await finished({
        outcome: "call_later",
        callback_at: when,
      })
      await finishAttempts(db, { window, now: noon })
      expect((await deliveriesOf(taskId))[0]!.body).toMatchObject({
        outcome: "call_later",
        callback_at: when.toISOString(),
      })
    })

    it("makes each result once", async () => {
      const { taskId } = await finished({ outcome: "confirmed" })
      await Promise.all([
        finishAttempts(db, { window, now: noon }),
        finishAttempts(db, { window, now: noon }),
      ])
      await finishAttempts(db, { window, now: noon })
      expect(await deliveriesOf(taskId)).toHaveLength(1)
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
