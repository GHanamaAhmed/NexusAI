import { randomUUID } from "node:crypto"
import type { VoiceSession } from "../index.js"
import { resample } from "../resample.js"
import {
  functionTools,
  type OpenAIOptions,
  OpenAISession,
  parseArguments,
  type ServerEvent,
} from "./session.js"

const RATE = 24_000
const LIVE_URL = "wss://api.openai.com/v1/live/sessions"
/** Transcripts have no end; a pause this long ends what was being said. */
const TRANSCRIPT_PAUSE_MS = 1_000
/** How long a closing session waits to hear its final seconds. */
const CLOSE_WAIT_MS = 1_500

type BackendItem = {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
}

type BackendEvent = {
  type?: string
  item?: BackendItem
  response?: {
    output?: BackendItem[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
    }
  }
}

const BACKEND_RUN_ENDS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
])

export type GptLiveOptions = OpenAIOptions & {
  /** The model that runs the functions; a client's own can't declare them. */
  backendModel: string
}

/**
 * A spoken conversation over GPT-Live's WebSocket. Its functions run through a
 * backend model (Responses delegation). It reports no end of a turn and no
 * interruption, so the call's own timers end the goodbye.
 */
class GptLiveSession extends OpenAISession {
  private said = ""
  private sayingTimer?: NodeJS.Timeout
  /** Seconds already reported; the provider's count is cumulative. */
  private seconds = 0
  private readonly calls = new Map<string, BackendItem>()
  private readonly answered = new Set<string>()
  private closedSignal: () => void = () => {}

  constructor(private readonly live: GptLiveOptions) {
    super(live)
  }

  protected opened() {
    const { instruction, tools, voice, backendModel } = this.live
    this.send({
      type: "session.start",
      session: {
        model: "gpt-live-1",
        instructions: instruction,
        audio: {
          format: { type: "audio/pcm", rate: RATE },
          output: { voice },
        },
        delegation: {
          type: "responses",
          responses: {
            model: backendModel,
            instructions: instruction,
            tools: functionTools(tools),
            tool_choice: "auto",
            parallel_tool_calls: false,
          },
        },
      },
    })
  }

  sendAudio(pcm: Buffer, sampleRate: number) {
    this.send({
      type: "session.input_audio.append",
      audio: resample(pcm, sampleRate, RATE).toString("base64"),
    })
  }

  start(openingText: string) {
    this.instruct(
      `The customer answered the phone saying "${openingText}". Say your first words now, exactly as your instructions give them, then pause and listen.`
    )
  }

  instruct(text: string) {
    this.send({
      type: "session.instructions.append",
      event_id: `evt_${randomUUID()}`,
      delegation_id: null,
      content: text,
    })
  }

  /** Waits to hear the session's final seconds, which the call's cost needs. */
  close(): Promise<void> {
    this.flushTranscript()
    this.send({ type: "session.close" })
    this.over = true
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.closedSignal(), CLOSE_WAIT_MS)
      this.closedSignal = () => {
        clearTimeout(timer)
        this.closedSignal = () => {}
        this.socket.close()
        resolve()
      }
    })
  }

  protected socketGone() {
    this.flushTranscript()
    this.closedSignal()
  }

  protected handle(event: ServerEvent) {
    switch (event.type) {
      case "session.started":
        this.connected()
        break
      case "session.output_audio.delta":
        this.audio(Buffer.from(String(event.delta), "base64"))
        break
      case "session.output_transcript.delta":
        this.heardAgent(String(event.delta))
        break
      case "session.usage.updated":
        this.reportSeconds(event.usage)
        break
      case "session.closed":
        this.reportSeconds(event.usage)
        this.flushTranscript()
        if (this.over) {
          this.closedSignal()
        } else {
          this.fail(String(event.reason ?? "session closed"))
        }
        break
      case "response.event":
        this.backendEvent(event.event as BackendEvent)
        break
      case "error":
        this.handleError(event.error as Parameters<typeof this.handleError>[0])
        break
    }
  }

  private heardAgent(text: string) {
    this.said += text
    clearTimeout(this.sayingTimer)
    this.sayingTimer = setTimeout(
      () => this.flushTranscript(),
      TRANSCRIPT_PAUSE_MS
    )
  }

  private flushTranscript() {
    clearTimeout(this.sayingTimer)
    if (this.said.trim()) {
      this.transcript("agent", this.said.trim())
    }
    this.said = ""
  }

  private reportSeconds(usage: unknown) {
    const total = (usage as { seconds?: unknown } | undefined)?.seconds
    if (typeof total !== "number" || total <= this.seconds) {
      return
    }
    this.usage({
      promptTokens: 0,
      responseTokens: 0,
      promptAudioTokens: 0,
      cachedTokens: 0,
      responseAudioTokens: 0,
      seconds: total - this.seconds,
    })
    this.seconds = total
  }

  private backendEvent(event: BackendEvent = {}) {
    if (event.type === "response.output_item.done") {
      this.keepCall(event.item)
    } else if (event.type && BACKEND_RUN_ENDS.has(event.type)) {
      for (const item of event.response?.output ?? []) {
        this.keepCall(item)
      }
      const usage = event.response?.usage
      if (usage) {
        this.usage({
          promptTokens: usage.input_tokens ?? 0,
          responseTokens: usage.output_tokens ?? 0,
          promptAudioTokens: 0,
          cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
          responseAudioTokens: 0,
        })
      }
      void this.answerCalls()
    }
  }

  private keepCall(item?: BackendItem) {
    if (
      item?.type === "function_call" &&
      item.call_id &&
      !this.answered.has(item.call_id)
    ) {
      this.calls.set(item.call_id, item)
    }
  }

  /** Every call of a run is answered, then the backend goes on. */
  private async answerCalls() {
    const calls = [...this.calls.values()]
    this.calls.clear()
    for (const call of calls) {
      this.answered.add(String(call.call_id))
      const result = await this.tool({
        id: String(call.call_id),
        name: String(call.name),
        args: parseArguments(call.arguments),
      })
      this.send({
        type: "response.item.create",
        event_id: `evt_${randomUUID()}`,
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        },
      })
    }
    if (calls.length > 0) {
      this.send({ type: "response.create", event_id: `evt_${randomUUID()}` })
    }
  }
}

/** Opens a spoken conversation with GPT-Live. */
export async function connectGptLive(
  options: GptLiveOptions
): Promise<VoiceSession> {
  const session = new GptLiveSession(options)
  await session.open(LIVE_URL)
  return session
}
