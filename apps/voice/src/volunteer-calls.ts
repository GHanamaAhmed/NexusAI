import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { checkTestNumber, openTestLine } from "./test-line.js"
import {
  type CallRecord,
  countedCalls,
  formatScore,
  judge,
  orderFor,
  readCard,
  recordCall,
  score,
} from "./volunteers.js"

/**
 * Calls one volunteer through their card, one scenario per call:
 *   tsx src/volunteer-calls.ts <card.json> [line] [scenarios, e.g. 3,7]
 * Each call's result is added to <card>.results.json as soon as it ends; a
 * scenario nobody answered can be called again by number. What was said is
 * printed only with SHOW_WORDS=1. PAUSE_SECONDS (60) separates the calls.
 */

const [cardPath = "", line = "line01", only] = process.argv.slice(2)
if (!cardPath.endsWith(".json")) {
  throw new Error(
    "Usage: volunteer-calls.ts <card.json> [line] [scenarios, e.g. 3,7]"
  )
}
const card = readCard(JSON.parse(await readFile(cardPath, "utf8")))
checkTestNumber(card.phone)

const total = card.scenarios.length
const scenarios = only
  ? only.split(",").map((n) => Number(n.trim()))
  : card.scenarios.map((_, index) => index + 1)
if (scenarios.some((n) => !Number.isInteger(n) || n < 1 || n > total)) {
  throw new Error(`Scenarios are numbered 1 to ${total}`)
}
const pauseMs = Number(process.env.PAUSE_SECONDS ?? 60) * 1000
const showWords = process.env.SHOW_WORDS === "1"

const resultsPath = cardPath.replace(/\.json$/, ".results.json")
const records: CallRecord[] = existsSync(resultsPath)
  ? JSON.parse(await readFile(resultsPath, "utf8"))
  : []

const testLine = await openTestLine()
for (const [index, n] of scenarios.entries()) {
  if (index > 0) {
    console.log(`Next call in ${pauseMs / 1000} s: scenario ${n}`)
    await sleep(pauseMs)
  }
  const { intent } = card.scenarios[n - 1]!
  console.log(`Call for scenario ${n} of ${total} (${intent})`)
  const started = Date.now()
  try {
    const result = await testLine.call({
      phone: card.phone,
      line,
      order: orderFor(card, n),
      log: (text) => {
        if (showWords || !/ (agent|customer): /.test(text)) {
          console.log(`  ${text}`)
        }
      },
    })
    const record = recordCall(
      card,
      n,
      result,
      Math.round((Date.now() - started) / 1000),
      new Date()
    )
    records.push(record)
    await writeFile(resultsPath, JSON.stringify(records, null, 2))
    console.log(`  ${record.outcome ?? "not answered"}: ${judge(record)}`)
  } catch (error) {
    console.error(`  The call failed: ${String(error)}`)
  }
}
testLine.close()

const counted = countedCalls(records)
const missing = counted
  .filter((record) => judge(record) === "not reached")
  .map((record) => record.scenario)
console.log(`\n${formatScore(score(counted), 1)}`)
if (missing.length > 0) {
  console.log(`\nNot answered yet: ${missing.join(",")}`)
}
process.exit(0)
