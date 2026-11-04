import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolCall, Usage, VoiceSession } from "../index.js"
import { defaultModelSettings } from "../settings.js"
import { audioOf, FakeSocket } from "./fake-socket.js"
import { connectOpenAIRealtime, type RealtimeOptions } from "./realtime.js"

const TOOL = {
  name: "confirm_order",
  description: "The customer confirmed.",
  parameters: {
    properties: { yes: { type: "string", description: "Their words" } },
    required: ["yes"],
  },
} as const

describe("OpenAI Realtime", () => {
  let socket: FakeSocket
  let url: string
  let apiKey: string
  let closes: string[]

  const options = (
    overrides: Partial<RealtimeOptions> = {}
  ): RealtimeOptions => ({
    apiKey: "test-key",
    model: "gpt-realtime-2.1",
    voice: "marin",
    instruction: "Be brief.",
    tools: [{ ...TOOL, parameters: { ...TOOL.parameters, required: ["yes"] } }],
    settings: defaultModelSettings("gpt-realtime-2.1"),
    onClose: (reason) => closes.push(reason),
    openSocket: (address, key) => {
      url = address
      apiKey = key
      return socket.asSocket()
    },
    ...overrides,
  })

  /** A session OpenAI has taken the settings of. */
  async function connect(
    overrides?: Partial<RealtimeOptions>
  ): Promise<VoiceSession> {
    const session = connectOpenAIRealtime(options(overrides))
    socket.receive({ type: "session.created" })
    socket.receive({ type: "session.updated" })
    return session
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-04T10:00:00Z"))
    socket = new FakeSocket()
    closes = []
  })
  afterEach(() => vi.useRealTimers())

  describe("opening", () => {
    it("connects with the model and the key", async () => {
      await connect({ model: "gpt-realtime-2.1-mini" })
      expect(url).toBe(
        "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini"
      )
      expect(apiKey).toBe("test-key")
    })

    it("sends the session's settings once OpenAI is ready", async () => {
      void connectOpenAIRealtime(options())
      expect(socket.sent).toEqual([])
      socket.receive({ type: "session.created" })
      expect(socket.of("session.update")[0]!.session).toEqual({
        type: "realtime",
        instructions: "Be brief.",
        output_modalities: ["audio"],
        reasoning: { effort: "low" },
        tool_choice: "auto",
        tools: [
          {
            type: "function",
            name: "confirm_order",
            description: "The customer confirmed.",
            parameters: {
              type: "object",
              properties: {
                yes: { type: "string", description: "Their words" },
              },
              required: ["yes"],
            },
          },
        ],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            noise_reduction: null,
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            voice: "marin",
            speed: 1,
          },
        },
      })
    })

    it("sends semantic turn detection and noise reduction when set", async () => {
      await connect({
        settings: {
          ...defaultModelSettings("gpt-realtime-2.1"),
          vad: "semantic_vad",
          eagerness: "high",
          noise_reduction: "near_field",
        },
      })
      const { input } = socket.of("session.update")[0]!.session.audio
      expect(input.turn_detection).toEqual({
        type: "semantic_vad",
        eagerness: "high",
        create_response: true,
        interrupt_response: true,
      })
      expect(input.noise_reduction).toEqual({ type: "near_field" })
    })

    it("isn't connected until the settings are taken", async () => {
      let connected = false
      void connectOpenAIRealtime(options()).then(() => (connected = true))
      socket.receive({ type: "session.created" })
      await vi.advanceTimersByTimeAsync(1)
      expect(connected).toBe(false)
      socket.receive({ type: "session.updated" })
      await vi.advanceTimersByTimeAsync(1)
      expect(connected).toBe(true)
    })

    it("fails when the settings are refused", async () => {
      const session = connectOpenAIRealtime(options())
      socket.receive({ type: "session.created" })
      socket.receive({
        type: "error",
        error: { type: "invalid_request_error", code: "invalid_value" },
      })
      await expect(session).rejects.toThrow("invalid_value")
      expect(socket.closed).toBe(true)
      expect(closes).toEqual([])
    })

    it("fails when the socket can't connect", async () => {
      const session = connectOpenAIRealtime(options())
      socket.emit("error", new Error("Unexpected server response: 401"))
      await expect(session).rejects.toThrow("401")
    })

    it("fails when no session comes in time", async () => {
      const session = connectOpenAIRealtime(options())
      const failed = expect(session).rejects.toThrow("no session in time")
      await vi.advanceTimersByTimeAsync(10_000)
      await failed
      expect(socket.closed).toBe(true)
    })
  })

  describe("audio", () => {
    it("sends audio at 24 kHz as it is", async () => {
      const session = await connect()
      const pcm = Buffer.alloc(960, 1)
      session.sendAudio(pcm, 24_000)
      expect(socket.of("input_audio_buffer.append")).toEqual([
        {
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64"),
        },
      ])
    })

    it("resamples other rates", async () => {
      const session = await connect()
      session.sendAudio(Buffer.alloc(320), 8_000)
      const [{ audio }] = socket.of("input_audio_buffer.append") as [
        { audio: string },
      ]
      expect(Buffer.from(audio, "base64")).toHaveLength(960)
    })

    it("passes on what it receives", async () => {
      const session = await connect()
      const heard: Buffer[] = []
      session.onAudio((pcm) => heard.push(pcm))
      socket.receive({
        type: "response.output_audio.delta",
        item_id: "item-1",
        content_index: 0,
        delta: audioOf(480),
      })
      expect(heard).toHaveLength(1)
      expect(heard[0]).toHaveLength(480)
    })
  })

  describe("the customer speaking", () => {
    let session: VoiceSession
    let interrupted: number
    let heard: Buffer[]

    const play = (bytes: number, itemId = "item-1") =>
      socket.receive({
        type: "response.output_audio.delta",
        item_id: itemId,
        content_index: 0,
        delta: audioOf(bytes),
      })
    const speak = () =>
      socket.receive({ type: "input_audio_buffer.speech_started" })

    beforeEach(async () => {
      session = await connect()
      interrupted = 0
      heard = []
      session.onInterrupted(() => interrupted++)
      session.onAudio((pcm) => heard.push(pcm))
    })

    it("cuts off the audio still playing, at what was heard", () => {
      play(48 * 5_000) // 5 s of audio
      vi.advanceTimersByTime(1_200)
      speak()
      expect(interrupted).toBe(1)
      expect(socket.of("conversation.item.truncate")).toEqual([
        {
          type: "conversation.item.truncate",
          item_id: "item-1",
          content_index: 0,
          audio_end_ms: 1_200,
        },
      ])
    })

    it("leaves audio that has played to its end", () => {
      play(48 * 1_000)
      vi.advanceTimersByTime(1_000)
      speak()
      expect(interrupted).toBe(0)
      expect(socket.of("conversation.item.truncate")).toEqual([])
    })

    it("does nothing while no audio has played", () => {
      speak()
      expect(interrupted).toBe(0)
      expect(socket.of("conversation.item.truncate")).toEqual([])
    })

    it("cuts off once, whatever else they say", () => {
      play(48 * 5_000)
      speak()
      speak()
      expect(interrupted).toBe(1)
    })

    it("drops what still arrives of the answer it cut off, and takes the next", () => {
      play(48 * 5_000)
      speak()
      const before = heard.length
      play(480)
      expect(heard).toHaveLength(before)
      play(480, "item-2")
      expect(heard).toHaveLength(before + 1)
    })
  })

  describe("functions", () => {
    let session: VoiceSession
    let used: ToolCall[]
    let turns: number

    const done = (output: object[], status = "completed") =>
      socket.receive({
        type: "response.done",
        response: { status, output },
      })
    const call = (name = "confirm_order", args = '{"yes":"ih"}') => ({
      type: "function_call",
      call_id: "call-1",
      name,
      arguments: args,
      status: "completed",
    })

    beforeEach(async () => {
      session = await connect()
      used = []
      turns = 0
      session.onTool(async (tool) => {
        used.push(tool)
        return { ok: true }
      })
      session.onTurnComplete(() => turns++)
    })

    it("runs a function, answers it and goes on", async () => {
      done([call()])
      await vi.advanceTimersByTimeAsync(0)
      expect(used).toEqual([
        { id: "call-1", name: "confirm_order", args: { yes: "ih" } },
      ])
      const types = socket.sent.map((event) => event.type)
      expect(types.slice(-2)).toEqual([
        "conversation.item.create",
        "response.create",
      ])
      expect(socket.of("conversation.item.create").at(-1)!.item).toEqual({
        type: "function_call_output",
        call_id: "call-1",
        output: '{"ok":true}',
      })
      expect(turns).toBe(0)
    })

    it("answers every function of a response, then goes on once", async () => {
      done([call(), { ...call("find_place"), call_id: "call-2" }])
      await vi.advanceTimersByTimeAsync(0)
      expect(used.map((tool) => tool.id)).toEqual(["call-1", "call-2"])
      expect(socket.of("response.create")).toHaveLength(1)
    })

    it("passes empty arguments when they can't be read", async () => {
      done([call("confirm_order", "{not json")])
      await vi.advanceTimersByTimeAsync(0)
      expect(used[0]!.args).toEqual({})
    })

    it("skips a function call that didn't finish", async () => {
      done([{ ...call(), status: "incomplete" }], "cancelled")
      await vi.advanceTimersByTimeAsync(0)
      expect(used).toEqual([])
    })

    it("ends the turn on a response with no function", () => {
      done([{ type: "message" }])
      expect(turns).toBe(1)
    })

    it("doesn't end the turn on a response the customer cut off", () => {
      done([{ type: "message" }], "cancelled")
      expect(turns).toBe(0)
    })

    it("waits its turn when a response is running", async () => {
      socket.receive({ type: "response.created" })
      done([call()])
      socket.receive({ type: "response.created" })
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.of("response.create")).toHaveLength(0)
      done([{ type: "message" }])
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.of("response.create")).toHaveLength(1)
    })
  })

  describe("speaking first and being told", () => {
    it("starts the conversation with the customer's words", async () => {
      const session = await connect()
      session.start("Allô ?")
      expect(socket.sent.slice(-2)).toEqual([
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Allô ?" }],
          },
        },
        { type: "response.create" },
      ])
    })

    it("tells the model what to do as the system", async () => {
      const session = await connect()
      session.instruct("Time is up.")
      expect(socket.of("conversation.item.create")[0]!.item).toMatchObject({
        role: "system",
        content: [{ type: "input_text", text: "Time is up." }],
      })
      expect(socket.of("response.cancel")).toEqual([])
      expect(socket.of("response.create")).toHaveLength(1)
    })

    it("cancels the answer in progress first, and goes on after it", async () => {
      const session = await connect()
      socket.receive({ type: "response.created" })
      session.instruct("Time is up.")
      expect(socket.of("response.cancel")).toHaveLength(1)
      expect(socket.of("response.create")).toHaveLength(0)

      socket.receive({
        type: "response.done",
        response: { status: "cancelled", output: [] },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.of("response.create")).toHaveLength(1)
    })
  })

  describe("reports", () => {
    it("passes the agent's words on, whole", async () => {
      const session = await connect()
      const said: [string, string][] = []
      session.onTranscript((who, text) => said.push([who, text]))
      socket.receive({
        type: "response.output_audio_transcript.done",
        transcript: " Bonjour Sara ",
      })
      expect(said).toEqual([["agent", "Bonjour Sara"]])
    })

    it("reports each response's tokens", async () => {
      const session = await connect()
      const reports: Usage[] = []
      session.onUsage((usage) => reports.push(usage))
      socket.receive({
        type: "response.done",
        response: {
          status: "completed",
          output: [],
          usage: {
            input_tokens: 3_000,
            output_tokens: 1_100,
            input_token_details: {
              audio_tokens: 2_000,
              text_tokens: 1_000,
              cached_tokens: 900,
              cached_tokens_details: { audio_tokens: 500, text_tokens: 400 },
            },
            output_token_details: { audio_tokens: 1_000, text_tokens: 100 },
          },
        },
      })
      expect(reports).toEqual([
        {
          promptTokens: 3_000,
          responseTokens: 1_100,
          promptAudioTokens: 2_000,
          cachedTokens: 900,
          cachedAudioTokens: 500,
          responseAudioTokens: 1_000,
        },
      ])
    })
  })

  describe("errors and closing", () => {
    it("closes on an error, with its code", async () => {
      await connect()
      socket.receive({
        type: "error",
        error: { type: "server_error", code: "overloaded", message: "Later" },
      })
      expect(socket.closed).toBe(true)
      expect(closes[0]).toContain("server_error: overloaded")
    })

    it("goes on after a refused request", async () => {
      const lines: string[] = []
      await connect({ log: (line) => lines.push(line) })
      socket.receive({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "conversation_already_has_active_response",
        },
      })
      expect(socket.closed).toBe(false)
      expect(closes).toEqual([])
      expect(lines[0]).toContain("conversation_already_has_active_response")
    })

    it("closes on a response that failed", async () => {
      await connect()
      socket.receive({
        type: "response.done",
        response: {
          status: "failed",
          status_details: { error: { code: "rate_limit_exceeded" } },
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.closed).toBe(true)
      expect(closes[0]).toContain("rate_limit_exceeded")
    })

    it("reports a socket that closed, once", async () => {
      await connect()
      socket.emit("close", 1006, Buffer.from(""))
      socket.emit("close", 1006, Buffer.from(""))
      expect(closes).toEqual(["socket closed (1006)"])
    })

    it("sends nothing once closed, and doesn't report it as a failure", async () => {
      const session = await connect()
      void session.close()
      const sent = socket.sent.length
      session.sendAudio(Buffer.alloc(960), 24_000)
      expect(socket.sent).toHaveLength(sent)
      socket.emit("close", 1000, Buffer.from(""))
      expect(closes).toEqual([])
    })
  })
})
