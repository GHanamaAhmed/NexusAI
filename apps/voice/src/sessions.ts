import {
  type CallLanguage,
  connectGeminiLive,
  defaultVoiceSettings,
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

/** Connects the session of the settings' active model. */
export function connectFor(
  settings: VoiceSettings,
  language: CallLanguage,
  keys: VoiceKeys,
  options: SessionOptions
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
    case "openai-live":
      throw new Error(`${provider} isn't connected yet`)
  }
}
