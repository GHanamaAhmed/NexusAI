/**
 * The models NexusAI can design with, as data: what each costs and takes, so
 * more can be added without changing the code that runs them.
 */
export const TEXT_MODEL_IDS = ["muse-wonder-1.0"] as const
export const IMAGE_MODEL_IDS = ["muse-image-1.0"] as const

export type TextModelId = (typeof TEXT_MODEL_IDS)[number]
export type ImageModelId = (typeof IMAGE_MODEL_IDS)[number]

export type GenerationProvider = "meta"

export type ReasoningEffort =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type TextModel = {
  id: TextModelId
  provider: GenerationProvider
  /** US dollars per million tokens; reasoning is billed as output. */
  prices: { text_in: number; cached_in: number; text_out: number }
  reasoning: readonly ReasoningEffort[]
  defaultReasoning: ReasoningEffort
  /** Images one request may carry. */
  maxImages: number
}

export type ImageShape = "wide" | "tall"

export type ImageModel = {
  id: ImageModelId
  provider: GenerationProvider
  /** US dollars per image, whatever its size. */
  perImage: number
  /** The size asked for each shape; it sets the aspect ratio. */
  sizes: Record<ImageShape, string>
}

export const TEXT_MODELS: readonly TextModel[] = [
  {
    id: "muse-wonder-1.0",
    provider: "meta",
    // https://dev.meta.ai/docs/pricing-rate-limits, November 2026.
    prices: { text_in: 4, cached_in: 0.2, text_out: 20 },
    reasoning: ["minimal", "low", "medium", "high", "xhigh", "max"],
    defaultReasoning: "low",
    maxImages: 50,
  },
]

export const IMAGE_MODELS: readonly ImageModel[] = [
  {
    id: "muse-image-1.0",
    provider: "meta",
    perImage: 0.01,
    // A banner across the page, and one for a phone held upright.
    sizes: { wide: "1792x1024", tall: "1024x1280" },
  },
]

/** The models a generation uses until an account chooses others. */
export const DEFAULT_TEXT_MODEL: TextModelId = "muse-wonder-1.0"
export const DEFAULT_IMAGE_MODEL: ImageModelId = "muse-image-1.0"

/** Whose API key each provider needs. */
export const GENERATION_PROVIDER_KEY: Record<GenerationProvider, string> = {
  meta: "META_API_KEY",
}

export function textModel(id: TextModelId): TextModel {
  const model = TEXT_MODELS.find((candidate) => candidate.id === id)
  if (!model) {
    throw new Error(`No text model named ${id}`)
  }
  return model
}

export function imageModel(id: ImageModelId): ImageModel {
  const model = IMAGE_MODELS.find((candidate) => candidate.id === id)
  if (!model) {
    throw new Error(`No image model named ${id}`)
  }
  return model
}
