import type { ConfirmationOrder } from "@nexus/conversation"
import { OUTCOMES, type Outcome } from "@nexus/core"
import type { CallResult } from "./call.js"

/**
 * The volunteer test: each volunteer answers a card of scenarios, one call
 * per scenario, in their own words. A call is right when its outcome is one
 * the scenario expects.
 */

export type Scenario = {
  /** What the volunteer is asked to want, for example "cancel". */
  intent: string
  /** The outcomes that count as right. */
  expect: Outcome[]
  /** The hint the volunteer reads; never sent to the call. */
  say: string
}

export type Card = {
  /** A label for the results, such as "V1"; not their name. */
  volunteer: string
  /** +213XXXXXXXXX */
  phone: string
  /** The name the call greets. */
  name: string
  language: "ar" | "fr"
  scenarios: Scenario[]
}

export type CallRecord = {
  scenario: number
  intent: string
  expect: Outcome[]
  /** null: nobody answered, so the call doesn't count. */
  outcome: Outcome | "none" | null
  args: Record<string, unknown>
  change: unknown
  cause: number | null
  seconds: number
  tokens: { prompt: number; response: number }
  at: string
}

const isOutcome = (value: unknown): value is Outcome =>
  OUTCOMES.includes(value as Outcome)

/** Checks a card read from JSON; throws with what's wrong. */
export function readCard(json: unknown): Card {
  const card = json as Partial<Card>
  const problems: string[] = []
  if (typeof card?.volunteer !== "string" || !card.volunteer) {
    problems.push("volunteer: a label such as V1")
  }
  if (
    typeof card?.phone !== "string" ||
    !/^\+213[567]\d{8}$/.test(card.phone)
  ) {
    problems.push("phone: a mobile number in +213 form")
  }
  if (typeof card?.name !== "string" || !card.name) {
    problems.push("name: the name the call greets")
  }
  if (card?.language !== "ar" && card?.language !== "fr") {
    problems.push("language: ar or fr")
  }
  if (!Array.isArray(card?.scenarios) || card.scenarios.length === 0) {
    problems.push("scenarios: at least one")
  } else {
    card.scenarios.forEach((scenario, index) => {
      const n = index + 1
      if (typeof scenario?.intent !== "string" || !scenario.intent) {
        problems.push(`scenario ${n}: intent`)
      }
      if (
        !Array.isArray(scenario?.expect) ||
        scenario.expect.length === 0 ||
        !scenario.expect.every(isOutcome)
      ) {
        problems.push(
          `scenario ${n}: expect, one or more of ${OUTCOMES.join(", ")}`
        )
      }
      if (typeof scenario?.say !== "string") {
        problems.push(`scenario ${n}: say`)
      }
    })
  }
  if (problems.length > 0) {
    throw new Error(`The card isn't right:\n- ${problems.join("\n- ")}`)
  }
  return card as Card
}

/**
 * Made-up orders, a different one on each call so the volunteer hears
 * different amounts and places. The place is one a change can move from.
 */
const ORDERS: Record<Card["language"], ConfirmationOrder["order"][]> = {
  ar: [
    {
      items: [
        { title: "قميص قطن", quantity: 2 },
        { title: "صباط رياضي", quantity: 1 },
      ],
      total: 6500,
      delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
    },
    {
      items: [{ title: "عطر 100 مل", quantity: 1 }],
      total: 4200,
      delivery: { type: "stop_desk", wilaya_code: 31, commune: "وهران" },
    },
    {
      items: [{ title: "جبة قبائلية", quantity: 1 }],
      total: 8900,
      delivery: { type: "home", wilaya_code: 25, commune: "قسنطينة" },
    },
  ],
  fr: [
    {
      items: [
        { title: "Chemise en coton", quantity: 2 },
        { title: "Baskets", quantity: 1 },
      ],
      total: 6500,
      delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
    },
    {
      items: [{ title: "Parfum 100 ml", quantity: 1 }],
      total: 4200,
      delivery: { type: "stop_desk", wilaya_code: 31, commune: "وهران" },
    },
    {
      items: [{ title: "Robe kabyle", quantity: 1 }],
      total: 8900,
      delivery: { type: "home", wilaya_code: 25, commune: "قسنطينة" },
    },
  ],
}

const STORES: Record<Card["language"], string> = {
  ar: "متجر الياسمين",
  fr: "Boutique Yasmine",
}

/** The order read on call `scenario` (1-based). */
export function orderFor(card: Card, scenario: number): ConfirmationOrder {
  const orders = ORDERS[card.language]
  return {
    store: { name: STORES[card.language] },
    customer: { name: card.name, language: card.language },
    order: orders[(scenario - 1) % orders.length]!,
  }
}

/** What one call gave, for the results file. */
export function recordCall(
  card: Card,
  scenario: number,
  result: CallResult,
  seconds: number,
  at: Date
): CallRecord {
  const { intent, expect } = card.scenarios[scenario - 1]!
  return {
    scenario,
    intent,
    expect,
    outcome: result.answeredAt ? (result.outcome ?? "none") : null,
    args: result.args,
    change: result.change,
    cause: result.cause,
    seconds,
    tokens: {
      prompt: result.usage.promptTokens,
      response: result.usage.responseTokens,
    },
    at: at.toISOString(),
  }
}

export type Verdict = "right" | "wrong" | "not reached"

export function judge(record: CallRecord): Verdict {
  if (record.outcome === null) {
    return "not reached"
  }
  return record.outcome !== "none" && record.expect.includes(record.outcome)
    ? "right"
    : "wrong"
}

/** A yes taken for a no, or a no for a yes: the mistake that costs most. */
export function isSwap(record: CallRecord): boolean {
  const wanted = record.expect
  return (
    (wanted.includes("confirmed") && record.outcome === "cancelled") ||
    (wanted.includes("cancelled") && record.outcome === "confirmed")
  )
}

/** The pass mark, decided before the test (calls plan, phase 7). */
export const PASS_ACCURACY = 0.9
export const MAX_SWAP_SHARE = 0.01

export type Score = {
  answered: number
  right: number
  notReached: number
  swaps: number
  byIntent: { intent: string; answered: number; right: number }[]
  passed: boolean
}

/** Scores calls already narrowed by countedCalls. */
export function score(records: CallRecord[]): Score {
  const answered = records.filter((record) => judge(record) !== "not reached")
  const right = answered.filter((record) => judge(record) === "right")
  const swaps = answered.filter(isSwap).length
  const intents = [...new Set(records.map((record) => record.intent))]
  return {
    answered: answered.length,
    right: right.length,
    notReached: records.length - answered.length,
    swaps,
    byIntent: intents.map((intent) => ({
      intent,
      answered: answered.filter((record) => record.intent === intent).length,
      right: right.filter((record) => record.intent === intent).length,
    })),
    passed:
      answered.length > 0 &&
      right.length / answered.length >= PASS_ACCURACY &&
      swaps <= Math.floor(answered.length * MAX_SWAP_SHARE),
  }
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`

/** The score as a Markdown table: numbers only, no names or numbers. */
export function formatScore(result: Score, volunteers: number): string {
  const rows = result.byIntent.map(
    ({ intent, answered, right }) =>
      `| ${intent} | ${answered} | ${right} | ${percent(right, answered)} |`
  )
  return [
    `Volunteers: ${volunteers}. Answered calls: ${result.answered}; not reached: ${result.notReached}.`,
    "",
    "| Intent | Answered | Right | Accuracy |",
    "| :----- | -------: | ----: | -------: |",
    ...rows,
    `| **All** | ${result.answered} | ${result.right} | ${percent(result.right, result.answered)} |`,
    "",
    `Yes taken for no, or no for yes: ${result.swaps} (at most ${Math.floor(result.answered * MAX_SWAP_SHARE)} allowed).`,
    `Pass mark (${PASS_ACCURACY * 100}% right, at most ${MAX_SWAP_SHARE * 100}% swapped): ${result.passed ? "passed" : "not passed"}.`,
  ].join("\n")
}

/**
 * The call that counts for each scenario: the first one answered. A scenario
 * is called again only when nobody answered, so a second try never hides a
 * wrong answer.
 */
export function countedCalls(records: CallRecord[]): CallRecord[] {
  const counted = new Map<number, CallRecord>()
  for (const record of [...records].sort((a, b) => a.at.localeCompare(b.at))) {
    const kept = counted.get(record.scenario)
    if (!kept || kept.outcome === null) {
      counted.set(record.scenario, record)
    }
  }
  return [...counted.values()].sort((a, b) => a.scenario - b.scenario)
}
