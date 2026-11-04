import { describe, expect, it, vi } from "vitest"
import {
  DesignRefused,
  generateDesign,
  type GenerationInput,
} from "./generate.js"
import {
  answerChecker,
  designRules,
  designSchemaProblem,
  takeImageRequests,
} from "./generation-schema.js"

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      maxItems: 3,
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "heading", "image"],
            properties: {
              type: { enum: ["banner"] },
              heading: { type: "string", maxLength: 20 },
              image: { type: ["string", "null"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "count"],
            properties: {
              type: { enum: ["products"] },
              count: { type: "integer", minimum: 2, maximum: 8 },
            },
          },
        ],
      },
    },
  },
}

const INPUT: GenerationInput = {
  schema: SCHEMA,
  instructions: "A home page with a banner first.",
  brief: "Linen shirts for summer.",
  photos: ["https://files.example/a.jpg"],
  language: "ar",
  max_generated_images: 2,
}

const VALID = {
  sections: [
    { type: "banner", heading: "قمصان الكتان", image: "generate:wide:linen" },
    { type: "banner", heading: "صيف", image: "generate:tall:sea" },
    { type: "products", count: 4 },
  ],
}

/** A fake of Meta's API: each text request gets the next answer. */
function fakeMeta(answers: unknown[], images: { fail?: boolean } = {}) {
  const bodies: Record<string, any>[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    bodies.push(body)
    if (url.endsWith("/images/generations")) {
      return images.fail
        ? new Response('{"error":{"message":"busy"}}', { status: 503 })
        : new Response(
            JSON.stringify({
              data: [{ b64_json: Buffer.from(body.prompt).toString("base64") }],
            })
          )
    }
    const answer = answers.shift()
    const text = typeof answer === "string" ? answer : JSON.stringify(answer)
    const events = [
      { type: "response.output_text.delta", delta: text },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 10_000,
            output_tokens: 2_000,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
    ]
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    )
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies }
}

describe("generateDesign", () => {
  it("designs, makes the images asked for and adds up the cost", async () => {
    const meta = fakeMeta([VALID])
    const outcome = await generateDesign(INPUT, {
      apiKey: "test-key",
      fetchImpl: meta.fetchImpl,
    })
    expect(outcome.design).toEqual({
      sections: [
        { type: "banner", heading: "قمصان الكتان", image: "generated:0" },
        { type: "banner", heading: "صيف", image: "generated:1" },
        { type: "products", count: 4 },
      ],
    })
    expect(
      outcome.images.map(({ slot, shape, bytes }) => [
        slot,
        shape,
        bytes.toString(),
      ])
    ).toEqual([
      [0, "wide", "linen"],
      [1, "tall", "sea"],
    ])
    expect(outcome.problems).toEqual([])
    // 10,000 at $4 and 2,000 at $20 per million, and 2 images at $0.01.
    expect(outcome.cost).toMatchObject({ usd: 0.1, images: 2 })

    const [text, ...images] = meta.bodies
    expect(text!.instructions).toContain("Modern Standard Arabic")
    expect(text!.instructions).toContain("A home page with a banner first.")
    expect(text!.text.format.schema).toEqual(SCHEMA)
    expect(images.map((body) => body.size).sort()).toEqual([
      "1024x1280",
      "1792x1024",
    ])
  })

  it("asks again with the problems, and keeps the second answer", async () => {
    const broken = {
      sections: [{ type: "products", count: 40 }, { type: "gallery" }],
    }
    const meta = fakeMeta([
      broken,
      { sections: [{ type: "products", count: 8 }] },
    ])
    const outcome = await generateDesign(INPUT, {
      apiKey: "test-key",
      fetchImpl: meta.fetchImpl,
    })
    expect(outcome.design).toEqual({
      sections: [{ type: "products", count: 8 }],
    })
    const retry = meta.bodies[1]!.input[0].content[0].text as string
    expect(retry).toContain("Your previous answer")
    expect(retry).toContain("/sections/0/count must be <= 8")
    expect(outcome.cost.input_tokens).toBe(20_000)
  })

  it("gives up when the second answer still breaks the schema", async () => {
    const broken = { sections: [{ type: "products", count: 40 }] }
    const meta = fakeMeta([broken, broken])
    await expect(
      generateDesign(INPUT, { apiKey: "test-key", fetchImpl: meta.fetchImpl })
    ).rejects.toBeInstanceOf(DesignRefused)
  })

  it("keeps the design when an image can't be made, without it", async () => {
    const meta = fakeMeta([VALID], { fail: true })
    const outcome = await generateDesign(INPUT, {
      apiKey: "test-key",
      fetchImpl: meta.fetchImpl,
    })
    expect(outcome.images).toEqual([])
    expect(
      (outcome.design as typeof VALID).sections.map(
        (s) => "image" in s && s.image
      )
    ).toEqual([null, null, false])
    expect(outcome.problems).toEqual(["2 images could not be made"])
    expect(outcome.cost.images).toBe(0)
  })

  it("makes no more images than allowed", async () => {
    const meta = fakeMeta([VALID])
    const outcome = await generateDesign(
      { ...INPUT, max_generated_images: 1 },
      { apiKey: "test-key", fetchImpl: meta.fetchImpl }
    )
    expect(outcome.images).toHaveLength(1)
    expect(outcome.problems).toEqual([
      "1 image requests were over the limit or unknown",
    ])
  })
})

describe("the schema", () => {
  it.each([
    [null, "the schema must be an object"],
    [[], "the schema must be an object"],
    [{ type: "array" }, 'the schema\'s root must have type "object"'],
  ])("refuses %j", (schema, problem) => {
    expect(designSchemaProblem(schema)).toBe(problem)
  })

  it("refuses one that doesn't compile", () => {
    expect(
      designSchemaProblem({ type: "object", properties: { a: { type: 5 } } })
    ).toContain("doesn't compile")
  })

  it("refuses one that's too large", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 8_000 }, (_, i) => [`field${i}`, { type: "string" }])
    )
    expect(designSchemaProblem({ type: "object", properties })).toContain(
      "over 200000 bytes"
    )
  })

  it("takes a client's schema with descriptions and unknown keywords", () => {
    expect(
      designSchemaProblem({
        type: "object",
        description: "A store",
        "x-note": "kept",
        properties: {},
      })
    ).toBeNull()
  })

  it("names each problem of an answer", () => {
    const check = answerChecker(SCHEMA)
    expect(check(VALID)).toEqual([])
    expect(
      check({ sections: [{ type: "banner", heading: "x".repeat(30) }] })
    ).toContain("/sections/0 must have required property 'image'")
  })
})

describe("takeImageRequests", () => {
  it("leaves photos that exist and drops those that don't", () => {
    const taken = takeImageRequests(
      { a: "photo:0", b: "photo:3", c: "plain text", d: [1, true, null] },
      { photos: 2, maxImages: 4 }
    )
    expect(taken).toEqual({
      design: { a: "photo:0", b: null, c: "plain text", d: [1, true, null] },
      requests: [],
      dropped: 1,
    })
  })

  it("finds requests anywhere, in order", () => {
    const taken = takeImageRequests(
      {
        list: [{ image: "generate:tall:a calm sea" }],
        hero: "generate:wide:x",
      },
      { photos: 0, maxImages: 4 }
    )
    expect(taken.requests).toEqual([
      { slot: 0, shape: "tall", prompt: "a calm sea" },
      { slot: 1, shape: "wide", prompt: "x" },
    ])
  })

  it("isn't fooled by a text that only looks like a request", () => {
    const taken = takeImageRequests(
      { a: "generate:square:x", b: "photo:-1" },
      { photos: 1, maxImages: 4 }
    )
    expect(taken.requests).toEqual([])
    expect(taken.design).toEqual({ a: "generate:square:x", b: "photo:-1" })
  })
})

describe("designRules", () => {
  it("says what can and can't be used", () => {
    const rules = designRules({ language: "fr", photos: 0, maxImages: 0 })
    expect(rules).toContain("in French")
    expect(rules).toContain("The client sent no photos.")
    expect(rules).toContain("No images can be made.")
    expect(rules).toContain("never invent prices")
  })
})
