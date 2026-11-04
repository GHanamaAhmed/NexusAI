import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  designSchemaProblem,
  generateDesign,
  type GenerationInput,
  type ReasoningEffort,
} from "@nexus/ai/generation"

/**
 * One generation with a real key, outside the queue:
 *   tsx src/generation-test.ts <input.json> <output folder> [reasoning]
 * The input holds what a client sends: schema, instructions, brief, photos,
 * language and max_generated_images. Prints the time, the cost and what the
 * design holds, and writes the design and its images to the folder.
 */
const [inputPath, outputDir, reasoning] = process.argv.slice(2)
if (!inputPath || !outputDir) {
  throw new Error(
    "Usage: generation-test.ts <input.json> <output folder> [reasoning]"
  )
}
const apiKey = process.env.META_API_KEY
if (!apiKey) {
  throw new Error("Set META_API_KEY")
}

const input = JSON.parse(await readFile(inputPath, "utf8")) as GenerationInput
const problem = designSchemaProblem(input.schema)
if (problem) {
  throw new Error(`The input's schema can't be used: ${problem}`)
}

const started = Date.now()
try {
  const outcome = await generateDesign(input, {
    apiKey,
    baseUrl: process.env.META_API_URL || undefined,
    reasoning: reasoning as ReasoningEffort | undefined,
    log: (line) => console.log(`  ${line}`),
  })
  const seconds = Math.round((Date.now() - started) / 1000)
  await mkdir(outputDir, { recursive: true })
  await writeFile(
    join(outputDir, "design.json"),
    JSON.stringify(outcome.design, null, 2)
  )
  for (const image of outcome.images) {
    await writeFile(
      join(outputDir, `image-${image.slot}-${image.shape}.${image.format}`),
      image.bytes
    )
  }
  console.log(`done in ${seconds} s`)
  console.log(`cost: ${JSON.stringify(outcome.cost)}`)
  console.log(`problems: ${outcome.problems.join("; ") || "none"}`)
  console.log(`holds: ${JSON.stringify(shape(outcome.design))}`)
} catch (error) {
  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(`failed after ${seconds} s: ${String(error)}`)
  process.exitCode = 1
}

/** Each array's length and each object's keys, to see a design at a glance. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return `${value.length} items`
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shape(item)])
    )
  }
  return typeof value
}
