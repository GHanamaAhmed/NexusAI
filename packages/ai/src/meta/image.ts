import type { ImageModelId } from "../generation-catalog.js"
import { GenerationError, type MetaRequest, postJson } from "./client.js"

const TIMEOUT_MS = 2 * 60_000

/** Makes one image from a prompt; the size sets its aspect ratio. */
export async function generateImage(
  options: MetaRequest & {
    model: ImageModelId
    prompt: string
    size: string
  }
): Promise<{ bytes: Buffer; format: "webp" }> {
  const response = await postJson(
    options,
    "/images/generations",
    {
      model: options.model,
      prompt: options.prompt,
      n: 1,
      size: options.size,
      output_format: "webp",
      response_format: "b64_json",
    },
    TIMEOUT_MS
  )
  const body = (await response.json().catch(() => null)) as {
    data?: { b64_json?: string }[]
  } | null
  const encoded = body?.data?.[0]?.b64_json
  if (!encoded) {
    throw new GenerationError("answered with no image", false)
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length === 0) {
    throw new GenerationError("answered with an empty image", false)
  }
  return { bytes, format: "webp" }
}
