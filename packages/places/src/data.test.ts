import { describe, expect, it } from "vitest"
import { COMMUNES, WILAYAS } from "./data.js"

describe("data", () => {
  it("has the 69 wilayas and 1,541 communes", () => {
    expect(WILAYAS).toHaveLength(69)
    expect(COMMUNES).toHaveLength(1541)
    expect(WILAYAS.map((wilaya) => wilaya.code)).toEqual(
      Array.from({ length: 69 }, (_, i) => i + 1)
    )
  })

  it("puts every commune in a wilaya, and every wilaya has communes", () => {
    const codes = new Set(WILAYAS.map((wilaya) => wilaya.code))
    for (const commune of COMMUNES) {
      expect(codes.has(commune.wilaya)).toBe(true)
    }
    for (const wilaya of WILAYAS) {
      const count = COMMUNES.filter((c) => c.wilaya === wilaya.code).length
      expect(count, wilaya.fr).toBeGreaterThanOrEqual(2)
    }
  })

  it("links each wilaya created in 2026 to the one it was taken from", () => {
    for (const wilaya of WILAYAS) {
      if (wilaya.code <= 58) {
        expect(wilaya.parent).toBe(wilaya.code)
      } else {
        expect(wilaya.parent).toBeGreaterThanOrEqual(1)
        expect(wilaya.parent).toBeLessThanOrEqual(58)
      }
    }
  })
})
