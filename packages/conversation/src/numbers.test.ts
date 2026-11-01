import { describe, expect, it } from "vitest"
import { darijaAmount } from "./numbers.js"

describe("darijaAmount", () => {
  it.each([
    [6500, "ستة آلاف وخمسمية دينار"],
    [450, "ربعمية وخمسين دينار"],
    [1000, "ألف دينار"],
    [2000, "ألفين دينار"],
    [2500, "ألفين وخمسمية دينار"],
    [3200, "ثلاثة آلاف وميتين دينار"],
    [11000, "حداش ألف دينار"],
    [12750, "طناش ألف وسبعمية وخمسين دينار"],
    [25000, "خمسة وعشرين ألف دينار"],
    [100000, "مية ألف دينار"],
    [99, "تسعة وتسعين دينار"],
    [15, "خمسطاش دينار"],
  ])("says %i as %s", (amount, words) => {
    expect(darijaAmount(amount)).toBe(words)
  })

  it.each([-1, 1.5, 1_000_000])("refuses %s", (amount) => {
    expect(() => darijaAmount(amount)).toThrow()
  })
})
