import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"
import { MediaCall } from "./media.js"

const FRAME = 960 // 20 ms of 16-bit audio at 24 kHz

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sent: (Buffer | string)[] = []
  send(data: Buffer | string) {
    this.sent.push(data)
  }
  audioBytes() {
    return this.sent
      .filter((item): item is Buffer => Buffer.isBuffer(item))
      .reduce((total, item) => total + item.length, 0)
  }
}

describe("MediaCall", () => {
  let socket: FakeSocket
  let call: MediaCall

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"))
    socket = new FakeSocket()
    call = new MediaCall(socket as unknown as WebSocket, FRAME, 24_000)
  })

  afterEach(() => {
    socket.emit("close")
    vi.useRealTimers()
  })

  it("starts with a short cushion of silence, not more", () => {
    vi.advanceTimersByTime(20)
    expect(socket.audioBytes()).toBe(6 * FRAME) // 120 ms
  })

  it("keeps sending silence at the pace of real time", () => {
    vi.advanceTimersByTime(10_000)
    const seconds = socket.audioBytes() / (FRAME * 50)
    expect(seconds).toBeGreaterThan(9.9)
    expect(seconds).toBeLessThan(10.3)
    expect(call.sent.speech).toBe(0)
  })

  it("sends no silence while speech is still playing", () => {
    call.play(Buffer.alloc(FRAME * 100)) // 2 s of speech
    vi.advanceTimersByTime(1_000)
    expect(call.sent.silence).toBe(0)
    vi.advanceTimersByTime(1_500)
    expect(call.sent.silence).toBeGreaterThan(0)
  })

  it("sends only whole frames of speech", () => {
    call.play(Buffer.alloc(FRAME + 100))
    expect(call.sent.speech).toBe(FRAME)
  })

  it("pads the end of speech and keeps the silence going", () => {
    call.play(Buffer.alloc(FRAME * 10 + 100)) // ends mid-frame
    vi.advanceTimersByTime(2_000)
    expect(call.sent.speech).toBe(FRAME * 11)
    expect(call.sent.silence).toBeGreaterThan(FRAME * 50)
  })

  it("drops queued speech and asks Asterisk to flush when interrupted", () => {
    call.play(Buffer.alloc(FRAME * 50))
    call.flush()
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ command: "FLUSH_MEDIA" }))
    vi.advanceTimersByTime(20)
    expect(call.sent.silence).toBe(6 * FRAME)
  })

  it("holds audio while Asterisk's queue is full", () => {
    call.control({ event: "MEDIA_XOFF" })
    call.play(Buffer.alloc(FRAME * 10))
    vi.advanceTimersByTime(100)
    expect(socket.audioBytes()).toBe(0)
    call.control({ event: "MEDIA_XON" })
    expect(call.sent.speech).toBe(FRAME * 10)
  })
})
