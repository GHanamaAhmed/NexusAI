import { readFile } from "node:fs/promises"
import {
  type CallRecord,
  countedCalls,
  formatScore,
  score,
} from "./volunteers.js"

/**
 * Scores the whole volunteer test against the pass mark:
 *   tsx src/volunteer-score.ts <card>.results.json...
 * Prints a Markdown table of numbers only, for docs/benchmark.md.
 */

const files = process.argv.slice(2)
if (files.length === 0) {
  throw new Error("Usage: volunteer-score.ts <card>.results.json...")
}
const counted: CallRecord[] = []
for (const file of files) {
  const records: CallRecord[] = JSON.parse(await readFile(file, "utf8"))
  counted.push(...countedCalls(records))
}
console.log(formatScore(score(counted), files.length))
