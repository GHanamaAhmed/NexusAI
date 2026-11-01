import { connectGeminiLive } from "@nexus/ai"
import {
  answerLookup,
  buildInstruction,
  CONFIRMATION_TOOLS,
  type ConfirmationOrder,
  OPENING,
  outcomeForTool,
  placeChange,
  refuseChange,
} from "@nexus/conversation"

/**
 * Scripted conversations with the real instruction and functions, the customer
 * played as text, with no phone:
 *   tsx src/dialogue-test.ts [part of a scenario's name]
 * Checks which functions the agent calls. Each run costs a few cents.
 */

type Called = { name: string; args: Record<string, unknown> }
/** What the call would report, by the same rules as the real call. */
type Result = {
  calls: Called[]
  /** The first outcome function; any later one is ignored. */
  outcome?: Called
  lookups: Record<string, unknown>[]
}
type Scenario = {
  name: string
  customer: string[]
  /** What went wrong, or null. */
  check: (result: Result) => string | null
}

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  throw new Error("Set GEMINI_API_KEY")
}
const SCENARIO_TIMEOUT_MS = 90_000

const order: ConfirmationOrder = {
  store: { name: "متجر الياسمين" },
  customer: { name: "غنامة أحمد", language: "ar" },
  order: {
    items: [
      { title: "قميص قطن", quantity: 2 },
      { title: "صباط رياضي", quantity: 1 },
    ],
    total: 6500,
    delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
  },
}

const lookedUp = ({ calls }: Result) =>
  calls.some((call) => call.name === "find_place")

/** The agent looked the place up and passed it once confirmed. */
const movedTo =
  (wilayaCode: number, communeFr: string) =>
  (result: Result): string | null => {
    if (!lookedUp(result)) {
      return "find_place was never called"
    }
    const { outcome, lookups } = result
    if (outcome?.name !== "request_change") {
      return `the outcome was ${outcome?.name ?? "none"}, not request_change`
    }
    const place = placeChange(outcome.args, lookups)
    return place?.wilaya_code === wilayaCode && place.commune_fr === communeFr
      ? null
      : `request_change got ${JSON.stringify(outcome.args)}`
  }
const aoulef = movedTo(1, "Aoulef")

const SCENARIOS: Scenario[] = [
  {
    name: "plain yes",
    customer: ["إيه أنا", "إيه صحا، بعثوها"],
    check: (result) =>
      result.outcome?.name === "confirm_order" && !lookedUp(result)
        ? null
        : "expected confirm_order and no find_place",
  },
  {
    name: "change, misheard spelling",
    customer: [
      "إيه أنا",
      "حاب نبدل البلدية",
      "ولاية ادرار، بلدية اولاف",
      "إيه صح",
    ],
    check: aoulef,
  },
  {
    name: "change, French spelling",
    customer: [
      "إيه أنا",
      "حاب نبدل البلدية",
      "wilaya Adrar, commune Aoulef",
      "إيه صح",
    ],
    check: aoulef,
  },
  {
    name: "no, then a commune alone",
    customer: ["إيه أنا", "لا لا، بريكة بريكة", "إيه صح", "إيه"],
    check: movedTo(60, "Barika"),
  },
  {
    name: "another place instead of a yes",
    customer: ["إيه أنا", "لا، بلدية الشرقان", "أدرار، رقان", "إيه صح", "إيه"],
    check: ({ outcome, lookups }) => {
      const place = outcome ? placeChange(outcome.args, lookups) : null
      if (outcome?.name !== "request_change") {
        return `the outcome was ${outcome?.name ?? "none"}, not request_change`
      }
      return place === null || place.commune_fr === "Reggane"
        ? null
        : `passed ${JSON.stringify(place)}`
    },
  },
  {
    name: "commune not in the wilaya",
    customer: [
      "إيه أنا",
      "حاب نبدل البلدية",
      "ولاية أدرار، بلدية تسالة",
      "بلدية تسالة",
      "تسالة",
      "ما نعرفش واش نقولك",
    ],
    check: ({ outcome, lookups }) => {
      if (
        outcome?.name !== "request_change" &&
        outcome?.name !== "talk_to_store"
      ) {
        return `expected request_change or talk_to_store, got ${outcome?.name ?? "none"}`
      }
      const place = placeChange(outcome.args, lookups)
      return place ? `passed a place: ${JSON.stringify(place)}` : null
    },
  },
]

async function run(scenario: Scenario): Promise<Result> {
  const result: Result = { calls: [], lookups: [] }
  const session = await connectGeminiLive({
    apiKey: apiKey!,
    voice: process.env.VOICE_AR ?? "Callirrhoe",
    instruction: buildInstruction(order, new Date()),
    tools: CONFIRMATION_TOOLS,
  })
  return new Promise((resolve) => {
    let next = 0
    const done = () => {
      clearTimeout(timer)
      session.close()
      resolve(result)
    }
    const timer = setTimeout(done, SCENARIO_TIMEOUT_MS)
    session.onTranscript((who, text) => console.log(`  ${who}: ${text}`))
    session.onTool(async ({ name, args }) => {
      console.log(`  tool: ${name} ${JSON.stringify(args)}`)
      result.calls.push({ name, args })
      const lookup = answerLookup(name, args, order.customer.language)
      if (lookup) {
        console.log(`  lookup: ${JSON.stringify(lookup)}`)
        result.lookups.push(lookup)
        return lookup
      }
      const refusal =
        name === "request_change" && !result.outcome
          ? refuseChange(args, result.lookups)
          : null
      if (refusal) {
        console.log(`  (refused: ${refusal})`)
        return { error: refusal }
      }
      if (outcomeForTool(name) && !result.outcome) {
        result.outcome = { name, args }
      } else if (outcomeForTool(name)) {
        console.log(`  (ignored ${name}: the outcome is already set)`)
      }
      return { ok: true }
    })
    session.onTurnComplete(() => {
      const reply = result.outcome ? undefined : scenario.customer[next++]
      if (reply) {
        console.log(`  customer: ${reply}`)
        session.start(reply)
      } else {
        done()
      }
    })
    session.start(OPENING)
  })
}

const only = process.argv[2]
const scenarios = SCENARIOS.filter(({ name }) => !only || name.includes(only))
let failed = 0
for (const scenario of scenarios) {
  console.log(`${scenario.name}:`)
  const problem = scenario.check(await run(scenario))
  console.log(
    problem ? `FAIL ${scenario.name}: ${problem}` : `PASS ${scenario.name}`
  )
  if (problem) {
    failed++
  }
}
console.log(`${scenarios.length - failed}/${scenarios.length} passed`)
process.exit(failed ? 1 : 0)
