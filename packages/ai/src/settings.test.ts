import { describe, expect, it } from "vitest"
import {
  defaultVoiceSettings,
  fullVoiceSettings,
  greetingProblem,
  MODEL_IDS,
  modelInfo,
  modelSettings,
  readVoiceSettings,
  VoiceSettingsSchema,
} from "./settings.js"

const withModel = (id: (typeof MODEL_IDS)[number], model: object) => ({
  ...defaultVoiceSettings(),
  models: { [id]: model },
})
const accepts = (settings: unknown) =>
  VoiceSettingsSchema.safeParse(settings).success

describe("defaults", () => {
  it("are what calls do today", () => {
    const settings = defaultVoiceSettings()
    expect(settings.active_model).toBe("gemini-3.8-live")
    expect(settings.max_call_seconds).toBe(150)
    expect(settings.style).toEqual({
      ar: { greeting: null, speaking: null, extra_rules: null },
      fr: { greeting: null, speaking: null, extra_rules: null },
    })
    expect(modelSettings(settings, "gemini-3.8-live")).toEqual({
      silence_ms: 600,
      voices: { ar: "Callirrhoe", fr: "Kore" },
      prices: {
        kind: "tokens",
        text_in: 0.75,
        audio_in: 3,
        text_out: 4.5,
        audio_out: 12,
      },
    })
  })

  it.each(MODEL_IDS)("are valid for %s", (id) => {
    expect(
      accepts(withModel(id, modelSettings(defaultVoiceSettings(), id)))
    ).toBe(true)
    const { ar, fr } = modelInfo(id).defaultVoices
    const voices = modelInfo(id).voices.map((voice) => voice.id)
    expect(voices).toContain(ar)
    expect(voices).toContain(fr)
  })

  it("pass the schema", () => {
    expect(accepts(defaultVoiceSettings())).toBe(true)
  })
})

describe("a model's settings", () => {
  it.each([
    ["gemini-3.8-live", { speed: 1 }],
    ["gemini-3.8-live", { reasoning: "low" }],
    ["gpt-live-1", { silence_ms: 600 }],
    ["gpt-realtime-2.1", { backend_model: "gpt-6-luna" }],
  ] as const)("%s refuses what it doesn't take: %o", (id, model) => {
    expect(accepts(withModel(id, model))).toBe(false)
  })

  it("refuses a setting nobody takes", () => {
    expect(accepts(withModel("gemini-3.8-live", { temperature: 1 }))).toBe(
      false
    )
  })

  it.each([
    ["gemini-3.8-live", { silence_ms: 199 }],
    ["gemini-3.8-live", { silence_ms: 2001 }],
    ["gpt-realtime-2.1", { threshold: 1.1 }],
    ["gpt-realtime-2.1", { speed: 0.2 }],
    ["gpt-realtime-2.1", { vad: "push_to_talk" }],
    ["gpt-realtime-2.1-mini", { reasoning: "extreme" }],
    ["gpt-live-1", { backend_model: "gpt-1" }],
  ] as const)("%s refuses a value out of range: %o", (id, model) => {
    expect(accepts(withModel(id, model))).toBe(false)
  })

  it("takes a value in range", () => {
    expect(
      accepts(
        withModel("gpt-realtime-2.1", {
          vad: "semantic_vad",
          eagerness: "high",
          speed: 1.2,
          noise_reduction: "far_field",
        })
      )
    ).toBe(true)
  })

  it("refuses a voice the model doesn't have", () => {
    expect(
      accepts(
        withModel("gemini-3.8-live", { voices: { ar: "marin", fr: "Kore" } })
      )
    ).toBe(false)
  })

  it("refuses prices of another kind than the model's", () => {
    expect(
      accepts(
        withModel("gemini-3.8-live", {
          prices: {
            kind: "minute",
            per_minute: 1,
            backend_text_in: 0,
            backend_cached_text_in: 0,
            backend_text_out: 0,
          },
        })
      )
    ).toBe(false)
  })

  it("keeps defaults for what wasn't set", () => {
    const settings = {
      ...defaultVoiceSettings(),
      models: { "gemini-3.8-live": { silence_ms: 800 } },
    }
    const model = modelSettings(settings, "gemini-3.8-live")
    expect(model.silence_ms).toBe(800)
    expect(model.voices).toEqual({ ar: "Callirrhoe", fr: "Kore" })
  })
})

describe("the rest", () => {
  it.each([59, 601, 90.5])("refuses a longest call of %d s", (seconds) => {
    expect(
      accepts({ ...defaultVoiceSettings(), max_call_seconds: seconds })
    ).toBe(false)
  })

  it("refuses an unknown active model", () => {
    expect(accepts({ ...defaultVoiceSettings(), active_model: "gpt-9" })).toBe(
      false
    )
  })

  it.each(["Bonjour", "Bonjour {name} {name}", "Bonjour {name} {store}", "{}"])(
    "refuses the greeting %s",
    (greeting) => {
      expect(greetingProblem(greeting)).not.toBeNull()
      const settings = defaultVoiceSettings()
      settings.style.fr.greeting = greeting
      expect(accepts(settings)).toBe(false)
    }
  )

  it("takes a greeting with the name once", () => {
    expect(greetingProblem("Bonjour {name} !")).toBeNull()
    const settings = defaultVoiceSettings()
    settings.style.fr.greeting = "Bonjour {name} !"
    expect(accepts(settings)).toBe(true)
  })

  it("fills in every model for a form", () => {
    const settings = {
      ...defaultVoiceSettings(),
      models: { "gpt-realtime-2.1": { speed: 1.25 } },
    }
    const full = fullVoiceSettings(settings)
    expect(Object.keys(full.models).sort()).toEqual([...MODEL_IDS].sort())
    expect(full.models["gpt-realtime-2.1"]).toMatchObject({
      speed: 1.25,
      threshold: 0.5,
    })
  })

  it("reads a row that doesn't fit as the defaults", () => {
    expect(readVoiceSettings({ active_model: "gpt-9" })).toEqual(
      defaultVoiceSettings()
    )
    expect(readVoiceSettings(null)).toEqual(defaultVoiceSettings())
  })
})
