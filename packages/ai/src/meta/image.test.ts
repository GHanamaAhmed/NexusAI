import { describe, expect, it, vi } from "vitest"
import { GenerationError } from "./client.js"
import { generateImage } from "./image.js"

const make = (fetchImpl: typeof fetch) =>
  generateImage({
    apiKey: "test-key",
    baseUrl: "https://meta.example",
    fetchImpl,
    model: "muse-image-1.0",
    prompt: "Linen shirts on a sunny terrace, no text",
    size: "1792x1024",
  })

const answering = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe("generateImage", () => {
  it("asks for one webp image of the size, as base64", async () => {
    const pixels = Buffer.from("not really webp")
    const fetchImpl = answering(200, {
      data: [{ b64_json: pixels.toString("base64") }],
    })
    const image = await make(fetchImpl as unknown as typeof fetch)
    expect(image).toEqual({ bytes: pixels, format: "webp" })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe("https://meta.example/images/generations")
    expect(init.headers).toMatchObject({ authorization: "Bearer test-key" })
    expect(JSON.parse(init.body as string)).toEqual({
      model: "muse-image-1.0",
      prompt: "Linen shirts on a sunny terrace, no text",
      n: 1,
      size: "1792x1024",
      output_format: "webp",
      response_format: "b64_json",
    })
  })

  it.each([
    [{}],
    [{ data: [] }],
    [{ data: [{ url: "https://x" }] }],
    [{ data: [{ b64_json: "" }] }],
  ])("fails on an answer with no image: %j", async (body) => {
    await expect(
      make(answering(200, body) as unknown as typeof fetch)
    ).rejects.toMatchObject({ retryable: false })
  })

  it("marks an outage as worth retrying", async () => {
    await expect(
      make(
        answering(503, {
          error: { message: "busy" },
        }) as unknown as typeof fetch
      )
    ).rejects.toEqual(new GenerationError("answered 503: busy", true))
  })
})
