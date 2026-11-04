import type { ReasoningEffort, TextModelId } from "../generation-catalog.js"
import { GenerationError, type MetaRequest, postJson } from "./client.js"

/** Long answers with reasoning take a while; the stream keeps them alive. */
const TIMEOUT_MS = 4 * 60_000

export type TextUsage = {
  /** All input tokens, the cached ones included. */
  input: number
  cached: number
  /** Output tokens, the reasoning included. */
  output: number
}

type StreamEvent = {
  type?: string
  delta?: string
  response?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
    }
    error?: { message?: string; code?: string }
  }
  error?: { message?: string; code?: string }
  message?: string
}

/**
 * Asks a text model for JSON that matches a schema, with images, through the
 * Responses API. The answer is streamed, since a long one without a stream can
 * time out on the provider's side.
 */
export async function generateJson(
  options: MetaRequest & {
    model: TextModelId
    reasoning: ReasoningEffort
    system: string
    user: string
    /** Public https addresses of the images the model looks at. */
    images: readonly string[]
    schema: Record<string, unknown>
  }
): Promise<{ json: unknown; usage: TextUsage }> {
  const response = await postJson(
    options,
    "/responses",
    {
      model: options.model,
      stream: true,
      store: false,
      reasoning: { effort: options.reasoning },
      instructions: options.system,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: options.user },
            ...options.images.map((url) => ({
              type: "input_image",
              image_url: url,
            })),
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "design",
          schema: options.schema,
          strict: true,
        },
      },
    },
    TIMEOUT_MS
  )
  if (!response.body) {
    throw new GenerationError("answered with no body", true)
  }

  let text = ""
  let usage: TextUsage | null = null
  for await (const event of readEvents(response.body)) {
    if (event.type === "response.output_text.delta") {
      text += event.delta ?? ""
    } else if (event.type === "response.completed") {
      const reported = event.response?.usage
      usage = {
        input: reported?.input_tokens ?? 0,
        cached: reported?.input_tokens_details?.cached_tokens ?? 0,
        output: reported?.output_tokens ?? 0,
      }
    } else if (
      event.type === "response.failed" ||
      event.type === "response.incomplete" ||
      event.type === "error"
    ) {
      const error = event.response?.error ?? event.error
      throw new GenerationError(
        `${event.type}: ${error?.message ?? error?.code ?? event.message ?? "no reason given"}`,
        event.type === "error"
      )
    }
  }
  if (!usage) {
    throw new GenerationError("the answer ended before it was complete", true)
  }
  try {
    return { json: JSON.parse(text), usage }
  } catch {
    throw new GenerationError(
      `the answer isn't JSON: ${text.slice(0, 120)}`,
      false
    )
  }
}

/** The JSON events of a server-sent event stream, in order. */
export async function* readEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  let pending = ""
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true })
    let end = pending.indexOf("\n\n")
    while (end !== -1) {
      const event = parseEvent(pending.slice(0, end))
      pending = pending.slice(end + 2)
      if (event) {
        yield event
      }
      end = pending.indexOf("\n\n")
    }
  }
  const last = parseEvent(pending + decoder.decode())
  if (last) {
    yield last
  }
}

function parseEvent(block: string): StreamEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") {
    return null
  }
  try {
    return JSON.parse(data) as StreamEvent
  } catch {
    return null
  }
}
