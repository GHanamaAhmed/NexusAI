import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolCall, Usage, VoiceSession } from "../index.js"
import { audioOf, FakeSocket } from "./fake-socket.js"
import { connectGptLive, type GptLiveOptions } from "./live.js"

describe("GPT-Live", () => {
  let socket: FakeSocket
  let url: string
  let closes: string[]

  const options = (
    overrides: Partial<GptLiveOptions> = {}
  ): GptLiveOptions => ({
    apiKey: "test-key",
    voice: "brise",
    instruction: "Be brief.",
    backendModel: "gpt-6-luna",
    tools: [{ name: "confirm_order", description: "The customer confirmed." }],
    onClose: (reason) => closes.push(reason),
    openSocket: (address) => {
      url = address
      return socket.asSocket()
    },
    ...overrides,
  })

  async function connect(): Promise<VoiceSession> {
    const session = connectGptLive(options())
    socket.emit("open")
    socket.receive({ type: "session.started" })
    return session
  }

  /** An event of the backend model, as the session wraps them. */
  const backend = (event: Record<string, unknown>) =>
    socket.receive({
      type: "response.event",
      event_id: "evt-1",
      delegation_id: "del-1",
      event,
    })
  const functionCall = (id = "call-1") => ({
    type: "function_call",
    call_id: id,
    name: "confirm_order",
    arguments: '{"yes":"oui"}',
  })

  beforeEach(() => {
    vi.useFakeTimers()
    socket = new FakeSocket()
    closes = []
  })
  afterEach(() => vi.useRealTimers())

  describe("opening", () => {
    it("starts with its model, audio, voice and functions", async () => {
      await connect()
      expect(url).toBe("wss://api.openai.com/v1/live/sessions")
      expect(socket.of("session.start")[0]!.session).toEqual({
        model: "gpt-live-1",
        instructions: "Be brief.",
        audio: {
          format: { type: "audio/pcm", rate: 24_000 },
          output: { voice: "brise" },
        },
        delegation: {
          type: "responses",
          responses: {
            model: "gpt-6-luna",
            instructions: "Be brief.",
            tools: [
              {
                type: "function",
                name: "confirm_order",
                description: "The customer confirmed.",
                parameters: { type: "object", properties: {}, required: [] },
              },
            ],
            tool_choice: "auto",
            parallel_tool_calls: false,
          },
        },
      })
    })

    it("waits for the session to start", async () => {
      let connected = false
      void connectGptLive(options()).then(() => (connected = true))
      socket.emit("open")
      await vi.advanceTimersByTimeAsync(1)
      expect(connected).toBe(false)
      socket.receive({ type: "session.started" })
      await vi.advanceTimersByTimeAsync(1)
      expect(connected).toBe(true)
    })

    it("fails when the session is refused", async () => {
      const session = connectGptLive(options())
      socket.emit("open")
      socket.receive({
        type: "error",
        error: { type: "invalid_request_error", code: "unknown_voice" },
      })
      await expect(session).rejects.toThrow("unknown_voice")
      expect(socket.closed).toBe(true)
    })
  })

  describe("audio", () => {
    it("sends audio at its rate", async () => {
      const session = await connect()
      session.sendAudio(Buffer.alloc(960, 2), 24_000)
      session.sendAudio(Buffer.alloc(320), 8_000)
      const [first, second] = socket.of("session.input_audio.append")
      expect(first!.audio).toBe(Buffer.alloc(960, 2).toString("base64"))
      expect(Buffer.from(second!.audio, "base64")).toHaveLength(960)
    })

    it("passes on what it receives", async () => {
      const session = await connect()
      const heard: Buffer[] = []
      session.onAudio((pcm) => heard.push(pcm))
      socket.receive({
        type: "session.output_audio.delta",
        delta: audioOf(480),
      })
      expect(heard[0]).toHaveLength(480)
    })
  })

  describe("being told what to say", () => {
    it("greets when the customer has answered", async () => {
      const session = await connect()
      session.start("Allô ?")
      const [event] = socket.of("session.instructions.append")
      expect(event).toMatchObject({ delegation_id: null })
      expect(event!.event_id).toBeTruthy()
      expect(event!.content).toContain('saying "Allô ?"')
      expect(event!.content).toContain("Say your first words now")
    })

    it("passes on an instruction, each with its own id", async () => {
      const session = await connect()
      session.instruct("Time is up.")
      session.instruct("Time is up.")
      const [first, second] = socket.of("session.instructions.append")
      expect(first).toMatchObject({
        delegation_id: null,
        content: "Time is up.",
      })
      expect(first!.event_id).not.toBe(second!.event_id)
    })
  })

  describe("functions", () => {
    let session: VoiceSession
    let used: ToolCall[]

    beforeEach(async () => {
      session = await connect()
      used = []
      session.onTool(async (tool) => {
        used.push(tool)
        return { ok: true }
      })
    })

    it("runs a function when the backend's run ends, answers it and goes on", async () => {
      backend({ type: "response.output_item.done", item: functionCall() })
      await vi.advanceTimersByTimeAsync(0)
      expect(used).toEqual([])

      backend({ type: "response.completed", response: {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(used).toEqual([
        { id: "call-1", name: "confirm_order", args: { yes: "oui" } },
      ])
      expect(socket.of("response.item.create")[0]!.item).toEqual({
        type: "function_call_output",
        call_id: "call-1",
        output: '{"ok":true}',
      })
      expect(socket.of("response.create")).toHaveLength(1)
      const types = socket.sent.map((event) => event.type)
      expect(types.indexOf("response.item.create")).toBeLessThan(
        types.indexOf("response.create")
      )
    })

    it("finds a function in the finished run too, and runs it once", async () => {
      backend({ type: "response.output_item.done", item: functionCall() })
      backend({
        type: "response.completed",
        response: { output: [functionCall(), functionCall("call-2")] },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(used.map((tool) => tool.id)).toEqual(["call-1", "call-2"])
      expect(socket.of("response.create")).toHaveLength(1)

      backend({
        type: "response.completed",
        response: { output: [functionCall()] },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(used).toHaveLength(2)
    })

    it("sends nothing after a run with no function", async () => {
      backend({ type: "response.output_item.done", item: { type: "message" } })
      backend({ type: "response.completed", response: { output: [] } })
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.of("response.create")).toEqual([])
    })
  })

  describe("usage", () => {
    let session: VoiceSession
    let reports: Usage[]

    const seconds = () =>
      reports.reduce((sum, report) => sum + (report.seconds ?? 0), 0)

    beforeEach(async () => {
      session = await connect()
      reports = []
      session.onUsage((usage) => reports.push(usage))
    })

    it("counts a session's seconds once, though each report is cumulative", () => {
      socket.receive({ type: "session.usage.updated", usage: { seconds: 10 } })
      socket.receive({ type: "session.usage.updated", usage: { seconds: 25 } })
      socket.receive({ type: "session.usage.updated", usage: { seconds: 25 } })
      expect(seconds()).toBe(25)
    })

    it("takes the final count from the session's close", () => {
      socket.receive({ type: "session.usage.updated", usage: { seconds: 10 } })
      socket.receive({
        type: "session.closed",
        reason: "remote_hangup",
        usage: { seconds: 12 },
      })
      expect(seconds()).toBe(12)
    })

    it("keeps the last count when the socket goes without a close", () => {
      socket.receive({ type: "session.usage.updated", usage: { seconds: 10 } })
      socket.emit("close", 1006, Buffer.from(""))
      expect(seconds()).toBe(10)
      expect(closes).toEqual(["socket closed (1006)"])
    })

    it("reports the backend model's tokens at each run's end", () => {
      backend({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 2_000,
            output_tokens: 500,
            input_tokens_details: { cached_tokens: 1_000 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
      })
      expect(reports).toEqual([
        {
          promptTokens: 2_000,
          responseTokens: 500,
          promptAudioTokens: 0,
          cachedTokens: 1_000,
          responseAudioTokens: 0,
        },
      ])
    })
  })

  describe("transcripts", () => {
    it("passes the agent's words on when they pause", async () => {
      const session = await connect()
      const said: [string, string][] = []
      session.onTranscript((who, text) => said.push([who, text]))
      socket.receive({
        type: "session.output_transcript.delta",
        delta: "Bonjour ",
      })
      vi.advanceTimersByTime(900)
      socket.receive({
        type: "session.output_transcript.delta",
        delta: "Sara",
      })
      vi.advanceTimersByTime(900)
      expect(said).toEqual([])
      vi.advanceTimersByTime(100)
      expect(said).toEqual([["agent", "Bonjour Sara"]])
    })

    it("passes on what was still being said when it closes", async () => {
      const session = await connect()
      const said: string[] = []
      session.onTranscript((_who, text) => said.push(text))
      socket.receive({
        type: "session.output_transcript.delta",
        delta: "Au revoir",
      })
      void session.close()
      expect(said).toEqual(["Au revoir"])
    })
  })

  describe("closing", () => {
    it("waits for its final count before it's closed", async () => {
      const session = await connect()
      const reports: Usage[] = []
      session.onUsage((usage) => reports.push(usage))
      let closed = false
      void Promise.resolve(session.close()).then(() => (closed = true))
      expect(socket.of("session.close")).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(closed).toBe(false)

      socket.receive({ type: "session.closed", usage: { seconds: 30 } })
      await vi.advanceTimersByTimeAsync(0)
      expect(closed).toBe(true)
      expect(reports[0]!.seconds).toBe(30)
      expect(socket.closed).toBe(true)
      expect(closes).toEqual([])
    })

    it("doesn't wait for ever", async () => {
      const session = await connect()
      let closed = false
      void Promise.resolve(session.close()).then(() => (closed = true))
      await vi.advanceTimersByTimeAsync(1_500)
      expect(closed).toBe(true)
      expect(socket.closed).toBe(true)
    })

    it("reports a session OpenAI closed", async () => {
      await connect()
      socket.receive({ type: "session.closed", reason: "expired" })
      expect(closes).toEqual(["expired"])
      expect(socket.closed).toBe(true)
    })

    it("closes on an error, with its code", async () => {
      await connect()
      socket.receive({
        type: "error",
        error: { type: "server_error", code: "overloaded" },
      })
      expect(closes[0]).toContain("overloaded")
    })

    it("goes on after a refused request", async () => {
      await connect()
      socket.receive({
        type: "error",
        error: { type: "invalid_request_error", code: "bad_append" },
      })
      expect(closes).toEqual([])
      expect(socket.closed).toBe(false)
    })
  })
})
