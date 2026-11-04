import { parseCallWindow } from "@nexus/core"
import type { Db } from "@nexus/db"
import { createTestDb, resetTestDb } from "@nexus/db/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "./app.js"
import { createAccount, createApiKey } from "./keys.js"

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: { title: { type: "string" } },
}

const INPUT = {
  external_store_id: "store-1",
  schema: SCHEMA,
  instructions: "A short title.",
  brief: "Linen shirts.",
  photos: ["https://files.example/a.jpg"],
  language: "ar",
  max_generated_images: 2,
}

describe("Generations", () => {
  let db: Db
  let app: Awaited<ReturnType<typeof buildApp>>
  let without: Awaited<ReturnType<typeof buildApp>>
  let key: string
  let otherKey: string
  let accountId: string

  const build = (textProviders?: string[]) =>
    buildApp({
      db,
      callWindow: parseCallWindow("09:00-20:00"),
      allowHttpCallbacks: false,
      textProviders,
    })

  beforeAll(async () => {
    db = await createTestDb()
    app = await build(["meta"])
    without = await build()
  })

  beforeEach(async () => {
    await resetTestDb(db)
    accountId = (await createAccount(db, "One")).id
    key = await createApiKey(db, accountId)
    otherKey = await createApiKey(db, (await createAccount(db, "Two")).id)
  })

  afterAll(async () => {
    await app.close()
    await without.close()
    await db.destroy()
  })

  const start = (
    body: unknown = INPUT,
    headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      "idempotency-key": "gen-1",
    },
    target = app
  ) =>
    target.inject({
      method: "POST",
      url: "/v1/generations",
      headers,
      payload: body as object,
    })
  const read = (id: string, apiKey = key) =>
    app.inject({
      url: `/v1/generations/${id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    })

  it("starts a generation, queued, keeping what was sent", async () => {
    const response = await start()
    expect(response.statusCode).toBe(202)
    const { id, status } = response.json()
    expect(status).toBe("queued")
    const row = await db
      .selectFrom("generation")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      account_id: accountId,
      external_store_id: "store-1",
      idempotency_key: "gen-1",
    })
    expect(row.input).toEqual({
      schema: SCHEMA,
      instructions: "A short title.",
      brief: "Linen shirts.",
      photos: ["https://files.example/a.jpg"],
      language: "ar",
      max_generated_images: 2,
    })
    expect(row.purge_after.getTime()).toBeGreaterThan(
      Date.now() + 6 * 24 * 3_600_000
    )
  })

  it("returns the same generation for the same key", async () => {
    const first = (await start()).json()
    const again = await start()
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first)
  })

  it("needs a key, an idempotency key and the Meta key", async () => {
    expect((await start(INPUT, { "idempotency-key": "x" })).statusCode).toBe(
      401
    )
    const noKey = await start(INPUT, { authorization: `Bearer ${key}` })
    expect(noKey.json().code).toBe("idempotency_key_required")
    const unavailable = await start(undefined, undefined, without)
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json().code).toBe("generation_unavailable")
  })

  it.each([
    [{ ...INPUT, schema: { type: "array" } }, "schema"],
    [
      { ...INPUT, photos: Array(9).fill("https://files.example/a.jpg") },
      "photos",
    ],
    [{ ...INPUT, photos: ["http://files.example/a.jpg"] }, "photos.0"],
    [{ ...INPUT, language: "en" }, "language"],
    [{ ...INPUT, max_generated_images: 5 }, "max_generated_images"],
    [{ ...INPUT, brief: "" }, "brief"],
    [{ ...INPUT, extra: true }, ""],
  ])("refuses an input that doesn't fit (%#)", async (body, path) => {
    const response = await start(body)
    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe("invalid_generation")
    expect(response.json().problems[0].path).toBe(path)
  })

  it("limits how many an account has waiting or running", async () => {
    for (const n of [1, 2, 3]) {
      expect(
        (
          await start(INPUT, {
            authorization: `Bearer ${key}`,
            "idempotency-key": `gen-${n}`,
          })
        ).statusCode
      ).toBe(202)
    }
    const fourth = await start(INPUT, {
      authorization: `Bearer ${key}`,
      "idempotency-key": "gen-4",
    })
    expect(fourth.statusCode).toBe(429)
    const others = await start(INPUT, {
      authorization: `Bearer ${otherKey}`,
      "idempotency-key": "gen-1",
    })
    expect(others.statusCode).toBe(202)
  })

  it("lets only its account read it and its images", async () => {
    const { id } = (await start()).json()
    await db
      .updateTable("generation")
      .set({
        status: "done",
        result: JSON.stringify({
          design: { title: "x" },
          images: [],
          problems: [],
        }),
        cost: JSON.stringify({ usd: 0.1 }),
      })
      .where("id", "=", id)
      .execute()
    await db
      .insertInto("generation_image")
      .values({
        generation_id: id,
        slot: 0,
        shape: "wide",
        format: "webp",
        bytes: Buffer.from("pixels"),
      })
      .execute()

    const own = await read(id)
    expect(own.statusCode).toBe(200)
    expect(own.json()).toMatchObject({
      id,
      status: "done",
      result: { design: { title: "x" } },
      cost: { usd: 0.1 },
    })
    expect((await read(id, otherKey)).statusCode).toBe(404)

    const image = await app.inject({
      url: `/v1/generations/${id}/images/0`,
      headers: { authorization: `Bearer ${key}` },
    })
    expect(image.statusCode).toBe(200)
    expect(image.headers["content-type"]).toBe("image/webp")
    expect(image.rawPayload.toString()).toBe("pixels")
    const theirs = await app.inject({
      url: `/v1/generations/${id}/images/0`,
      headers: { authorization: `Bearer ${otherKey}` },
    })
    expect(theirs.statusCode).toBe(404)
    const missing = await app.inject({
      url: `/v1/generations/${id}/images/3`,
      headers: { authorization: `Bearer ${key}` },
    })
    expect(missing.statusCode).toBe(404)
  })

  it("answers 404 for an id that isn't one", async () => {
    expect((await read("nope")).statusCode).toBe(404)
  })
})
