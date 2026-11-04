import { Ajv, type ErrorObject } from "ajv"
import type { ImageShape } from "./generation-catalog.js"

/** The largest design schema a client may send. */
export const MAX_SCHEMA_BYTES = 200_000

export type GenerationLanguage = "ar" | "fr"

/**
 * Why a client's design schema can't be used, or null. The root must be a
 * plain object, as the provider's strict mode requires, and it must compile.
 */
export function designSchemaProblem(schema: unknown): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "the schema must be an object"
  }
  const root = schema as Record<string, unknown>
  if (root.type !== "object") {
    return 'the schema\'s root must have type "object"'
  }
  if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
    return `the schema is over ${MAX_SCHEMA_BYTES} bytes`
  }
  try {
    newAjv().compile(root)
  } catch (error) {
    return `the schema doesn't compile: ${String(error).slice(0, 200)}`
  }
  return null
}

/**
 * A check of answers against a design schema, listing each problem in words a
 * model can act on. The provider doesn't say which keywords it enforces, so
 * every answer is checked here.
 */
export function answerChecker(
  schema: Record<string, unknown>
): (answer: unknown) => string[] {
  const validate = newAjv().compile(schema)
  return (answer) =>
    validate(answer) ? [] : (validate.errors ?? []).map(describeError)
}

function newAjv() {
  // Clients' schemas may carry descriptions and keywords the checker doesn't
  // know; they're kept, not refused.
  return new Ajv({ allErrors: true, strict: false })
}

function describeError(error: ErrorObject): string {
  const at = error.instancePath || "the root"
  const extra =
    "allowedValues" in error.params
      ? `: ${JSON.stringify(error.params.allowedValues).slice(0, 200)}`
      : ""
  return `${at} ${error.message ?? "is invalid"}${extra}`
}

export type ImageRequest = { slot: number; shape: ImageShape; prompt: string }

const GENERATE = /^generate:(wide|tall):([\s\S]+)$/
const PHOTO = /^photo:(\d+)$/

/**
 * The images a design asks for, with each request replaced by
 * `generated:<slot>`. Requests beyond the limit, and photos the client didn't
 * send, become null.
 */
export function takeImageRequests(
  design: unknown,
  options: { photos: number; maxImages: number }
): { design: unknown; requests: ImageRequest[]; dropped: number } {
  const requests: ImageRequest[] = []
  let dropped = 0
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const generate = GENERATE.exec(value)
      if (generate) {
        if (requests.length >= options.maxImages) {
          dropped++
          return null
        }
        const slot = requests.length
        requests.push({
          slot,
          shape: generate[1] as ImageShape,
          prompt: generate[2]!.trim(),
        })
        return `generated:${slot}`
      }
      const photo = PHOTO.exec(value)
      if (photo && Number(photo[1]) >= options.photos) {
        dropped++
        return null
      }
      return value
    }
    if (Array.isArray(value)) {
      return value.map(visit)
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item)])
      )
    }
    return value
  }
  return { design: visit(design), requests, dropped }
}

const LANGUAGE_NAMES: Record<GenerationLanguage, string> = {
  ar: "Modern Standard Arabic",
  fr: "French",
}

/**
 * NexusAI's own rules for every design, before the client's instructions.
 */
export function designRules(options: {
  language: GenerationLanguage
  photos: number
  maxImages: number
}): string {
  const photos =
    options.photos > 0
      ? `The client sent ${options.photos} photos, numbered from 0 in the order given. Use one with "photo:<number>".`
      : "The client sent no photos."
  const generated =
    options.maxImages > 0
      ? `To have an image made, write "generate:wide:<description>" for a wide one or "generate:tall:<description>" for a tall one. Describe the scene in English, with no words, letters, logos or prices in the picture. At most ${options.maxImages} images can be made; more are dropped.`
      : "No images can be made."
  return `You design an online store: its look, and the sections of its pages, from the parts the schema allows and nothing else.

Write every text the shopper reads in ${LANGUAGE_NAMES[options.language]}. Keep it short, concrete and true to what the client wrote: never invent prices, discounts, delivery times, guarantees, reviews, awards or contact details.

Every value you give must be one the schema allows. Where the schema lists the allowed values, use one of them exactly.

Images: a field that holds an image takes a string. ${photos} ${generated} Use null when a field needs no image.

Answer with the JSON only.`
}
