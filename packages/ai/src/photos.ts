import { GenerationError } from "./meta/client.js"

/** The largest photo taken, and all of a generation's photos together. */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024
export const MAX_PHOTOS_BYTES = 16 * 1024 * 1024

const TIMEOUT_MS = 15_000
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/**
 * The client's photos as data addresses. The provider won't download some
 * addresses ("not fetchable by this service"), so NexusAI downloads each one
 * and sends it inline. A photo that can't be taken fails the generation, since
 * the design would point at it.
 */
export async function inlinePhotos(
  photos: readonly string[],
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  let total = 0
  const inlined: string[] = []
  for (const [index, address] of photos.entries()) {
    const refuse = (reason: string) =>
      new GenerationError(`photo ${index} ${reason}`, false)
    if (address.startsWith("data:image/")) {
      inlined.push(address)
      continue
    }
    if (!address.startsWith("https://")) {
      throw refuse("isn't an https address")
    }
    let response: Response
    try {
      response = await fetchImpl(address, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      })
    } catch (error) {
      throw refuse(`couldn't be downloaded: ${String(error).slice(0, 120)}`)
    }
    if (!response.ok) {
      throw refuse(`couldn't be downloaded: ${response.status}`)
    }
    const type = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase()
    if (!IMAGE_TYPES.has(type)) {
      throw refuse(
        `isn't a JPEG, PNG, GIF or WebP image (${type || "no type"})`
      )
    }
    const declared = Number(response.headers.get("content-length") ?? 0)
    if (declared > MAX_PHOTO_BYTES) {
      throw refuse(`is over ${MAX_PHOTO_BYTES} bytes`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_PHOTO_BYTES) {
      throw refuse(`is over ${MAX_PHOTO_BYTES} bytes`)
    }
    total += bytes.length
    if (total > MAX_PHOTOS_BYTES) {
      throw new GenerationError(
        `the photos are over ${MAX_PHOTOS_BYTES} bytes together`,
        false
      )
    }
    inlined.push(`data:${type};base64,${bytes.toString("base64")}`)
  }
  return inlined
}
