import type { Usage } from "@nexus/ai"

/**
 * Gemini Live's prices in US dollars per million tokens
 * (https://ai.google.dev/gemini-api/docs/pricing, November 2026). Cached
 * tokens are counted at the full price, so the total is an upper bound.
 */
const PRICE_PER_MILLION = {
  textIn: 0.75,
  audioIn: 3,
  textOut: 4.5,
  audioOut: 12,
}

/** A call's tokens by kind, and what they cost. */
export function callCost(usage: Usage): Record<string, number> {
  const promptText = usage.promptTokens - usage.promptAudioTokens
  const responseText = usage.responseTokens - usage.responseAudioTokens
  const dollars =
    (promptText * PRICE_PER_MILLION.textIn +
      usage.promptAudioTokens * PRICE_PER_MILLION.audioIn +
      responseText * PRICE_PER_MILLION.textOut +
      usage.responseAudioTokens * PRICE_PER_MILLION.audioOut) /
    1_000_000
  return {
    prompt_text_tokens: promptText,
    prompt_audio_tokens: usage.promptAudioTokens,
    cached_tokens: usage.cachedTokens,
    response_text_tokens: responseText,
    response_audio_tokens: usage.responseAudioTokens,
    usd: Math.round(dollars * 100_000) / 100_000,
  }
}
