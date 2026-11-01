import { EventEmitter } from "node:events"
import type { ToolCall, VoiceSession } from "@nexus/ai"
import { type ConfirmationOrder, OPENING } from "@nexus/conversation"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"
import { Call, type Connect } from "./call.js"
import { MediaCall } from "./media.js"

const FRAME = 960 // 20 ms of 16-bit audio at 24 kHz

const order: ConfirmationOrder = {
  store: { name: "Boutique Yasmine" },
  customer: { name: "Sara", language: "ar" },
  order: {
    items: [{ title: "Chemise", quantity: 2 }],
    total: 6500,
    delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
  },
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  send() {}
}

class FakeSession implements VoiceSession {
  heard: Buffer[] = []
  started: string[] = []
  closed = false
  audio: (pcm: Buffer) => void = () => {}
  tool: (call: ToolCall) => Promise<Record<string, unknown>> = async () => ({})
  turnComplete: () => void = () => {}
  sendAudio(pcm: Buffer) {
    this.heard.push(pcm)
  }
  onAudio(listener: (pcm: Buffer) => void) {
    this.audio = listener
  }
  onInterrupted() {}
  onTool(listener: (call: ToolCall) => Promise<Record<string, unknown>>) {
    this.tool = listener
  }
  onTranscript() {}
  onTurnComplete(listener: () => void) {
    this.turnComplete = listener
  }
  onUsage() {}
  start(text: string) {
    this.started.push(text)
  }
  close() {
    this.closed = true
  }
}

describe("Call", () => {
  let steps: string[]
  let channelId: string
  let sessions: FakeSession[]
  let closers: ((reason: string) => void)[]
  let socket: FakeSocket
  let media: MediaCall
  let call: Call

  const hungUp = () => steps.includes(`DELETE /channels/${channelId}`)
  const answer = async () => {
    await call.onEvent({ type: "StasisStart", channel: { id: channelId } })
    await call.attachMedia(media)
  }
  const useTool = (name: string, args: Record<string, unknown> = {}) =>
    sessions[0]!.tool({ id: "1", name, args })
  /** 20 ms of someone speaking. */
  const voice = () => {
    const pcm = Buffer.alloc(FRAME)
    for (let i = 0; i < FRAME; i += 2) {
      pcm.writeInt16LE(i % 4 ? -3000 : 3000, i)
    }
    return pcm
  }
  /** Nobody says anything, so the greeting starts. */
  const greet = () => vi.advanceTimersByTime(2_000)

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"))
    steps = []
    sessions = []
    closers = []
    const ari = {
      request: async (
        method: string,
        path: string,
        query: Record<string, string> = {}
      ) => {
        steps.push(`${method} ${path}`)
        if (path === "/channels") {
          channelId = query.channelId!
        }
        return null
      },
    }
    const connect: Connect = async ({ onClose }) => {
      steps.push("connect")
      const session = new FakeSession()
      sessions.push(session)
      closers.push(onClose)
      return session
    }
    socket = new FakeSocket()
    media = new MediaCall(socket as unknown as WebSocket, FRAME, 24_000)
    call = new Call({
      ari,
      connect,
      order,
      endpoint: "PJSIP/0551234567@line01",
      log: () => {},
    })
    await call.dial()
  })

  afterEach(() => {
    socket.emit("close")
    vi.useRealTimers()
  })

  it("connects to Gemini before it dials", () => {
    expect(steps.slice(0, 2)).toEqual(["connect", "POST /channels"])
  })

  it("replaces a session that closed while the phone rang", async () => {
    closers[0]!("idle")
    await answer()
    expect(sessions).toHaveLength(2)
    greet()
    expect(sessions[1]!.started).toEqual([OPENING])
    expect(hungUp()).toBe(false)
  })

  it("greets once the customer's allo is over", async () => {
    await answer()
    vi.advanceTimersByTime(1_000)
    media.onAudio(voice())
    vi.advanceTimersByTime(300)
    media.onAudio(voice())
    vi.advanceTimersByTime(300)
    expect(sessions[0]!.started).toEqual([])
    vi.advanceTimersByTime(200)
    expect(sessions[0]!.started).toEqual([OPENING])
  })

  it("greets after 2 s when the customer says nothing", async () => {
    await answer()
    vi.advanceTimersByTime(1_900)
    expect(sessions[0]!.started).toEqual([])
    vi.advanceTimersByTime(100)
    expect(sessions[0]!.started).toEqual([OPENING])
  })

  it("greets after 3 s at the latest, while the customer keeps talking", async () => {
    await answer()
    for (let elapsed = 100; elapsed < 3_000; elapsed += 100) {
      vi.advanceTimersByTime(100)
      media.onAudio(voice())
    }
    expect(sessions[0]!.started).toEqual([])
    vi.advanceTimersByTime(100)
    expect(sessions[0]!.started).toEqual([OPENING])
  })

  it("keeps the allo from the model, and passes what follows the greeting", async () => {
    await answer()
    media.onAudio(voice())
    expect(sessions[0]!.heard).toHaveLength(0)
    greet()
    media.onAudio(voice())
    expect(sessions[0]!.heard).toHaveLength(1)
  })

  it("answers a lookup without ending the call", async () => {
    await answer()
    greet()
    expect(
      await useTool("find_place", { wilaya: "ادرار", commune: "اولاف" })
    ).toEqual({
      status: "found",
      wilaya_code: "1",
      wilaya: "أدرار",
      commune: "أولف",
    })
    media.onAudio(Buffer.alloc(FRAME))
    expect(sessions[0]!.heard).toHaveLength(1)
    vi.advanceTimersByTime(10_000)
    expect(hungUp()).toBe(false)
  })

  it("stops listening after the answer, and hangs up once the goodbye is heard", async () => {
    await answer()
    greet()
    expect(await useTool("confirm_order")).toEqual({ ok: true })
    media.onAudio(Buffer.alloc(FRAME))
    expect(sessions[0]!.heard).toHaveLength(0)
    sessions[0]!.audio(Buffer.alloc(FRAME * 50)) // a 1 s goodbye
    sessions[0]!.turnComplete()
    // Sent by about 1.1 s; the phone plays it up to a second later.
    vi.advanceTimersByTime(2_000)
    expect(hungUp()).toBe(false)
    vi.advanceTimersByTime(600)
    expect(hungUp()).toBe(true)
  })

  const hangUpNormally = () =>
    call.onEvent({
      type: "ChannelDestroyed",
      channel: { id: channelId },
      cause: 16,
      cause_txt: "Normal Clearing",
    })

  it("returns the place the customer confirmed", async () => {
    await answer()
    await useTool("find_place", { wilaya: "ادرار", commune: "اولاف" })
    await useTool("request_change", {
      what: "بلدية أولف",
      wilaya_code: "1",
      commune: "أولف",
      yes: "إيه صح",
    })
    await hangUpNormally()
    expect(await call.done).toMatchObject({
      outcome: "request_change",
      change: { wilaya_code: 1, commune_ar: "أولف", commune_fr: "Aoulef" },
      cause: 16,
    })
  })

  it("sends back a place the customer didn't say yes to, and goes on", async () => {
    await answer()
    greet()
    await useTool("find_place", { wilaya: "الجزائر", commune: "الشراقة" })
    expect(
      await useTool("request_change", {
        what: "ولاية الجزائر، بلدية الشراقة",
        wilaya_code: "16",
        commune: "الشراقة",
        yes: "أدرار رقان",
      })
    ).toMatchObject({ error: expect.stringContaining("hasn't said yes") })
    media.onAudio(voice())
    expect(sessions[0]!.heard).toHaveLength(1)
    vi.advanceTimersByTime(10_000)
    expect(hungUp()).toBe(false)
    await useTool("request_change", { what: "يحب يبدل، البلاصة ما تفهمتش" })
    await hangUpNormally()
    expect(await call.done).toMatchObject({
      outcome: "request_change",
      args: { what: "يحب يبدل، البلاصة ما تفهمتش" },
      change: null,
    })
  })

  it("sends back a place the lookup never offered", async () => {
    await answer()
    expect(
      await useTool("request_change", {
        what: "بلدية أولف",
        wilaya_code: "1",
        commune: "أولف",
        yes: "إيه",
      })
    ).toMatchObject({ error: expect.any(String) })
    await hangUpNormally()
    expect(await call.done).toMatchObject({ outcome: null, change: null })
  })

  it("keeps the first answer when the model calls a second one", async () => {
    await answer()
    await useTool("request_change", { what: "بدل البلدية" })
    await useTool("confirm_order")
    await hangUpNormally()
    expect(await call.done).toMatchObject({
      outcome: "request_change",
      args: { what: "بدل البلدية" },
    })
  })

  it("hangs up when Gemini closes during the call", async () => {
    await answer()
    closers[0]!("internal error")
    expect(hungUp()).toBe(true)
  })

  it("closes the session when nobody answers", async () => {
    await call.onEvent({
      type: "ChannelDestroyed",
      channel: { id: channelId },
      cause: 19,
      cause_txt: "No answer",
    })
    expect(await call.done).toMatchObject({ outcome: null, cause: 19 })
    await vi.waitFor(() => expect(sessions[0]!.closed).toBe(true))
  })
})
