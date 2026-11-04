import { defaultVoiceSettings, modelSettings } from "@nexus/ai"
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
  readAccountSettings,
  runnableSettings,
  testSettings,
} from "./sessions.js"

describe("readAccountSettings", () => {
  let db: Db
  let accountId: string
  const log = vi.fn()

  beforeAll(async () => {
    db = await createTestDb()
  })
  beforeEach(async () => {
    await resetTestDb(db)
    log.mockClear()
    const account = await db
      .insertInto("account")
      .values({ name: "One", webhook_secret: "secret" })
      .returning("id")
      .executeTakeFirstOrThrow()
    accountId = account.id
  })
  afterAll(() => db.destroy())

  const save = (settings: unknown) =>
    db
      .insertInto("voice_settings")
      .values({ account_id: accountId, settings: JSON.stringify(settings) })
      .execute()

  it("gives the defaults to an account that saved nothing", async () => {
    expect(await readAccountSettings(db, accountId, log)).toEqual(
      defaultVoiceSettings()
    )
    expect(log).not.toHaveBeenCalled()
  })

  it("reads what the account saved", async () => {
    const settings = { ...defaultVoiceSettings(), max_call_seconds: 90 }
    await save(settings)
    expect(await readAccountSettings(db, accountId, log)).toEqual(settings)
  })

  it("calls with the defaults when the row doesn't fit, and says so", async () => {
    await save({ active_model: "a-model-from-the-future" })
    expect(await readAccountSettings(db, accountId, log)).toEqual(
      defaultVoiceSettings()
    )
    expect(log).toHaveBeenCalledOnce()
  })

  it("calls with the defaults when the row can't be read, and says so", async () => {
    const broken = {
      selectFrom: () => {
        throw new Error("database gone")
      },
    } as unknown as Db
    expect(await readAccountSettings(broken, accountId, log)).toEqual(
      defaultVoiceSettings()
    )
    expect(log).toHaveBeenCalledOnce()
  })
})

describe("runnableSettings", () => {
  const log = vi.fn()
  const openai = {
    ...defaultVoiceSettings(),
    active_model: "gpt-live-1",
  } as const

  beforeEach(() => log.mockClear())

  it("keeps a model whose key is set", () => {
    expect(runnableSettings(openai, { gemini: "a", openai: "b" }, log)).toEqual(
      openai
    )
    expect(log).not.toHaveBeenCalled()
  })

  it("falls back to the default model when its key has gone, and says so", () => {
    const settings = runnableSettings(openai, { gemini: "a" }, log)
    expect(settings.active_model).toBe("gemini-3.8-live")
    expect(log).toHaveBeenCalledOnce()
  })
})

describe("testSettings", () => {
  it("starts from the defaults", () => {
    expect(testSettings()).toEqual(defaultVoiceSettings())
  })

  it("takes another model, and a voice for both languages", () => {
    const settings = testSettings("gpt-realtime-2.1", "cedar")
    expect(settings.active_model).toBe("gpt-realtime-2.1")
    expect(modelSettings(settings, "gpt-realtime-2.1").voices).toEqual({
      ar: "cedar",
      fr: "cedar",
    })
  })
})
