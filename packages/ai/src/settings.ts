import { z } from "zod"
import {
  MODEL_IDS,
  type ModelId,
  modelInfo,
  MODELS,
  type ParameterKey,
  type ParameterValue,
  type Prices,
} from "./catalog.js"

export * from "./catalog.js"

export type CallLanguage = "ar" | "fr"

const price = z.number().min(0).max(10_000)

const PricesSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tokens"),
      text_in: price,
      cached_text_in: price.optional(),
      audio_in: price,
      cached_audio_in: price.optional(),
      text_out: price,
      audio_out: price,
    })
    .strict(),
  z
    .object({
      kind: z.literal("minute"),
      per_minute: price,
      backend_text_in: price,
      backend_cached_text_in: price,
      backend_text_out: price,
    })
    .strict(),
])

const ModelSettingsSchema = z
  .object({
    voices: z
      .object({ ar: z.string().min(1), fr: z.string().min(1) })
      .strict()
      .optional(),
    silence_ms: z.number().int().optional(),
    vad: z.string().optional(),
    threshold: z.number().optional(),
    prefix_padding_ms: z.number().int().optional(),
    eagerness: z.string().optional(),
    reasoning: z.string().optional(),
    speed: z.number().optional(),
    noise_reduction: z.string().optional(),
    backend_model: z.string().optional(),
    prices: PricesSchema.optional(),
  })
  .strict()

export type ModelSettings = z.infer<typeof ModelSettingsSchema>

/** The parts of the instruction an admin may change; null is today's text. */
export const StyleSchema = z
  .object({
    greeting: z.string().trim().min(1).max(200).nullable(),
    speaking: z.string().trim().min(1).max(4000).nullable(),
    extra_rules: z.string().trim().min(1).max(2000).nullable(),
  })
  .strict()

export type VoiceStyle = z.infer<typeof StyleSchema>

export const NAME_PLACEHOLDER = "{name}"

/** Why a greeting can't be used, or null: {name} once, and no other placeholder. */
export function greetingProblem(greeting: string): string | null {
  const placeholders = greeting.match(/\{[^}]*\}/g) ?? []
  return placeholders.length === 1 && placeholders[0] === NAME_PLACEHOLDER
    ? null
    : `The greeting must contain ${NAME_PLACEHOLDER} once, and no other placeholder`
}

/** Whether a setting's value is one the model takes, as its catalogue entry says. */
function checkModel(id: ModelId, settings: ModelSettings): string[] {
  const info = modelInfo(id)
  const problems: string[] = []
  for (const [key, value] of Object.entries(settings)) {
    if (key === "voices" || key === "prices" || value === undefined) {
      continue
    }
    const spec = info.parameters.find((parameter) => parameter.key === key)
    if (!spec) {
      problems.push(`${id} doesn't take ${key}`)
    } else if (spec.kind === "number") {
      if (typeof value !== "number" || value < spec.min || value > spec.max) {
        problems.push(`${key} must be from ${spec.min} to ${spec.max}`)
      }
    } else if (!spec.options.includes(String(value))) {
      problems.push(`${key} must be one of ${spec.options.join(", ")}`)
    }
  }
  for (const language of ["ar", "fr"] as const) {
    const voice = settings.voices?.[language]
    if (voice && !info.voices.some((option) => option.id === voice)) {
      problems.push(`${id} has no voice named ${voice}`)
    }
  }
  if (settings.prices && settings.prices.kind !== info.defaultPrices.kind) {
    problems.push(`${id} is priced by ${info.defaultPrices.kind}`)
  }
  return problems
}

export const VoiceSettingsSchema = z
  .object({
    active_model: z.enum(MODEL_IDS),
    models: z.partialRecord(z.enum(MODEL_IDS), ModelSettingsSchema),
    style: z.object({ ar: StyleSchema, fr: StyleSchema }).strict(),
    max_call_seconds: z.number().int().min(60).max(600),
  })
  .strict()
  .superRefine((settings, context) => {
    for (const [id, model] of Object.entries(settings.models)) {
      for (const message of checkModel(id as ModelId, model)) {
        context.addIssue({ code: "custom", path: ["models", id], message })
      }
    }
    for (const language of ["ar", "fr"] as const) {
      const { greeting } = settings.style[language]
      const problem = greeting && greetingProblem(greeting)
      if (problem) {
        context.addIssue({
          code: "custom",
          path: ["style", language, "greeting"],
          message: problem,
        })
      }
    }
  })

export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>

const NO_STYLE: VoiceStyle = {
  greeting: null,
  speaking: null,
  extra_rules: null,
}

/** A model's settings as they start: each parameter's default, its voices and prices. */
export function defaultModelSettings(id: ModelId): ModelSettings {
  const info = modelInfo(id)
  const values: Partial<Record<ParameterKey, ParameterValue>> = {}
  for (const parameter of info.parameters) {
    values[parameter.key] = parameter.default
  }
  return {
    ...values,
    voices: { ...info.defaultVoices },
    prices: { ...info.defaultPrices },
  } as ModelSettings
}

/** What calls do until an admin saves: today's model, voices, text and prices. */
export function defaultVoiceSettings(): VoiceSettings {
  return {
    active_model: "gemini-3.8-live",
    models: Object.fromEntries(
      MODELS.map((model) => [model.id, defaultModelSettings(model.id)])
    ),
    style: { ar: { ...NO_STYLE }, fr: { ...NO_STYLE } },
    max_call_seconds: 150,
  }
}

/** A model's settings over its defaults. */
export function modelSettings(
  settings: VoiceSettings,
  id: ModelId
): ModelSettings & {
  voices: { ar: string; fr: string }
  prices: Prices
} {
  const merged = { ...defaultModelSettings(id), ...settings.models[id] }
  return merged as ModelSettings & {
    voices: { ar: string; fr: string }
    prices: Prices
  }
}

/** Settings with every model filled in, for a form to show. */
export function fullVoiceSettings(settings: VoiceSettings): VoiceSettings {
  return {
    ...settings,
    models: Object.fromEntries(
      MODELS.map((model) => [model.id, modelSettings(settings, model.id)])
    ),
  }
}

/**
 * A stored row as settings. A row an older or newer version wrote that doesn't
 * fit reads as the defaults, so calls don't stop over it.
 */
export function readVoiceSettings(value: unknown): VoiceSettings {
  const parsed = VoiceSettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultVoiceSettings()
}
