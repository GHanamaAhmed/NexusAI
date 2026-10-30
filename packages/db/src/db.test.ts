import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type Db, migrateToLatest } from "./index.js"
import { createTestDb, resetTestDb } from "./testing.js"

describe("database", () => {
  let db: Db

  beforeAll(async () => {
    db = await createTestDb()
  })
  beforeEach(() => resetTestDb(db))
  afterAll(() => db.destroy())

  it("can migrate again without changing anything", async () => {
    await expect(migrateToLatest(db)).resolves.toBeUndefined()
  })

  it("keeps one attempt per number on a task", async () => {
    const { id: accountId } = await db
      .insertInto("account")
      .values({ name: "a", webhook_secret: "s" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const { id: storeId } = await db
      .insertInto("client_store")
      .values({ account_id: accountId, external_id: "s1", name: "Store" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const { id: taskId } = await db
      .insertInto("task")
      .values({
        account_id: accountId,
        client_store_id: storeId,
        type: "order_confirmation",
        external_id: "o1",
        idempotency_key: "k1",
        reference: null,
        payload: JSON.stringify({}),
        language: "ar",
        mode: "keypad",
        outcome_url: "https://example.com/o",
        check_url: "https://example.com/c",
        next_attempt_at: new Date(),
        outcome: null,
        purge_after: new Date(),
      })
      .returning("id")
      .executeTakeFirstOrThrow()

    const attempt = { task_id: taskId, number: 1, line: null }
    const blank = {
      hangup_cause: null,
      amd_status: null,
      digits: null,
      outcome: null,
      note: null,
      transcript: null,
      cost: null,
    }
    await db
      .insertInto("attempt")
      .values({ ...attempt, ...blank })
      .execute()
    await expect(
      db
        .insertInto("attempt")
        .values({ ...attempt, ...blank })
        .execute()
    ).rejects.toThrow(/unique/i)
  })
})
