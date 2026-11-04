import { describe, expect, it } from "vitest"
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
  IMAGE_MODELS,
  imageModel,
  TEXT_MODELS,
  textModel,
} from "./generation-catalog.js"
import { generationCost } from "./generation-cost.js"

describe("the generation catalogue", () => {
  it("has its default models", () => {
    expect(textModel(DEFAULT_TEXT_MODEL).provider).toBe("meta")
    expect(imageModel(DEFAULT_IMAGE_MODEL).provider).toBe("meta")
  })

  it("starts each text model at a reasoning level it takes", () => {
    for (const model of TEXT_MODELS) {
      expect(model.reasoning).toContain(model.defaultReasoning)
    }
  })

  it("asks for a wide and a tall image", () => {
    for (const model of IMAGE_MODELS) {
      const [w, h] = model.sizes.wide.split("x").map(Number)
      const [tw, th] = model.sizes.tall.split("x").map(Number)
      expect(w! / h!).toBeGreaterThan(1)
      expect(tw! / th!).toBeLessThan(1)
    }
  })
})

describe("generationCost", () => {
  it("prices tokens, cached tokens and images", () => {
    expect(
      generationCost({
        usage: [{ input: 21_000, cached: 3_000, output: 9_000 }],
        textModel: "muse-wonder-1.0",
        images: 4,
        imageModel: "muse-image-1.0",
      })
    ).toEqual({
      // 18,000 at $4, 3,000 at $0.20, 9,000 at $20 per million, 4 at $0.01.
      usd: 0.2926,
      text_model: "muse-wonder-1.0",
      image_model: "muse-image-1.0",
      input_tokens: 21_000,
      cached_tokens: 3_000,
      output_tokens: 9_000,
      images: 4,
    })
  })

  it("adds up every request, a retry included", () => {
    const cost = generationCost({
      usage: [
        { input: 10_000, cached: 0, output: 5_000 },
        { input: 12_000, cached: 10_000, output: 4_000 },
      ],
      textModel: "muse-wonder-1.0",
      images: 0,
      imageModel: "muse-image-1.0",
    })
    expect(cost).toMatchObject({
      input_tokens: 22_000,
      cached_tokens: 10_000,
      output_tokens: 9_000,
    })
    expect(cost.usd).toBeCloseTo(
      (12_000 * 4 + 10_000 * 0.2 + 9_000 * 20) / 1e6,
      5
    )
  })

  it("never counts more cached tokens than were sent", () => {
    const cost = generationCost({
      usage: [{ input: 100, cached: 500, output: 0 }],
      textModel: "muse-wonder-1.0",
      images: 0,
      imageModel: "muse-image-1.0",
    })
    expect(cost.cached_tokens).toBe(100)
    expect(cost.usd).toBeCloseTo((100 * 0.2) / 1e6, 8)
  })
})
