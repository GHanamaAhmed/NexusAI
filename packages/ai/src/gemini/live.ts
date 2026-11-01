import {
  Behavior,
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
  Type,
} from "@google/genai"
import type { ToolCall, ToolDeclaration, VoiceSession } from "../index.js"

const MODEL = "gemini-3.8-live"
const SILENCE_BEFORE_TURN_ENDS_MS = 600

class GeminiLiveSession implements VoiceSession {
  session?: Session
  private audio: (pcm: Buffer) => void = () => {}
  private interrupted: () => void = () => {}
  private tool: (call: ToolCall) => Promise<Record<string, unknown>> =
    async () => ({})
  private transcript: (who: "customer" | "agent", text: string) => void =
    () => {}
  private turnComplete: () => void = () => {}
  private usage: (usage: {
    promptTokens: number
    responseTokens: number
  }) => void = () => {}
  private heard = ""
  private said = ""

  onAudio(listener: (pcm: Buffer) => void) {
    this.audio = listener
  }
  onInterrupted(listener: () => void) {
    this.interrupted = listener
  }
  onTool(listener: (call: ToolCall) => Promise<Record<string, unknown>>) {
    this.tool = listener
  }
  onTranscript(listener: (who: "customer" | "agent", text: string) => void) {
    this.transcript = listener
  }
  onTurnComplete(listener: () => void) {
    this.turnComplete = listener
  }
  onUsage(
    listener: (usage: { promptTokens: number; responseTokens: number }) => void
  ) {
    this.usage = listener
  }

  sendAudio(pcm: Buffer, sampleRate: number) {
    this.session?.sendRealtimeInput({
      audio: {
        data: pcm.toString("base64"),
        mimeType: `audio/pcm;rate=${sampleRate}`,
      },
    })
  }

  start(openingText: string) {
    this.session?.sendClientContent({
      turns: [{ role: "user", parts: [{ text: openingText }] }],
      turnComplete: true,
    })
  }

  close() {
    this.session?.close()
  }

  /** The transcripts arrive in pieces; each turn is passed on whole. */
  private flushTranscripts() {
    if (this.heard.trim()) {
      this.transcript("customer", this.heard.trim())
    }
    if (this.said.trim()) {
      this.transcript("agent", this.said.trim())
    }
    this.heard = ""
    this.said = ""
  }

  handle(message: LiveServerMessage) {
    const content = message.serverContent
    if (content?.inputTranscription?.text) {
      this.heard += content.inputTranscription.text
    }
    if (content?.outputTranscription?.text) {
      this.said += content.outputTranscription.text
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.audio(Buffer.from(part.inlineData.data, "base64"))
      }
    }
    if (content?.interrupted) {
      this.interrupted()
    }
    if (content?.turnComplete) {
      this.flushTranscripts()
      this.turnComplete()
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      this.flushTranscripts()
      void this.answerTool({
        id: call.id ?? "",
        name: call.name ?? "",
        args: call.args ?? {},
      })
    }
    const usage = message.usageMetadata
    if (usage) {
      this.usage({
        promptTokens: usage.promptTokenCount ?? 0,
        responseTokens: usage.responseTokenCount ?? 0,
      })
    }
  }

  private async answerTool(call: ToolCall) {
    const response = await this.tool(call)
    this.session?.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response }],
    })
  }
}

/** Opens a spoken conversation with Gemini Live. */
export async function connectGeminiLive(options: {
  apiKey: string
  voice: string
  instruction: string
  tools: ToolDeclaration[]
  onClose?: (reason: string) => void
}): Promise<VoiceSession> {
  const live = new GeminiLiveSession()
  const ai = new GoogleGenAI({ apiKey: options.apiKey })

  live.session = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: options.instruction,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          silenceDurationMs: SILENCE_BEFORE_TURN_ENDS_MS,
        },
      },
      contextWindowCompression: { slidingWindow: {} },
      tools: [
        {
          functionDeclarations: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            behavior: Behavior.BLOCKING,
            ...(tool.parameters
              ? {
                  parameters: {
                    type: Type.OBJECT,
                    properties: Object.fromEntries(
                      Object.entries(tool.parameters.properties).map(
                        ([name, property]) => [
                          name,
                          {
                            type: Type.STRING,
                            description: property.description,
                          },
                        ]
                      )
                    ),
                    required: tool.parameters.required ?? [],
                  },
                }
              : {}),
          })),
        },
      ],
    },
    callbacks: {
      onmessage: (message) => live.handle(message),
      onerror: (error) => console.error(`Gemini: ${error.message}`),
      onclose: (event) => options.onClose?.(event.reason),
    },
  })
  return live
}
