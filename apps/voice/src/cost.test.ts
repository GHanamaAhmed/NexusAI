import { modelInfo } from "@nexus/ai"
import { describe, expect, it } from "vitest"
import { callCost } from "./cost.js"

const prices = (id: Parameters<typeof modelInfo>[0]) =>
  modelInfo(id).defaultPrices

describe("callCost", () => {
  it("prices each kind of token", () => {
    expect(
      callCost(
        {
          promptTokens: 20_000,
          responseTokens: 650,
          promptAudioTokens: 8_000,
          cachedTokens: 1_000,
          responseAudioTokens: 650,
        },
        prices("gemini-3.8-live")
      )
    ).toEqual({
      prompt_text_tokens: 12_000,
      prompt_audio_tokens: 8_000,
      cached_tokens: 1_000,
      response_text_tokens: 0,
      response_audio_tokens: 650,
      usd: 0.0408,
    })
  })

  it("prices cached tokens at their own rates", () => {
    // 1000 text, of it 400 cached; 2000 audio, of it 500 cached; 100 text and
    // 1000 audio out.
    const { usd } = callCost(
      {
        promptTokens: 3_000,
        responseTokens: 1_100,
        promptAudioTokens: 2_000,
        cachedTokens: 900,
        cachedAudioTokens: 500,
        responseAudioTokens: 1_000,
      },
      prices("gpt-realtime-2.1")
    )
    const expected =
      (600 * 4 + 400 * 0.4 + 1_500 * 32 + 500 * 0.4 + 100 * 24 + 1_000 * 64) /
      1_000_000
    expect(usd).toBeCloseTo(expected, 5)
  })

  it("counts what can't be told apart at no less than the text there was", () => {
    // Gemini doesn't say how much of the cached tokens is audio.
    const { usd } = callCost(
      {
        promptTokens: 1_000,
        responseTokens: 0,
        promptAudioTokens: 900,
        cachedTokens: 500,
        responseAudioTokens: 0,
      },
      {
        kind: "tokens",
        text_in: 1,
        cached_text_in: 0,
        audio_in: 10,
        text_out: 1,
        audio_out: 1,
      }
    )
    expect(usd).toBeCloseTo((100 * 0 + 900 * 10) / 1_000_000, 5)
  })

  it("prices a session by the minute, and its backend model's tokens", () => {
    expect(
      callCost(
        {
          promptTokens: 2_000,
          responseTokens: 500,
          promptAudioTokens: 0,
          cachedTokens: 1_000,
          responseAudioTokens: 0,
          seconds: 90,
        },
        prices("gpt-live-1")
      )
    ).toMatchObject({
      seconds: 90,
      // 1.5 min at 0.05, 1000 at 0.1, 1000 at 0.01, 500 at 0.5 per million.
      usd: 0.07536,
    })
  })
})
