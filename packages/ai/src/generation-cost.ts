import {
  type ImageModelId,
  imageModel,
  type TextModelId,
  textModel,
} from "./generation-catalog.js"
import type { TextUsage } from "./meta/text.js"

const MILLION = 1_000_000

export type GenerationCost = {
  usd: number
  text_model: TextModelId
  image_model: ImageModelId
  input_tokens: number
  cached_tokens: number
  output_tokens: number
  images: number
}

/**
 * What a generation cost at the catalogue's prices: every text request it made,
 * a retry included, and the images. Cached tokens count at their own price.
 */
export function generationCost(input: {
  usage: readonly TextUsage[]
  textModel: TextModelId
  images: number
  imageModel: ImageModelId
}): GenerationCost {
  const prices = textModel(input.textModel).prices
  const total = input.usage.reduce(
    (sum, usage) => ({
      input: sum.input + usage.input,
      cached: sum.cached + Math.min(usage.cached, usage.input),
      output: sum.output + usage.output,
    }),
    { input: 0, cached: 0, output: 0 }
  )
  const dollars =
    ((total.input - total.cached) * prices.text_in +
      total.cached * prices.cached_in +
      total.output * prices.text_out) /
      MILLION +
    input.images * imageModel(input.imageModel).perImage
  return {
    usd: Math.round(dollars * 100_000) / 100_000,
    text_model: input.textModel,
    image_model: input.imageModel,
    input_tokens: total.input,
    cached_tokens: total.cached,
    output_tokens: total.output,
    images: input.images,
  }
}
