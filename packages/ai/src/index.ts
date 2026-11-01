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

/** One spoken conversation with a model; only src/gemini knows which one. */
export interface VoiceSession {
  sendAudio(pcm: Buffer, sampleRate: number): void
  onAudio(listener: (pcm24k: Buffer) => void): void
  onInterrupted(listener: () => void): void
  onTool(listener: (call: ToolCall) => Promise<Record<string, unknown>>): void
  onTranscript(
    listener: (who: "customer" | "agent", text: string) => void
  ): void
  onTurnComplete(listener: () => void): void
  onUsage(
    listener: (usage: { promptTokens: number; responseTokens: number }) => void
  ): void
  start(openingText: string): void
  close(): void
}

export * from "./gemini/live.js"
