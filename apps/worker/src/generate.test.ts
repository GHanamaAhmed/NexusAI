import { DesignRefused, type GenerationOutcome } from "@nexus/ai/generation"
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
import {
  failStaleGenerations,
  type Generate,
  GenerationRunner,
  purgeExpiredGenerations,
} from "./generate.js"

const INPUT = {
  schema: { type: "object" },
  instructions: "",
  brief: "Linen shirts.",
  photos: [],
  language: "fr",
  max_generated_images: 2,
}

const OUTCOME: GenerationOutcome = {
  design: { hero: "generated:0" },
  images: [
    { slot: 0, shape: "wide", format: "webp", bytes: Buffer.from("wide") },
  ],
  problems: ["1 images could not be made"],
  cost: {
    usd: 0.21,
    text_model: "muse-wonder-1.0",
    image_model: "muse-image-1.0",
    input_tokens: 20_000,
    cached_tokens: 0,
    output_tokens: 6_000,
    images: 1,
  },
}

describe("generations in the worker", () => {
  let db: Db
  let accountId: string

  beforeAll(async () => {
    db = await createTestDb()
  })
  beforeEach(async () => {
    await resetTestDb(db)
    const account = await db
      .insertInto("account")
      .values({ name: "One", webhook_secret: "secret" })
      .returning("id")
      .executeTakeFirstOrThrow()
    accountId = account.id
  })
  afterAll(() => db.destroy())

  async function queue(key: string, overrides: Record<string, unknown> = {}) {
    const row = await db
      .insertInto("generation")
      .values({
        account_id: accountId,
        idempotency_key: key,
        external_store_id: "store-1",
        input: JSON.stringify(INPUT),
        purge_after: new Date(Date.now() + 86_400_000),
        ...overrides,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
    return row.id
  }

  const read = (id: string) =>
    db
      .selectFrom("generation")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow()

  const runner = (generate: Generate, limit = 2) =>
    new GenerationRunner({ db, generate, limit, log: () => {} })

  it("runs a queued generation and records its design, images and cost", async () => {
    const id = await queue("a")
    const generate = vi.fn(async () => OUTCOME)
    const run = runner(generate)
    expect(await run.tick()).toBe(1)
    await run.idle()

    expect(generate).toHaveBeenCalledWith(INPUT)
    const row = await read(id)
    expect(row).toMatchObject({
      status: "done",
      error: null,
      result: {
        design: { hero: "generated:0" },
        images: [{ slot: 0, shape: "wide" }],
        problems: ["1 images could not be made"],
      },
      cost: { usd: 0.21, images: 1 },
    })
    expect(row.started_at).not.toBeNull()
    expect(row.finished_at).not.toBeNull()
    const images = await db
      .selectFrom("generation_image")
      .selectAll()
      .where("generation_id", "=", id)
      .execute()
    expect(images.map((image) => image.bytes.toString())).toEqual(["wide"])
  })

  it("records a failure and its reason", async () => {
    const id = await queue("a")
    const run = runner(async () => {
      throw new DesignRefused(["/title must be string"])
    })
    await run.tick()
    await run.idle()
    const row = await read(id)
    expect(row.status).toBe("failed")
    expect(row.error).toContain("/title must be string")
    expect(row.result).toBeNull()
  })

  it("runs no more at once than its limit, oldest first", async () => {
    const ids = [await queue("a"), await queue("b"), await queue("c")]
    let release = () => {}
    const held = new Promise<GenerationOutcome>(
      (resolve) => (release = () => resolve(OUTCOME))
    )
    const run = runner(() => held, 2)
    expect(await run.tick()).toBe(2)
    expect(await run.tick()).toBe(0)
    expect((await read(ids[0]!)).status).toBe("running")
    expect((await read(ids[2]!)).status).toBe("queued")
    release()
    await run.idle()
    expect(await run.tick()).toBe(1)
    await run.idle()
    expect((await read(ids[2]!)).status).toBe("done")
  })

  it("fails what a stopped worker left running, but not its own", async () => {
    const old = new Date(Date.now() - 20 * 60_000)
    const stale = await queue("a", { status: "running", started_at: old })
    const own = await queue("b", { status: "running", started_at: old })
    const recent = await queue("c", {
      status: "running",
      started_at: new Date(),
    })
    expect(await failStaleGenerations(db, [own])).toBe(1)
    expect(await read(stale)).toMatchObject({
      status: "failed",
      error: "interrupted",
    })
    expect((await read(own)).status).toBe("running")
    expect((await read(recent)).status).toBe("running")
  })

  it("deletes generations past their time, with their images", async () => {
    const old = await queue("a", { purge_after: new Date(Date.now() - 1_000) })
    await queue("b")
    await db
      .insertInto("generation_image")
      .values({
        generation_id: old,
        slot: 0,
        shape: "tall",
        format: "webp",
        bytes: Buffer.from("x"),
      })
      .execute()
    expect(await purgeExpiredGenerations(db)).toBe(1)
    const left = await db
      .selectFrom("generation_image")
      .select("slot")
      .execute()
    expect(left).toEqual([])
  })
})
