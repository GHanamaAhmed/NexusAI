/** Turns text into 8 kHz A-law, the phone line's own format. */
export interface Speech {
  render(input: {
    text: string
    voice: string
    style?: string
  }): Promise<{ audio: Buffer; seconds: number }>
}

export type ToolDeclaration = {
  name: string
  description: string
  parameters?: {
    properties: Record<string, { type: "string"; description: string }>
    required?: string[]
  }
}

export type ToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

/** Tokens a turn used, as the model's provider reported them. */
export type Usage = {
  promptTokens: number
  responseTokens: number
  /** Of the prompt: audio, and tokens the provider had cached. */
  promptAudioTokens: number
  cachedTokens: number
  /** Of the response: audio. */
  responseAudioTokens: number
  /** Of the cached tokens: audio, where the provider says. */
  cachedAudioTokens?: number
  /** Seconds of session, where the provider bills by time. */
  seconds?: number
}

/** One spoken conversation with a model; only its own folder knows which one. */
export interface VoiceSession {
  sendAudio(pcm: Buffer, sampleRate: number): void
  onAudio(listener: (pcm24k: Buffer) => void): void
  onInterrupted(listener: () => void): void
  onTool(listener: (call: ToolCall) => Promise<Record<string, unknown>>): void
  onTranscript(
    listener: (who: "customer" | "agent", text: string) => void
  ): void
  onTurnComplete(listener: () => void): void
  onUsage(listener: (usage: Usage) => void): void
  /** The customer's first words, which start the conversation. */
  start(openingText: string): void
  /** Tells the model what to do now, such as that the call's time is up. */
  instruct(text: string): void
  /** Settles once whatever the session still had to report has come. */
  close(): void | Promise<void>
}

export * from "./gemini/live.js"
export * from "./openai/live.js"
export * from "./openai/realtime.js"
export * from "./settings.js"
