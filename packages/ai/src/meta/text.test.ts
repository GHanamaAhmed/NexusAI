import { describe, expect, it, vi } from "vitest"
import { GenerationError } from "./client.js"
import { generateJson, readEvents } from "./text.js"

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
}

/** Server-sent events, cut into chunks wherever `cuts` says. */
function stream(events: object[], cuts: number[] = []) {
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
  const bytes = new TextEncoder().encode(text)
  const bounds = [0, ...cuts.filter((cut) => cut < bytes.length), bytes.length]
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bounds.length - 1; i++) {
        controller.enqueue(bytes.slice(bounds[i], bounds[i + 1]))
      }
      controller.close()
    },
  })
}

const completed = {
  type: "response.completed",
  response: {
    usage: {
      input_tokens: 21_000,
      output_tokens: 9_000,
      input_tokens_details: { cached_tokens: 3_000 },
    },
  },
}

const answering = (events: object[], cuts?: number[]) =>
  vi.fn(async () => new Response(stream(events, cuts), { status: 200 }))

const ask = (fetchImpl: typeof fetch) =>
  generateJson({
    apiKey: "test-key",
    baseUrl: "https://meta.example",
    fetchImpl,
    model: "muse-wonder-1.0",
    reasoning: "low",
    system: "Design a store.",
    user: "A shop of linen shirts.",
    images: ["https://files.example/a.jpg", "https://files.example/b.webp"],
    schema: SCHEMA,
  })

describe("generateJson", () => {
  it("asks with the model, reasoning, schema and images, streamed", async () => {
    const fetchImpl = answering([
      { type: "response.output_text.delta", delta: '{"title":' },
      { type: "response.output_text.delta", delta: '"Lin"}' },
      completed,
    ])
    await ask(fetchImpl as unknown as typeof fetch)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe("https://meta.example/responses")
    expect(init.headers).toMatchObject({ authorization: "Bearer test-key" })
    expect(JSON.parse(init.body as string)).toEqual({
      model: "muse-wonder-1.0",
      stream: true,
      store: false,
      reasoning: { effort: "low" },
      instructions: "Design a store.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "A shop of linen shirts." },
            { type: "input_image", image_url: "https://files.example/a.jpg" },
            { type: "input_image", image_url: "https://files.example/b.webp" },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "design",
          schema: SCHEMA,
          strict: true,
        },
      },
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("joins the streamed text and reads the usage", async () => {
    const result = await ask(
      answering([
        { type: "response.created" },
        { type: "response.output_text.delta", delta: '{"title":' },
        { type: "response.output_text.delta", delta: '"Lin"}' },
        completed,
      ]) as unknown as typeof fetch
    )
    expect(result).toEqual({
      json: { title: "Lin" },
      usage: { input: 21_000, cached: 3_000, output: 9_000 },
    })
  })

  it("reads events cut anywhere across chunks", async () => {
    const events = [
      { type: "response.output_text.delta", delta: '{"title":"شمس"}' },
      completed,
    ]
    for (const cuts of [[3], [10, 11, 12], [40], [1, 2, 3, 4, 5, 60, 90]]) {
      const result = await ask(
        answering(events, cuts) as unknown as typeof fetch
      )
      expect(result.json).toEqual({ title: "شمس" })
    }
  })

  it("fails on a failed response, not worth retrying", async () => {
    const result = ask(
      answering([
        {
          type: "response.failed",
          response: { error: { message: "schema too deep" } },
        },
      ]) as unknown as typeof fetch
    )
    await expect(result).rejects.toEqual(
      new GenerationError("response.failed: schema too deep", false)
    )
  })

  it("fails on an error event, worth retrying", async () => {
    const result = ask(
      answering([
        { type: "error", error: { code: "server_error" } },
      ]) as unknown as typeof fetch
    )
    await expect(result).rejects.toMatchObject({ retryable: true })
  })

  it("fails when the stream ends before the response does", async () => {
    const result = ask(
      answering([
        { type: "response.output_text.delta", delta: '{"title":"Lin"}' },
      ]) as unknown as typeof fetch
    )
    await expect(result).rejects.toMatchObject({
      message: "the answer ended before it was complete",
      retryable: true,
    })
  })

  it("fails on text that isn't JSON", async () => {
    const result = ask(
      answering([
        { type: "response.output_text.delta", delta: "Here is a design:" },
        completed,
      ]) as unknown as typeof fetch
    )
    await expect(result).rejects.toMatchObject({
      message: "the answer isn't JSON: Here is a design:",
      retryable: false,
    })
  })

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
  ])("marks HTTP %d as retryable: %s", async (status, retryable) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "nope" } }), {
          status,
        })
    )
    await expect(ask(fetchImpl as unknown as typeof fetch)).rejects.toEqual(
      new GenerationError(`answered ${status}: nope`, retryable)
    )
  })

  it("reports no answer as worth retrying", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset")
    })
    await expect(
      ask(fetchImpl as unknown as typeof fetch)
    ).rejects.toMatchObject({ retryable: true })
  })
})

describe("readEvents", () => {
  it("skips comments, the end marker and data that isn't JSON", async () => {
    const text =
      ': keep-alive\n\ndata: [DONE]\n\ndata: {oops\n\nevent: x\ndata: {"type":"a"}\n\n'
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    })
    const events = []
    for await (const event of readEvents(body)) {
      events.push(event)
    }
    expect(events).toEqual([{ type: "a" }])
  })
})
