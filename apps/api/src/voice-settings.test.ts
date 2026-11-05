import { defaultVoiceSettings } from "@nexus/ai/settings"
import { parseCallWindow } from "@nexus/core"
import type { Db } from "@nexus/db"
import { createTestDb, resetTestDb } from "@nexus/db/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { buildApp } from "./app.js"
import { createAccount, createApiKey } from "./keys.js"

describe("Voice settings", () => {
  let db: Db
  let app: Awaited<ReturnType<typeof buildApp>>
  let withOpenai: Awaited<ReturnType<typeof buildApp>>
  let key: string
  let otherKey: string

  const build = (voiceProviders?: string[]) =>
    buildApp({
      db,
      callWindow: parseCallWindow("09:00-20:00"),
      allowHttpCallbacks: false,
      voiceProviders,
    })

  beforeAll(async () => {
    db = await createTestDb()
    app = await build()
    withOpenai = await build(["openai"])
  })

  beforeEach(async () => {
    await resetTestDb(db)
    key = await createApiKey(db, (await createAccount(db, "One")).id)
    otherKey = await createApiKey(db, (await createAccount(db, "Two")).id)
  })

  afterAll(async () => {
    await app.close()
    await withOpenai.close()
    await db.destroy()
  })

  const auth = (apiKey: string) => ({ authorization: `Bearer ${apiKey}` })
  const read = (apiKey = key) =>
    app.inject({ url: "/v1/voice/settings", headers: auth(apiKey) })
  const save = (
    settings: unknown,
    version: number,
    apiKey = key,
    target = app
  ) =>
    target.inject({
      method: "PUT",
      url: "/v1/voice/settings",
      headers: auth(apiKey),
      payload: { settings, version } as object,
    })
  const preview = (payload: object) =>
    app.inject({
      method: "POST",
      url: "/v1/voice/preview",
      headers: auth(key),
      payload,
    })
  const longer = {
    ...defaultVoiceSettings(),
    max_call_seconds: 300,
  }

  it("refuses every route without a key", async () => {
    for (const [method, url] of [
      ["GET", "/v1/voice/models"],
      ["GET", "/v1/voice/settings"],
      ["PUT", "/v1/voice/settings"],
      ["POST", "/v1/voice/preview"],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} })
      expect(response.statusCode).toBe(401)
    }
  })

  describe("models", () => {
    const list = async (target = app) => {
      const response = await target.inject({
        url: "/v1/voice/models",
        headers: auth(key),
      })
      return response.json().models as { id: string; available: boolean }[]
    }

    it("marks OpenAI's as unavailable without their key", async () => {
      expect(
        Object.fromEntries(
          (await list()).map((model) => [model.id, model.available])
        )
      ).toEqual({
        "gemini-3.8-live": true,
        "gpt-realtime-2.1": false,
        "gpt-realtime-2.1-mini": false,
        "gpt-live-1": false,
      })
    })

    it("marks them as available with it", async () => {
      expect((await list(withOpenai)).every((m) => m.available)).toBe(true)
    })
  })

  describe("settings", () => {
    it("are the defaults at version 0 until saved", async () => {
      const body = (await read()).json()
      expect(body.version).toBe(0)
      expect(body.settings.active_model).toBe("gemini-3.8-live")
      expect(body.settings.models["gemini-3.8-live"].voices).toEqual({
        ar: "Callirrhoe",
        fr: "Kore",
      })
      expect(Object.keys(body.settings.models)).toHaveLength(4)
      expect(body.defaults.greeting.fr).toContain("{name}")
      expect(body.defaults.speaking.ar).toContain("Darija")
      // The platform's hours until the account saves its own.
      expect(body.settings.call_hours).toEqual({
        opens: "09:00",
        closes: "20:00",
      })
    })

    it("save call hours, and refuse hours that close before they open", async () => {
      const hours = { opens: "08:00", closes: "23:30" }
      expect((await save({ ...longer, call_hours: hours }, 0)).statusCode).toBe(
        200
      )
      expect((await read()).json().settings.call_hours).toEqual(hours)
      const backwards = await save(
        { ...longer, call_hours: { opens: "22:00", closes: "08:00" } },
        1
      )
      expect(backwards.statusCode).toBe(400)
      expect(backwards.json().code).toBe("invalid_settings")
    })

    it("save, moving the version on", async () => {
      const first = await save(longer, 0)
      expect(first.statusCode).toBe(200)
      expect(first.json().version).toBe(1)
      expect((await read()).json()).toMatchObject({
        version: 1,
        settings: { max_call_seconds: 300 },
      })

      const second = await save({ ...longer, max_call_seconds: 90 }, 1)
      expect(second.json().version).toBe(2)
      expect((await read()).json()).toMatchObject({
        version: 2,
        settings: { max_call_seconds: 90 },
      })
    })

    it("refuse a stale version, and keep what's saved", async () => {
      await save(longer, 0)
      await save({ ...longer, max_call_seconds: 90 }, 1)

      const stale = await save({ ...longer, max_call_seconds: 120 }, 1)
      expect(stale.statusCode).toBe(409)
      expect(stale.json().code).toBe("version_conflict")

      const firstAgain = await save({ ...longer, max_call_seconds: 120 }, 0)
      expect(firstAgain.statusCode).toBe(409)
      expect((await read()).json().settings.max_call_seconds).toBe(90)
    })

    it("refuse what a model doesn't take, naming the problem", async () => {
      const response = await save(
        { ...longer, models: { "gemini-3.8-live": { speed: 1 } } },
        0
      )
      expect(response.statusCode).toBe(400)
      const body = response.json()
      expect(body.code).toBe("invalid_settings")
      expect(body.problems[0].message).toContain("speed")
    })

    it("refuse a model whose key isn't set", async () => {
      const settings = { ...longer, active_model: "gpt-realtime-2.1" }
      const response = await save(settings, 0)
      expect(response.statusCode).toBe(400)
      expect(response.json().code).toBe("model_unavailable")
      expect((await read()).json().version).toBe(0)

      const allowed = await save(settings, 0, key, withOpenai)
      expect(allowed.statusCode).toBe(200)
    })

    it("belong to one account", async () => {
      await save(longer, 0)
      expect((await read(otherKey)).json()).toMatchObject({
        version: 0,
        settings: { max_call_seconds: 150 },
      })

      // Its version 1 is its own row: the other account's stays as it was.
      const theirs = await save(
        { ...longer, max_call_seconds: 60 },
        1,
        otherKey
      )
      expect(theirs.statusCode).toBe(409)
      expect((await read()).json().settings.max_call_seconds).toBe(300)

      await save({ ...longer, max_call_seconds: 60 }, 0, otherKey)
      expect((await read()).json().settings.max_call_seconds).toBe(300)
      expect((await read(otherKey)).json().settings.max_call_seconds).toBe(60)
    })
  })

  describe("preview", () => {
    it("has the default greeting with the name", async () => {
      const { instruction } = (await preview({ language: "fr" })).json()
      expect(instruction).toContain("Bonjour, je suis bien avec Sara ?")
    })

    it("uses the style it's given", async () => {
      const { instruction } = (
        await preview({
          language: "ar",
          style: {
            greeting: "مرحبا {name}",
            speaking: "Speak slowly.",
            extra_rules: "Never mention the weather.",
          },
        })
      ).json()
      expect(instruction).toContain("مرحبا سارة")
      expect(instruction).toContain("Speak slowly.")
      expect(instruction).toContain("Never mention the weather.")
    })

    it("uses the saved style when given none", async () => {
      const settings = defaultVoiceSettings()
      settings.style.fr.greeting = "Salut {name}"
      await save(settings, 0)
      const { instruction } = (await preview({ language: "fr" })).json()
      expect(instruction).toContain("Salut Sara")
    })

    it("refuses a greeting without the name", async () => {
      const response = await preview({
        language: "fr",
        style: { greeting: "Salut", speaking: null, extra_rules: null },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().code).toBe("invalid_preview")
    })
  })
})
