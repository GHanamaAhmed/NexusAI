import { parseCallWindow } from "@nexus/core"
import type { Db } from "@nexus/db"
import { createTestDb, resetTestDb } from "@nexus/db/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "./app.js"
import { createAccount, createApiKey } from "./keys.js"

const task = {
  type: "order_confirmation",
  external_store_id: "store-1",
  external_id: "order-1",
  reference: "1042",
  store: { name: "Boutique Yasmine" },
  customer: { phone: "+213551234567", language: "ar" },
  order: {
    items: [{ title: "Chemise", quantity: 2 }],
    total: 6500,
    currency: "DZD",
    delivery: { type: "home", region: "Alger", city: "Bab Ezzouar" },
  },
  callbacks: {
    outcome_url: "https://client.example.com/outcome",
    check_url: "https://client.example.com/check",
  },
}

describe("API", () => {
  let db: Db
  let app: Awaited<ReturnType<typeof buildApp>>
  let key: string
  let otherKey: string

  beforeAll(async () => {
    db = await createTestDb()
    app = await buildApp({
      db,
      callWindow: parseCallWindow("09:00-20:00"),
      allowHttpCallbacks: false,
    })
  })

  beforeEach(async () => {
    await resetTestDb(db)
    key = await createApiKey(db, (await createAccount(db, "One")).id)
    otherKey = await createApiKey(db, (await createAccount(db, "Two")).id)
  })

  afterAll(async () => {
    await app.close()
    await db.destroy()
  })

  const send = (
    body: unknown,
    headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      "idempotency-key": "order-1",
    }
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers,
      payload: body as object,
    })

  it("reports its health", async () => {
    const response = await app.inject({ url: "/health" })
    expect(response.json()).toEqual({ ok: true })
  })

  it("refuses a missing or revoked key", async () => {
    expect((await send(task, { "idempotency-key": "k" })).statusCode).toBe(401)
    await db.updateTable("api_key").set({ revoked_at: new Date() }).execute()
    expect((await send(task)).statusCode).toBe(401)
  })

  it("needs an idempotency key", async () => {
    const response = await send(task, { authorization: `Bearer ${key}` })
    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe("idempotency_key_required")
  })

  it("schedules a task inside the call window", async () => {
    const response = await send(task)
    expect(response.statusCode).toBe(201)
    const stored = await db
      .selectFrom("task")
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(stored.status).toBe("scheduled")
    expect(stored.mode).toBe("keypad")
    expect(stored.next_attempt_at.getTime()).toBeGreaterThan(Date.now())
    expect(stored.purge_after.getTime()).toBeGreaterThan(Date.now())
  })

  it("makes one task from a repeated request", async () => {
    const first = await send(task)
    const second = await send(task)
    expect(second.statusCode).toBe(200)
    expect(second.json().id).toBe(first.json().id)
    const { count } = await db
      .selectFrom("task")
      .select(db.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow()
    expect(count).toBe("1")
  })

  it.each([
    [
      "a foreign number",
      { customer: { phone: "+33612345678", language: "ar" } },
    ],
    ["a local number", { customer: { phone: "0551234567", language: "ar" } }],
    [
      "an insecure callback",
      {
        callbacks: {
          outcome_url: "http://client.example.com/outcome",
          check_url: "https://client.example.com/check",
        },
      },
    ],
    ["an unknown field", { extra: true }],
  ])("refuses %s", async (_name, change) => {
    const response = await send({ ...task, ...change })
    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe("invalid_task")
  })

  it("doesn't show the customer's phone", async () => {
    const { id } = (await send(task)).json()
    const response = await app.inject({
      url: `/v1/tasks/${id}`,
      headers: { authorization: `Bearer ${key}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain("213551234567")
  })

  it("hides one account's tasks from another", async () => {
    const { id } = (await send(task)).json()
    const headers = { authorization: `Bearer ${otherKey}` }
    const read = await app.inject({ url: `/v1/tasks/${id}`, headers })
    expect(read.statusCode).toBe(404)
    const cancel = await app.inject({
      method: "DELETE",
      url: `/v1/tasks/${id}`,
      headers,
    })
    expect(cancel.statusCode).toBe(404)
  })

  it("cancels a scheduled task once", async () => {
    const { id } = (await send(task)).json()
    const headers = { authorization: `Bearer ${key}` }
    const remove = () =>
      app.inject({ method: "DELETE", url: `/v1/tasks/${id}`, headers })
    expect((await remove()).json().status).toBe("cancelled")
    expect((await remove()).statusCode).toBe(409)
  })
})
