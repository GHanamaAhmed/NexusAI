import { describe, expect, it } from "vitest"
import { callCost } from "./cost.js"

describe("callCost", () => {
  it("prices each kind of token", () => {
    expect(
      callCost({
        promptTokens: 20_000,
        responseTokens: 650,
        promptAudioTokens: 8_000,
        cachedTokens: 1_000,
        responseAudioTokens: 650,
      })
    ).toEqual({
      prompt_text_tokens: 12_000,
      prompt_audio_tokens: 8_000,
      cached_tokens: 1_000,
      response_text_tokens: 0,
      response_audio_tokens: 650,
      usd: 0.0408,
    })
  })
})
