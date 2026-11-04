import { EventEmitter } from "node:events"
import type { OpenAISocket } from "./session.js"

/** Stands in for OpenAI's end of the WebSocket in tests. */
export class FakeSocket extends EventEmitter {
  readonly sent: Record<string, any>[] = []
  closed = false

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, any>)
  }
  close() {
    this.closed = true
  }

  /** The events of one type the session sent. */
  of(type: string) {
    return this.sent.filter((event) => event.type === type)
  }
  /** OpenAI sends an event. */
  receive(event: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(event)))
  }
  asSocket() {
    return this as unknown as OpenAISocket
  }
}

export const audioOf = (bytes: number, fill = 1) =>
  Buffer.alloc(bytes, fill).toString("base64")
