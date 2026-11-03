import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { CallResult } from "./call.js"
import {
  type Card,
  type CallRecord,
  countedCalls,
  formatScore,
  isSwap,
  judge,
  orderFor,
  readCard,
  recordCall,
  score,
} from "./volunteers.js"

const example = JSON.parse(
  readFileSync(
    new URL("../volunteer-card.example.json", import.meta.url),
    "utf8"
  )
)
const card: Card = { ...example, phone: "+213550000000" }

const record = (
  scenario: number,
  expect: CallRecord["expect"],
  outcome: CallRecord["outcome"],
  intent = "confirm",
  at = `2026-11-10T10:${String(scenario).padStart(2, "0")}:00Z`
): CallRecord => ({
  scenario,
  intent,
  expect,
  outcome,
  args: {},
  change: null,
  cause: 16,
  seconds: 30,
  tokens: { prompt: 0, response: 0 },
  at,
})

describe("readCard", () => {
  it("takes the example once it has a real number", () => {
    expect(readCard(card).scenarios).toHaveLength(12)
  })

  it("refuses the example as it is: the number is a placeholder", () => {
    expect(() => readCard(example)).toThrow(/phone/)
  })

  it("names every problem", () => {
    const wrong = {
      ...card,
      language: "en",
      scenarios: [{ intent: "confirm", expect: ["yes"], say: "" }],
    }
    expect(() => readCard(wrong)).toThrow(
      /language: ar or fr[\s\S]*scenario 1: expect/
    )
  })
})

describe("orderFor", () => {
  it("greets the volunteer in their language and changes order each call", () => {
    const first = orderFor(card, 1)
    expect(first.customer).toEqual({ name: card.name, language: "ar" })
    expect(orderFor(card, 2).order.total).not.toBe(first.order.total)
    expect(orderFor(card, 4).order).toEqual(first.order)
  })
})

describe("recordCall", () => {
  const result = (answered: boolean, outcome: CallResult["outcome"]) =>
    ({
      outcome,
      args: { yes: "إيه" },
      change: null,
      cause: answered ? 16 : 19,
      answeredAt: answered ? new Date() : null,
      usage: { promptTokens: 900, responseTokens: 120 },
      agentSaid: [],
    }) as unknown as CallResult

  it("keeps the scenario's expectation with the outcome", () => {
    const at = new Date("2026-11-10T10:00:00Z")
    expect(
      recordCall(card, 4, result(true, "cancelled"), 41, at)
    ).toMatchObject({
      scenario: 4,
      intent: "cancel",
      expect: ["cancelled"],
      outcome: "cancelled",
      tokens: { prompt: 900, response: 120 },
      at: "2026-11-10T10:00:00.000Z",
    })
  })

  it("marks an answered call with no decision as none, and an unanswered one as null", () => {
    const at = new Date()
    expect(recordCall(card, 1, result(true, null), 20, at).outcome).toBe("none")
    expect(
      recordCall(card, 1, result(false, "no_answer"), 45, at).outcome
    ).toBe(null)
  })
})

describe("judging", () => {
  it("is right only for an expected outcome", () => {
    expect(judge(record(1, ["confirmed"], "confirmed"))).toBe("right")
    expect(
      judge(record(12, ["talk_to_store", "call_later"], "call_later"))
    ).toBe("right")
    expect(judge(record(1, ["confirmed"], "none"))).toBe("wrong")
    expect(judge(record(1, ["confirmed"], null))).toBe("not reached")
  })

  it("counts a yes taken for a no, and the reverse, as a swap", () => {
    expect(isSwap(record(4, ["cancelled"], "confirmed"))).toBe(true)
    expect(isSwap(record(1, ["confirmed"], "cancelled"))).toBe(true)
    expect(isSwap(record(1, ["confirmed"], "call_later"))).toBe(false)
  })
})

describe("countedCalls", () => {
  it("counts the first answered call, and lets a call again replace only an unanswered one", () => {
    const counted = countedCalls([
      record(1, ["confirmed"], "cancelled", "confirm", "2026-11-10T10:00:00Z"),
      record(1, ["confirmed"], "confirmed", "confirm", "2026-11-10T11:00:00Z"),
      record(2, ["confirmed"], null, "confirm", "2026-11-10T10:01:00Z"),
      record(2, ["confirmed"], "confirmed", "confirm", "2026-11-10T11:01:00Z"),
    ])
    expect(counted.map((r) => [r.scenario, r.outcome])).toEqual([
      [1, "cancelled"],
      [2, "confirmed"],
    ])
  })
})

describe("score", () => {
  const right = (n: number, intent = "confirm") =>
    record(n, ["confirmed"], "confirmed", intent)

  it("passes at 90% right with no swap", () => {
    const calls = [
      ...Array.from({ length: 9 }, (_, i) => right(i + 1)),
      record(10, ["call_later"], "talk_to_store", "call_later"),
      record(11, ["confirmed"], null),
    ]
    const result = score(calls)
    expect(result).toMatchObject({
      answered: 10,
      right: 9,
      notReached: 1,
      swaps: 0,
      passed: true,
    })
    expect(result.byIntent).toEqual([
      { intent: "confirm", answered: 9, right: 9 },
      { intent: "call_later", answered: 1, right: 0 },
    ])
  })

  it("fails on a single swap below 100 answered calls", () => {
    const calls = [
      ...Array.from({ length: 59 }, (_, i) => right(i + 1)),
      record(60, ["cancelled"], "confirmed", "cancel"),
    ]
    expect(score(calls)).toMatchObject({ swaps: 1, passed: false })
  })

  it("fails below 90% right", () => {
    const calls = [
      ...Array.from({ length: 8 }, (_, i) => right(i + 1)),
      record(9, ["call_later"], "none", "call_later"),
      record(10, ["call_later"], "none", "call_later"),
    ]
    expect(score(calls).passed).toBe(false)
  })

  it("prints numbers only", () => {
    const text = formatScore(score([right(1)]), 1)
    expect(text).toContain("| **All** | 1 | 1 | 100% |")
    expect(text).toContain("passed")
    expect(text).not.toContain(card.phone)
  })
})
