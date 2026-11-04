import type { VoiceSession } from "../index.js"
import { resample } from "../resample.js"
import type { ModelSettings } from "../settings.js"
import {
  functionTools,
  type OpenAIOptions,
  OpenAISession,
  parseArguments,
  type ServerEvent,
} from "./session.js"

const RATE = 24_000
const BYTES_PER_MS = 48
const REALTIME_URL = "wss://api.openai.com/v1/realtime"

type Playing = {
  itemId: string
  contentIndex: number
  startedAt: number
  bytes: number
}

type OutputItem = {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  status?: string
}

type RealtimeUsage = {
  input_tokens?: number
  output_tokens?: number
  input_token_details?: {
    audio_tokens?: number
    cached_tokens?: number
    cached_tokens_details?: { audio_tokens?: number }
  }
  output_token_details?: { audio_tokens?: number }
}

type ResponseDone = {
  status?: string
  status_details?: { error?: { code?: string; type?: string } }
  output?: OutputItem[]
  usage?: RealtimeUsage
}

export type RealtimeOptions = OpenAIOptions & {
  model: string
  settings: ModelSettings
}

/** A spoken conversation over OpenAI's Realtime WebSocket. */
class RealtimeSession extends OpenAISession {
  /** The assistant's audio not yet known to have played to its end. */
  private playing: Playing | null = null
  /** Audio still arriving for an answer the customer cut off. */
  private droppedItem: string | null = null
  private responding = false
  private respondWhenFree = false

  constructor(private readonly realtime: RealtimeOptions) {
    super(realtime)
  }

  protected opened() {}

  private update() {
    const { instruction, tools, voice, settings } = this.realtime
    const format = { type: "audio/pcm", rate: RATE }
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: instruction,
        output_modalities: ["audio"],
        reasoning: settings.reasoning
          ? { effort: settings.reasoning }
          : undefined,
        tool_choice: "auto",
        tools: functionTools(tools),
        audio: {
          input: {
            format,
            noise_reduction:
              settings.noise_reduction && settings.noise_reduction !== "off"
                ? { type: settings.noise_reduction }
                : null,
            turn_detection:
              settings.vad === "semantic_vad"
                ? {
                    type: "semantic_vad",
                    eagerness: settings.eagerness,
                    create_response: true,
                    interrupt_response: true,
                  }
                : {
                    type: "server_vad",
                    threshold: settings.threshold,
                    prefix_padding_ms: settings.prefix_padding_ms,
                    silence_duration_ms: settings.silence_ms,
                    create_response: true,
                    interrupt_response: true,
                  },
          },
          output: { format, voice, speed: settings.speed },
        },
      },
    })
  }

  sendAudio(pcm: Buffer, sampleRate: number) {
    this.send({
      type: "input_audio_buffer.append",
      audio: resample(pcm, sampleRate, RATE).toString("base64"),
    })
  }

  start(openingText: string) {
    this.say("user", openingText)
  }

  instruct(text: string) {
    this.say("system", text)
  }

  private say(role: "user" | "system", text: string) {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role,
        content: [{ type: "input_text", text }],
      },
    })
    if (this.responding) {
      this.send({ type: "response.cancel" })
    }
    this.respond()
  }

  /** Asks for an answer, or for one after the answer in progress. */
  private respond() {
    if (this.responding) {
      this.respondWhenFree = true
      return
    }
    this.responding = true
    this.send({ type: "response.create" })
  }

  close() {
    this.over = true
    this.socket.close()
  }

  protected handle(event: ServerEvent) {
    switch (event.type) {
      case "session.created":
        this.update()
        break
      case "session.updated":
        this.connected()
        break
      case "response.created":
        this.responding = true
        break
      case "response.output_audio.delta":
        this.played(event)
        break
      case "response.output_audio_transcript.done":
        if (typeof event.transcript === "string" && event.transcript.trim()) {
          this.transcript("agent", event.transcript.trim())
        }
        break
      case "input_audio_buffer.speech_started":
        this.customerSpoke()
        break
      case "response.done":
        void this.responseDone(event.response as ResponseDone)
        break
      case "error":
        this.handleError(event.error as Parameters<typeof this.handleError>[0])
        break
    }
  }

  private played(event: ServerEvent) {
    const itemId = String(event.item_id)
    if (itemId === this.droppedItem) {
      return
    }
    const pcm = Buffer.from(String(event.delta), "base64")
    if (this.playing?.itemId !== itemId) {
      this.playing = {
        itemId,
        contentIndex: Number(event.content_index ?? 0),
        startedAt: Date.now(),
        bytes: 0,
      }
    }
    this.playing.bytes += pcm.length
    this.audio(pcm)
  }

  /**
   * The customer spoke. While the assistant's audio is still playing, what they
   * haven't heard is dropped, here and from the conversation, so the model
   * doesn't think they heard it.
   */
  private customerSpoke() {
    const playing = this.playing
    this.playing = null
    if (!playing) {
      return
    }
    const heardMs = Date.now() - playing.startedAt
    if (heardMs >= playing.bytes / BYTES_PER_MS) {
      return
    }
    this.droppedItem = playing.itemId
    this.send({
      type: "conversation.item.truncate",
      item_id: playing.itemId,
      content_index: playing.contentIndex,
      audio_end_ms: Math.floor(heardMs),
    })
    this.interrupted()
  }

  private async responseDone(response: ResponseDone = {}) {
    this.responding = false
    if (response.usage) {
      this.report(response.usage)
    }
    if (response.status === "failed") {
      const error = response.status_details?.error
      this.fail(`response failed: ${error?.code ?? error?.type ?? "unknown"}`)
      return
    }
    const calls = (response.output ?? []).filter(
      (item) => item.type === "function_call" && item.status !== "incomplete"
    )
    for (const call of calls) {
      const result = await this.tool({
        id: String(call.call_id),
        name: String(call.name),
        args: parseArguments(call.arguments),
      })
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        },
      })
    }
    if (calls.length > 0 || this.respondWhenFree) {
      this.respondWhenFree = false
      this.respond()
    } else if (response.status === "completed") {
      this.turnComplete()
    }
  }

  private report(usage: RealtimeUsage) {
    const input = usage.input_token_details
    this.usage({
      promptTokens: usage.input_tokens ?? 0,
      responseTokens: usage.output_tokens ?? 0,
      promptAudioTokens: input?.audio_tokens ?? 0,
      cachedTokens: input?.cached_tokens ?? 0,
      cachedAudioTokens: input?.cached_tokens_details?.audio_tokens ?? 0,
      responseAudioTokens: usage.output_token_details?.audio_tokens ?? 0,
    })
  }
}

/** Opens a spoken conversation with one of OpenAI's Realtime models. */
export async function connectOpenAIRealtime(
  options: RealtimeOptions
): Promise<VoiceSession> {
  const session = new RealtimeSession(options)
  await session.open(
    `${REALTIME_URL}?model=${encodeURIComponent(options.model)}`
  )
  return session
}
