import WebSocket from "ws"
import type {
  ToolCall,
  ToolDeclaration,
  Usage,
  VoiceSession,
} from "../index.js"

const CONNECT_TIMEOUT_MS = 10_000

/** What a session needs from a WebSocket; tests pass a fake. */
export type OpenAISocket = {
  send(data: string): void
  close(): void
  on(event: "open", listener: () => void): unknown
  on(
    event: "message",
    listener: (data: { toString(): string }) => void
  ): unknown
  on(
    event: "close",
    listener: (code: number, reason: { toString(): string }) => void
  ): unknown
  on(event: "error", listener: (error: Error) => void): unknown
}

export type OpenSocket = (url: string, apiKey: string) => OpenAISocket

const openWebSocket: OpenSocket = (url, apiKey) =>
  new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } })

export type OpenAIOptions = {
  apiKey: string
  voice: string
  instruction: string
  tools: ToolDeclaration[]
  onClose?: (reason: string) => void
  log?: (line: string) => void
  openSocket?: OpenSocket
}

export type ServerEvent = { type: string; [key: string]: unknown }

type ServerError = {
  type?: string
  code?: string | null
  param?: string | null
  message?: string
}

/** The function tools as OpenAI declares them. */
export function functionTools(tools: ToolDeclaration[]) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: tool.parameters?.properties ?? {},
      required: tool.parameters?.required ?? [],
    },
  }))
}

/** A function call's arguments; the call itself refuses what's missing. */
export function parseArguments(text: unknown): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(text))
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** What both OpenAI sessions share: the socket, its failures and the listeners. */
export abstract class OpenAISession implements VoiceSession {
  protected socket!: OpenAISocket
  protected audio: (pcm: Buffer) => void = () => {}
  protected interrupted: () => void = () => {}
  protected tool: (call: ToolCall) => Promise<Record<string, unknown>> =
    async () => ({})
  protected transcript: (who: "customer" | "agent", text: string) => void =
    () => {}
  protected turnComplete: () => void = () => {}
  protected usage: (usage: Usage) => void = () => {}
  /** Nothing more goes out, and nothing more is reported as closing. */
  protected over = false
  private isConnected = false
  private settle: (error?: Error) => void = () => {}

  constructor(protected readonly options: OpenAIOptions) {}

  abstract sendAudio(pcm: Buffer, sampleRate: number): void
  abstract start(openingText: string): void
  abstract instruct(text: string): void
  abstract close(): void | Promise<void>
  /** The socket is open. */
  protected abstract opened(): void
  protected abstract handle(event: ServerEvent): void
  /** The socket has gone, whoever closed it. */
  protected socketGone() {}

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
  onUsage(listener: (usage: Usage) => void) {
    this.usage = listener
  }

  /** Resolves once the provider has taken the session's settings. */
  open(url: string): Promise<void> {
    const open = this.options.openSocket ?? openWebSocket
    this.socket = open(url, this.options.apiKey)
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail("no session in time"),
        CONNECT_TIMEOUT_MS
      )
      this.settle = (error) => {
        clearTimeout(timer)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      this.socket.on("open", () => this.opened())
      this.socket.on("message", (data) => {
        const event = parseEvent(data.toString())
        if (event) {
          this.handle(event)
        }
      })
      // A failed connection reports here first; its close follows.
      this.socket.on("error", (error) => {
        if (this.isConnected) {
          this.log(`socket: ${error.message}`)
        } else {
          this.fail(error.message)
        }
      })
      this.socket.on("close", (code, reason) => {
        this.socketGone()
        this.finish(reason.toString() || `socket closed (${code})`)
      })
    })
  }

  /** The provider took the session's settings. */
  protected connected() {
    this.isConnected = true
    this.settle()
  }

  protected send(event: Record<string, unknown>) {
    if (!this.over) {
      this.socket.send(JSON.stringify(event))
    }
  }

  protected log(line: string) {
    this.options.log?.(`OpenAI: ${line}`)
  }

  /**
   * A request the provider refused during a call, such as creating a response
   * while one runs, doesn't stop the conversation. Anything else does: the
   * customer must not wait on a silent line.
   */
  protected handleError(error: ServerError = {}) {
    const text = [error.type, error.code, error.param, error.message]
      .filter(Boolean)
      .join(": ")
      .slice(0, 300)
    if (this.isConnected && error.type === "invalid_request_error") {
      this.log(text)
    } else {
      this.fail(text || "error")
    }
  }

  /** Ends the session because of the provider, with the reason. */
  protected fail(reason: string) {
    this.finish(reason)
    this.over = true
    this.socket.close()
  }

  private finish(reason: string) {
    if (!this.isConnected) {
      this.settle(new Error(reason))
    } else if (!this.over) {
      this.options.onClose?.(reason)
    }
    this.over = true
  }
}

function parseEvent(text: string): ServerEvent | null {
  try {
    return JSON.parse(text) as ServerEvent
  } catch {
    return null
  }
}
