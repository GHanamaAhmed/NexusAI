import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
  type ImageModelId,
  type ImageShape,
  imageModel,
  type ReasoningEffort,
  type TextModelId,
  textModel,
} from "./generation-catalog.js"
import { type GenerationCost, generationCost } from "./generation-cost.js"
import {
  answerChecker,
  designRules,
  type GenerationLanguage,
  takeImageRequests,
} from "./generation-schema.js"
import { GenerationError } from "./meta/client.js"
import { generateImage } from "./meta/image.js"
import { generateJson, type TextUsage } from "./meta/text.js"
import { inlinePhotos } from "./photos.js"

export type GenerationInput = {
  schema: Record<string, unknown>
  instructions: string
  brief: string
  photos: readonly string[]
  language: GenerationLanguage
  max_generated_images: number
}

export type GeneratedImage = {
  slot: number
  shape: ImageShape
  format: "webp"
  bytes: Buffer
}

export type GenerationOutcome = {
  design: unknown
  images: GeneratedImage[]
  /** What the client should know: images dropped or not made. */
  problems: string[]
  cost: GenerationCost
}

/** What a design needs from the outside; tests replace each. */
export type GenerateDeps = {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  textModel?: TextModelId
  imageModel?: ImageModelId
  reasoning?: ReasoningEffort
  log?: (line: string) => void
}

/** A design the schema still refuses after the second try. */
export class DesignRefused extends GenerationError {
  constructor(readonly problems: string[]) {
    super(
      `the design broke the schema twice: ${problems.slice(0, 5).join("; ")}`,
      false
    )
  }
}

/**
 * Designs from a client's schema: asks the text model, checks the answer and
 * asks once more with its problems, then makes the images it asked for.
 */
export async function generateDesign(
  input: GenerationInput,
  deps: GenerateDeps
): Promise<GenerationOutcome> {
  const textId = deps.textModel ?? DEFAULT_TEXT_MODEL
  const imageId = deps.imageModel ?? DEFAULT_IMAGE_MODEL
  const request = {
    apiKey: deps.apiKey,
    baseUrl: deps.baseUrl,
    fetchImpl: deps.fetchImpl,
  }
  const system = `${designRules({
    language: input.language,
    photos: input.photos.length,
    maxImages: input.max_generated_images,
  })}\n\n${input.instructions}`
  const check = answerChecker(input.schema)
  const photos = await inlinePhotos(input.photos, deps.fetchImpl)
  const usage: TextUsage[] = []
  const ask = async (user: string) => {
    const answer = await generateJson({
      ...request,
      model: textId,
      reasoning: deps.reasoning ?? textModel(textId).defaultReasoning,
      system,
      user,
      images: photos,
      schema: input.schema,
    })
    usage.push(answer.usage)
    return answer.json
  }

  let design = await ask(input.brief)
  let problems = check(design)
  if (problems.length > 0) {
    deps.log?.(`design broke the schema (${problems.length}); asking again`)
    design = await ask(
      `${input.brief}\n\nYour previous answer:\n${JSON.stringify(design)}\n\nIt broke these rules of the schema:\n- ${problems
        .slice(0, 40)
        .join("\n- ")}\n\nAnswer again, whole, keeping what was right.`
    )
    problems = check(design)
    if (problems.length > 0) {
      throw new DesignRefused(problems)
    }
  }

  const taken = takeImageRequests(design, {
    photos: input.photos.length,
    maxImages: input.max_generated_images,
  })
  const notes: string[] = []
  if (taken.dropped > 0) {
    notes.push(`${taken.dropped} image requests were over the limit or unknown`)
  }
  const sizes = imageModel(imageId).sizes
  const made = await Promise.all(
    taken.requests.map(async (wanted) => {
      try {
        const image = await generateImage({
          ...request,
          model: imageId,
          prompt: wanted.prompt,
          size: sizes[wanted.shape],
        })
        return { slot: wanted.slot, shape: wanted.shape, ...image }
      } catch (error) {
        deps.log?.(`image ${wanted.slot} not made: ${String(error)}`)
        return null
      }
    })
  )
  const images = made.filter((image) => image !== null)
  const missing = new Set(
    taken.requests
      .map((wanted) => wanted.slot)
      .filter((slot) => !images.some((image) => image.slot === slot))
  )
  if (missing.size > 0) {
    notes.push(`${missing.size} images could not be made`)
  }

  return {
    design: missing.size ? withoutSlots(taken.design, missing) : taken.design,
    images,
    problems: notes,
    cost: generationCost({
      usage,
      textModel: textId,
      images: images.length,
      imageModel: imageId,
    }),
  }
}

/** The design with the images that weren't made set to null. */
function withoutSlots(design: unknown, slots: Set<number>): unknown {
  if (typeof design === "string") {
    const slot = /^generated:(\d+)$/.exec(design)
    return slot && slots.has(Number(slot[1])) ? null : design
  }
  if (Array.isArray(design)) {
    return design.map((item) => withoutSlots(item, slots))
  }
  if (design && typeof design === "object") {
    return Object.fromEntries(
      Object.entries(design).map(([key, item]) => [
        key,
        withoutSlots(item, slots),
      ])
    )
  }
  return design
}
