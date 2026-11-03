import { describe, expect, it } from "vitest"
import {
  FINAL_OUTCOMES,
  firstAttemptAt,
  isAlgerianMobile,
  isAllowedNumber,
  isWithinCallWindow,
  nextAttemptAt,
  nextOpening,
  OUTCOMES,
  parseAllowedNumbers,
  parseCallWindow,
  toDialString,
  unansweredOutcome,
} from "./index.js"

const window = parseCallWindow("09:00-20:00")
/** A time on the Algiers clock (UTC+1). */
const algiers = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, day, hour - 1, minute))

describe("parseCallWindow", () => {
  it("reads hours and minutes", () => {
    expect(window).toEqual({ opens: 540, closes: 1200 })
  })

  it.each(["9-20", "20:00-09:00", "09:00-25:00"])("refuses %s", (text) => {
    expect(() => parseCallWindow(text)).toThrow()
  })
})

describe("call window", () => {
  it("is open from opening until just before closing", () => {
    expect(isWithinCallWindow(algiers(30, 9), window)).toBe(true)
    expect(isWithinCallWindow(algiers(30, 19, 59), window)).toBe(true)
    expect(isWithinCallWindow(algiers(30, 20), window)).toBe(false)
    expect(isWithinCallWindow(algiers(30, 8, 59), window)).toBe(false)
  })

  it("keeps a time that is already open", () => {
    const at = algiers(30, 12, 30)
    expect(nextOpening(at, window)).toBe(at)
  })

  it("moves an early time to this morning", () => {
    expect(nextOpening(algiers(30, 7, 15), window)).toEqual(algiers(30, 9))
  })

  it("moves a late time to tomorrow morning", () => {
    expect(nextOpening(algiers(30, 22, 40), window)).toEqual(algiers(31, 9))
  })
})

describe("retries", () => {
  it("calls two minutes after the order", () => {
    expect(firstAttemptAt(algiers(30, 12), window)).toEqual(algiers(30, 12, 2))
  })

  it("holds a night order until the morning", () => {
    expect(firstAttemptAt(algiers(30, 23), window)).toEqual(algiers(31, 9))
  })

  it("tries again after an hour, then at 10:00 the next day, then stops", () => {
    const first = algiers(30, 12)
    expect(nextAttemptAt(1, first, window)).toEqual(algiers(30, 13))
    expect(nextAttemptAt(2, algiers(30, 13), window)).toEqual(algiers(31, 10))
    expect(nextAttemptAt(3, algiers(31, 10), window)).toBeNull()
  })

  it("keeps a retry inside the window", () => {
    expect(nextAttemptAt(1, algiers(30, 19, 30), window)).toEqual(
      algiers(31, 9)
    )
  })
})

describe("phone numbers", () => {
  it.each(["+213551234567", "+213661234567", "+213771234567"])(
    "allows %s",
    (phone) => {
      expect(isAlgerianMobile(phone)).toBe(true)
    }
  )

  it.each([
    "0551234567",
    "+213211234567",
    "+21355123456",
    "+33612345678",
    "+2135512345678",
  ])("refuses %s", (phone) => {
    expect(isAlgerianMobile(phone)).toBe(false)
  })

  it("spells a number the way the provider wants", () => {
    expect(toDialString("+213551234567", "national")).toBe("0551234567")
    expect(toDialString("+213551234567", "international")).toBe("213551234567")
  })

  it("never spells a number outside Algeria", () => {
    expect(() => toDialString("+33612345678", "national")).toThrow()
  })
})

describe("allowed numbers", () => {
  it("allows none when unset or empty", () => {
    for (const value of [undefined, "", " "]) {
      expect(isAllowedNumber("+213551234567", parseAllowedNumbers(value))).toBe(
        false
      )
    }
  })

  it("allows only the listed numbers, however they're written", () => {
    const allowed = parseAllowedNumbers(
      "0551 23 45 67, +213661234567,213771234567"
    )
    expect(allowed).toEqual(
      new Set(["+213551234567", "+213661234567", "+213771234567"])
    )
    expect(isAllowedNumber("+213551234567", allowed)).toBe(true)
    expect(isAllowedNumber("+213551234568", allowed)).toBe(false)
  })

  it("allows every number only when told any", () => {
    expect(isAllowedNumber("+213551234567", parseAllowedNumbers("any"))).toBe(
      true
    )
  })

  it("refuses a list with anything but mobiles", () => {
    expect(() => parseAllowedNumbers("0551234567,021123456")).toThrow()
    expect(() => parseAllowedNumbers("*")).toThrow()
  })
})

describe("outcomes", () => {
  it("treats only real answers as final", () => {
    expect(OUTCOMES.filter((o) => !FINAL_OUTCOMES.has(o))).toEqual([
      "no_answer",
      "busy",
      "machine",
      "unreachable",
      "no_input",
    ])
  })

  it.each([
    [17, "busy"],
    [21, "busy"],
    [1, "invalid_number"],
    [28, "invalid_number"],
    [20, "unreachable"],
    [27, "unreachable"],
    [34, "unreachable"],
    [18, "no_answer"],
    [19, "no_answer"],
    [null, "no_answer"],
  ] as const)("reads hang-up cause %s as %s", (cause, outcome) => {
    expect(unansweredOutcome(cause)).toBe(outcome)
  })
})
