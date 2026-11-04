import {
  type CallLanguage,
  connectGeminiLive,
  connectGptLive,
  connectOpenAIRealtime,
  defaultVoiceSettings,
  MODEL_IDS,
  modelInfo,
  type ModelId,
  modelSettings,
  PROVIDER_KEY,
  type ToolDeclaration,
  type VoiceSession,
  type VoiceSettings,
  VoiceSettingsSchema,
} from "@nexus/ai"
import type { Db } from "@nexus/db"

export type VoiceKeys = { gemini: string; openai?: string }

export type SessionOptions = {
  instruction: string
  tools: ToolDeclaration[]
  onClose: (reason: string) => void
}

type Log = (line: string) => void

/**
 * An account's voice settings, read for each call so a save applies to the
 * next one. Calls don't stop over a row that can't be read: they use the
 * defaults.
 */
export async function readAccountSettings(
  db: Db,
  accountId: string,
  log: (line: string) => void
): Promise<VoiceSettings> {
  try {
    const row = await db
      .selectFrom("voice_settings")
      .select("settings")
      .where("account_id", "=", accountId)
      .executeTakeFirst()
    if (!row) {
      return defaultVoiceSettings()
    }
    const parsed = VoiceSettingsSchema.safeParse(row.settings)
    if (parsed.success) {
      return parsed.data
    }
    log(`Voice settings of ${accountId} don't fit; using the defaults`)
  } catch (error) {
    log(`Voice settings of ${accountId}: ${String(error)}; using the defaults`)
  }
  return defaultVoiceSettings()
}

/**
 * The settings a call can run with: a model whose key has gone gives way to the
 * default one, whose key the app can't start without. The cost is then recorded
 * for the model that ran.
 */
export function runnableSettings(
  settings: VoiceSettings,
  keys: VoiceKeys,
  log: (line: string) => void
): VoiceSettings {
  const provider = modelInfo(settings.active_model).provider
  if (PROVIDER_KEY[provider] === "openai" && !keys.openai) {
    const { active_model } = defaultVoiceSettings()
    log(`${settings.active_model} has no API key; calling with ${active_model}`)
    return { ...settings, active_model }
  }
  return settings
}

/** The API keys a test tool runs with, from its environment. */
export function testKeys(): VoiceKeys {
  const gemini = process.env.GEMINI_API_KEY
  if (!gemini) {
    throw new Error("Set GEMINI_API_KEY")
  }
  return { gemini, openai: process.env.OPENAI_API_KEY || undefined }
}

/** Takes `--model <id>` out of a test tool's arguments. */
export function modelArgument(args: string[]): {
  model?: ModelId
  rest: string[]
} {
  const at = args.indexOf("--model")
  if (at === -1) {
    return { rest: args }
  }
  const model = args[at + 1] as ModelId
  if (!MODEL_IDS.includes(model)) {
    throw new Error(`--model is one of ${MODEL_IDS.join(", ")}`)
  }
  return { model, rest: args.filter((_, i) => i !== at && i !== at + 1) }
}

/**
 * GPT-Live takes no typed customer, so a tool that plays one as text can't test
 * it: it needs a phone call.
 */
export function refuseWithoutText(model?: ModelId) {
  if (model && modelInfo(model).provider === "openai-live") {
    throw new Error(`${model} takes no typed customer; test it with demo.ts`)
  }
}

/** The default settings with another model, or voice, for a test run. */
export function testSettings(model?: ModelId, voice?: string): VoiceSettings {
  const settings = defaultVoiceSettings()
  const id = model ?? settings.active_model
  return {
    ...settings,
    active_model: id,
    models: voice
      ? { ...settings.models, [id]: { voices: { ar: voice, fr: voice } } }
      : settings.models,
  }
}

function openaiKey(keys: VoiceKeys): string {
  if (!keys.openai) {
    throw new Error("Set OPENAI_API_KEY")
  }
  return keys.openai
}

/** What a call takes from the settings. */
export function callOptions(
  settings: VoiceSettings,
  language: CallLanguage,
  keys: VoiceKeys,
  log: Log
) {
  return {
    style: settings.style[language],
    maxCallSeconds: settings.max_call_seconds,
    // A session billed by the minute costs money from the moment it connects,
    // and nobody pays for a call that isn't answered.
    connectWhenAnswered:
      modelInfo(settings.active_model).defaultPrices.kind === "minute",
    connect: (options: SessionOptions) =>
      connectFor(settings, language, keys, options, log),
  }
}

/** Connects the session of the settings' active model. */
export async function connectFor(
  settings: VoiceSettings,
  language: CallLanguage,
  keys: VoiceKeys,
  options: SessionOptions,
  log?: Log
): Promise<VoiceSession> {
  const id = settings.active_model
  const model = modelSettings(settings, id)
  const voice = model.voices[language]
  const provider = modelInfo(id).provider
  switch (provider) {
    case "gemini":
      return connectGeminiLive({
        apiKey: keys.gemini,
        model: id,
        voice,
        silenceMs: model.silence_ms,
        ...options,
      })
    case "openai-realtime":
      return connectOpenAIRealtime({
        apiKey: openaiKey(keys),
        model: id,
        voice,
        settings: model,
        log,
        ...options,
      })
    case "openai-live":
      return connectGptLive({
        apiKey: openaiKey(keys),
        voice,
        backendModel: String(model.backend_model),
        log,
        ...options,
      })
  }
}
