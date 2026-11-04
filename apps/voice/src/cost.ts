import type { Prices, Usage } from "@nexus/ai"

const MILLION = 1_000_000

/**
 * A call's tokens by kind, and what they cost at the model's prices. A price
 * with no cached rate counts cached tokens at the full one, so the total is an
 * upper bound.
 */
export function callCost(usage: Usage, prices: Prices): Record<string, number> {
  const promptAudio = usage.promptAudioTokens
  const promptText = usage.promptTokens - promptAudio
  const responseText = usage.responseTokens - usage.responseAudioTokens
  const cachedAudio = usage.cachedAudioTokens ?? 0
  // A provider that doesn't say how much is audio counts it all as text, which
  // can't be more than the text there was.
  const cachedText = Math.min(usage.cachedTokens - cachedAudio, promptText)
  const seconds = usage.seconds ?? 0
  const dollars =
    prices.kind === "minute"
      ? (seconds / 60) * prices.per_minute +
        ((promptText - cachedText) * prices.backend_text_in +
          cachedText * prices.backend_cached_text_in +
          responseText * prices.backend_text_out) /
          MILLION
      : ((promptText - cachedText) * prices.text_in +
          cachedText * (prices.cached_text_in ?? prices.text_in) +
          (promptAudio - cachedAudio) * prices.audio_in +
          cachedAudio * (prices.cached_audio_in ?? prices.audio_in) +
          responseText * prices.text_out +
          usage.responseAudioTokens * prices.audio_out) /
        MILLION
  return {
    prompt_text_tokens: promptText,
    prompt_audio_tokens: promptAudio,
    cached_tokens: usage.cachedTokens,
    response_text_tokens: responseText,
    response_audio_tokens: usage.responseAudioTokens,
    ...(usage.cachedAudioTokens ? { cached_audio_tokens: cachedAudio } : {}),
    ...(seconds ? { seconds } : {}),
    usd: Math.round(dollars * 100_000) / 100_000,
  }
}
