import { WebSocketServer, type WebSocket } from "ws"

type MediaStart = {
  event: "MEDIA_START"
  channel_id?: string
  channel?: string
  format?: string
  optimal_frame_size: number
  ptime?: number
}

/** One call's audio socket, opened by Asterisk's WebSocket channel. */
export class MediaCall {
  onAudio: (pcm: Buffer) => void = () => {}
  onDrained: () => void = () => {}
  private pending = Buffer.alloc(0)
  private paused = false

  constructor(
    private readonly socket: WebSocket,
    private readonly frameSize: number
  ) {}

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
      this.socket.send(this.pending.subarray(0, size))
      this.pending = this.pending.subarray(size)
    }
  }

  /** The caller spoke over us: drops everything not yet heard. */
  flush() {
    this.pending = Buffer.alloc(0)
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
        call = new MediaCall(socket, event.optimal_frame_size)
        options.onCall(call, event)
      } else {
        call?.control(event)
      }
    })
  })
  return server
}
