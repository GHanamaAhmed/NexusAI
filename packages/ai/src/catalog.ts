/**
 * The voice models NexusAI can run, as data: what each one takes, for checking
 * settings and for building a form from.
 */
export const MODEL_IDS = [
  "gemini-3.8-live",
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-live-1",
] as const

export type ModelId = (typeof MODEL_IDS)[number]

export type Provider = "gemini" | "openai-realtime" | "openai-live"

/** Whose API key a provider needs. */
export const PROVIDER_KEY: Record<Provider, "gemini" | "openai"> = {
  gemini: "gemini",
  "openai-realtime": "openai",
  "openai-live": "openai",
}

export type VoiceOption = {
  id: string
  /** The language the provider built it for, when it says. */
  language?: string
  gender?: "f" | "m"
}

/** US dollars per million tokens. A missing cached price counts as the full one. */
export type TokenPrices = {
  kind: "tokens"
  text_in: number
  cached_text_in?: number
  audio_in: number
  cached_audio_in?: number
  text_out: number
  audio_out: number
}

/**
 * US dollars per minute of connected session, and per million tokens of the
 * backend model that runs its functions.
 */
export type MinutePrices = {
  kind: "minute"
  per_minute: number
  backend_text_in: number
  backend_cached_text_in: number
  backend_text_out: number
}

export type Prices = TokenPrices | MinutePrices

export type ParameterKey =
  | "silence_ms"
  | "vad"
  | "threshold"
  | "prefix_padding_ms"
  | "eagerness"
  | "reasoning"
  | "speed"
  | "noise_reduction"
  | "backend_model"

export type ParameterValue = number | string

/** One setting a model takes, with its range, for checking it and for a form. */
export type ParameterSpec = {
  key: ParameterKey
  /** It applies only while another setting has this value. */
  when?: { key: ParameterKey; is: string }
} & (
  | {
      kind: "number"
      min: number
      max: number
      step: number
      default: number
      unit?: "ms"
    }
  | { kind: "choice"; options: readonly string[]; default: string }
)

export type ModelInfo = {
  id: ModelId
  provider: Provider
  voices: readonly VoiceOption[]
  /** The voices calls start with until an admin changes them. */
  defaultVoices: { ar: string; fr: string }
  parameters: readonly ParameterSpec[]
  defaultPrices: Prices
}

const SILENCE: ParameterSpec = {
  key: "silence_ms",
  kind: "number",
  min: 200,
  max: 2000,
  step: 50,
  default: 600,
  unit: "ms",
}

/** Gemini's prebuilt voices. */
const GEMINI_VOICES: VoiceOption[] = [
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Puck",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi",
].map((id) => ({ id }))

const REALTIME_VOICES: VoiceOption[] = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
].map((id) => ({ id }))

/** OpenAI's Realtime session settings, the same for both models. */
const REALTIME_PARAMETERS: ParameterSpec[] = [
  {
    key: "vad",
    kind: "choice",
    options: ["server_vad", "semantic_vad"],
    default: "server_vad",
  },
  { ...SILENCE, when: { key: "vad", is: "server_vad" } },
  {
    key: "threshold",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    when: { key: "vad", is: "server_vad" },
  },
  {
    key: "prefix_padding_ms",
    kind: "number",
    min: 0,
    max: 1000,
    step: 50,
    default: 300,
    unit: "ms",
    when: { key: "vad", is: "server_vad" },
  },
  {
    key: "eagerness",
    kind: "choice",
    options: ["low", "medium", "high", "auto"],
    default: "auto",
    when: { key: "vad", is: "semantic_vad" },
  },
  {
    key: "reasoning",
    kind: "choice",
    options: ["minimal", "low", "medium", "high"],
    default: "low",
  },
  { key: "speed", kind: "number", min: 0.25, max: 1.5, step: 0.05, default: 1 },
  {
    key: "noise_reduction",
    kind: "choice",
    options: ["off", "near_field", "far_field"],
    default: "off",
  },
]

export const MODELS: readonly ModelInfo[] = [
  {
    id: "gemini-3.8-live",
    provider: "gemini",
    voices: GEMINI_VOICES,
    defaultVoices: { ar: "Callirrhoe", fr: "Kore" },
    parameters: [SILENCE],
    // https://ai.google.dev/gemini-api/docs/pricing, November 2026.
    defaultPrices: {
      kind: "tokens",
      text_in: 0.75,
      audio_in: 3,
      text_out: 4.5,
      audio_out: 12,
    },
  },
  {
    id: "gpt-realtime-2.1",
    provider: "openai-realtime",
    voices: REALTIME_VOICES,
    defaultVoices: { ar: "marin", fr: "marin" },
    parameters: REALTIME_PARAMETERS,
    // https://developers.openai.com/api/docs/pricing, November 2026.
    defaultPrices: {
      kind: "tokens",
      text_in: 4,
      cached_text_in: 0.4,
      audio_in: 32,
      cached_audio_in: 0.4,
      text_out: 24,
      audio_out: 64,
    },
  },
  {
    id: "gpt-realtime-2.1-mini",
    provider: "openai-realtime",
    voices: REALTIME_VOICES,
    defaultVoices: { ar: "marin", fr: "marin" },
    parameters: REALTIME_PARAMETERS,
    defaultPrices: {
      kind: "tokens",
      text_in: 0.6,
      cached_text_in: 0.06,
      audio_in: 10,
      cached_audio_in: 0.3,
      text_out: 2.4,
      audio_out: 20,
    },
  },
  {
    id: "gpt-live-1",
    provider: "openai-live",
    // No Arabic voice. Those with no language listed aren't tied to one.
    voices: [
      { id: "alloy" },
      { id: "ash" },
      { id: "ballad" },
      { id: "beacon", language: "en", gender: "m" },
      { id: "bossa", language: "pt", gender: "f" },
      { id: "brise", language: "fr", gender: "f" },
      { id: "cedar" },
      { id: "cinder", language: "en", gender: "m" },
      { id: "coral" },
      { id: "delta", language: "en", gender: "f" },
      { id: "echo" },
      { id: "flitz", language: "de", gender: "m" },
      { id: "gleam", language: "en", gender: "f" },
      { id: "harema", language: "ja", gender: "f" },
      { id: "juni", language: "de", gender: "f" },
      { id: "marin" },
      { id: "meridian", language: "en", gender: "m" },
      { id: "nira", language: "hi", gender: "f" },
      { id: "noeul", language: "ko", gender: "f" },
      { id: "nuri", language: "de", gender: "f" },
      { id: "quartz", language: "en", gender: "f" },
      { id: "ripple", language: "en", gender: "m" },
      { id: "sage" },
      { id: "shida", language: "ja", gender: "m" },
      { id: "shimmer" },
      { id: "sillage", language: "fr", gender: "m" },
      { id: "stone", language: "en", gender: "m" },
      { id: "tempo", language: "pt", gender: "m" },
      { id: "verse" },
      { id: "vesper", language: "en", gender: "m" },
      { id: "willow", language: "en", gender: "f" },
    ],
    defaultVoices: { ar: "marin", fr: "brise" },
    // The session takes no turn timing, speed or noise setting. Its functions
    // can only run through a backend model.
    parameters: [
      {
        key: "backend_model",
        kind: "choice",
        options: ["gpt-6-luna", "gpt-6-sol"],
        default: "gpt-6-luna",
      },
    ],
    // https://developers.openai.com/api/docs/models/gpt-6-luna, November 2026.
    defaultPrices: {
      kind: "minute",
      per_minute: 0.05,
      backend_text_in: 0.1,
      backend_cached_text_in: 0.01,
      backend_text_out: 0.5,
    },
  },
]

export function modelInfo(id: ModelId): ModelInfo {
  const info = MODELS.find((model) => model.id === id)
  if (!info) {
    throw new Error(`No model named ${id}`)
  }
  return info
}
