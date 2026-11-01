import { WebSocketServer, type WebSocket } from "ws"

type MediaStart = {
  event: "MEDIA_START"
  channel_id?: string
  channel?: string
  format?: string
  optimal_frame_size: number
  ptime?: number
}

const FRAME_MS = 20
/** Silence keeps at least this much audio waiting, to ride out timer delays. */
const MIN_QUEUED_MS = 120

/**
 * One call's audio socket, opened by Asterisk's WebSocket channel. Audio keeps
 * flowing to the caller even while nobody speaks: the provider stops a call
 * whose audio goes quiet for about 30 seconds.
 */
export class MediaCall {
  onAudio: (pcm: Buffer) => void = () => {}
  onDrained: () => void = () => {}
  private pending = Buffer.alloc(0)
  private paused = false
  /** When Asterisk will have played everything sent so far. */
  private playedUntil = 0
  private readonly bytesPerMs: number
  private readonly keepAlive: NodeJS.Timeout
  /** Bytes sent to Asterisk: speech from the model, and silence. */
  readonly sent = { speech: 0, silence: 0 }

  constructor(
    private readonly socket: WebSocket,
    private readonly frameSize: number,
    sampleRate: number
  ) {
    this.bytesPerMs = (sampleRate * 2) / 1000
    this.keepAlive = setInterval(() => this.fillSilence(), FRAME_MS)
    socket.once("close", () => clearInterval(this.keepAlive))
  }

  private send(chunk: Buffer, kind: "speech" | "silence" = "speech") {
    this.sent[kind] += chunk.length
    const now = Date.now()
    this.playedUntil =
      Math.max(now, this.playedUntil) + chunk.length / this.bytesPerMs
    this.socket.send(chunk)
  }

  /**
   * Tops the caller's audio up with silence when it's about to run out. Speech
   * rarely ends on a whole frame; what's left is padded out and sent first.
   */
  private fillSilence() {
    if (this.paused || this.socket.readyState !== this.socket.OPEN) {
      return
    }
    const queuedMs = Math.max(0, this.playedUntil - Date.now())
    const frames = Math.ceil((MIN_QUEUED_MS - queuedMs) / FRAME_MS)
    if (frames <= 0) {
      return
    }
    if (this.pending.length > 0) {
      const last = Buffer.alloc(this.frameSize)
      this.pending.copy(last)
      this.pending = Buffer.alloc(0)
      this.send(last)
      if (frames > 1) {
        this.send(Buffer.alloc(this.frameSize * (frames - 1)), "silence")
      }
      return
    }
    this.send(Buffer.alloc(this.frameSize * frames), "silence")
  }

  /** Queues audio for the caller; whole frames go out as Asterisk can take them. */
  play(pcm: Buffer) {
    this.pending = Buffer.concat([this.pending, pcm])
    this.pump()
  }

  private pump() {
    if (this.paused || this.socket.readyState !== this.socket.OPEN) {
      return
    }
    const size = this.pending.length - (this.pending.length % this.frameSize)
    if (size > 0) {
      this.send(this.pending.subarray(0, size))
      this.pending = this.pending.subarray(size)
    }
  }

  /** The caller spoke over us: drops everything not yet heard. */
  flush() {
    this.pending = Buffer.alloc(0)
    this.playedUntil = Date.now()
    this.command("FLUSH_MEDIA")
  }

  /** Asks to be told when everything queued has been played. */
  whenDrained() {
    this.command("REPORT_QUEUE_DRAINED")
  }

  hangup() {
    this.command("HANGUP")
  }

  private command(command: string) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify({ command }))
    }
  }

  /** @internal */
  control(event: { event?: string }) {
    if (event.event === "MEDIA_XOFF") {
      this.paused = true
    } else if (event.event === "MEDIA_XON") {
      this.paused = false
      this.pump()
    } else if (event.event === "QUEUE_DRAINED") {
      this.onDrained()
    }
  }
}

/** The sample rate of a signed-linear format such as "slin24". */
function sampleRateOf(format = "slin"): number {
  const khz = Number(/^slin(\d+)$/.exec(format)?.[1] ?? 8)
  return khz * 1000
}

/** Listens for Asterisk's media connections, one for each call. */
export function startMediaServer(options: {
  port: number
  onCall: (call: MediaCall, start: MediaStart) => void
}): WebSocketServer {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: options.port,
    handleProtocols: () => "media",
  })
  server.on("connection", (socket) => {
    let call: MediaCall | undefined
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        call?.onAudio(data as Buffer)
        return
      }
      const event = JSON.parse(String(data)) as MediaStart
      if (event.event === "MEDIA_START") {
        call = new MediaCall(
          socket,
          event.optimal_frame_size,
          sampleRateOf(event.format)
        )
        options.onCall(call, event)
      } else {
        call?.control(event)
      }
    })
  })
  return server
}
