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
  callOptions,
  connectFor,
  modelArgument,
  readAccountSettings,
  refuseWithoutText,
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

describe("callOptions", () => {
  const settings = (model: "gemini-3.8-live" | "gpt-live-1") => ({
    ...defaultVoiceSettings(),
    active_model: model,
    max_call_seconds: 90,
  })

  it("carries the longest call and the language's style", () => {
    const withStyle = settings("gemini-3.8-live")
    withStyle.style.fr.greeting = "Salut {name}"
    const options = callOptions(withStyle, "fr", { gemini: "a" }, () => {})
    expect(options.maxCallSeconds).toBe(90)
    expect(options.style.greeting).toBe("Salut {name}")
  })

  it("connects while it rings, except when the model bills by the minute", () => {
    const keys = { gemini: "a", openai: "b" }
    const when = (model: "gemini-3.8-live" | "gpt-live-1") =>
      callOptions(settings(model), "ar", keys, () => {}).connectWhenAnswered
    expect(when("gemini-3.8-live")).toBe(false)
    expect(when("gpt-live-1")).toBe(true)
  })
})

describe("connectFor", () => {
  it("refuses OpenAI's models without their key, as a failed connection", async () => {
    await expect(
      connectFor(
        testSettings("gpt-realtime-2.1"),
        "ar",
        { gemini: "a" },
        { instruction: "", tools: [], onClose: () => {} }
      )
    ).rejects.toThrow("OPENAI_API_KEY")
  })
})

describe("modelArgument", () => {
  it("leaves arguments without a model alone", () => {
    expect(modelArgument(["a", "b"])).toEqual({ rest: ["a", "b"] })
  })

  it("takes the model out, wherever it is", () => {
    expect(modelArgument(["a", "--model", "gpt-live-1", "b"])).toEqual({
      model: "gpt-live-1",
      rest: ["a", "b"],
    })
  })

  it.each([[["--model"]], [["--model", "gpt-9"]]])("refuses %o", (args) => {
    expect(() => modelArgument(args)).toThrow("--model is one of")
  })
})

describe("refuseWithoutText", () => {
  it("refuses GPT-Live alone", () => {
    expect(() => refuseWithoutText("gpt-live-1")).toThrow("demo.ts")
    expect(() => refuseWithoutText("gpt-realtime-2.1")).not.toThrow()
    expect(() => refuseWithoutText()).not.toThrow()
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
