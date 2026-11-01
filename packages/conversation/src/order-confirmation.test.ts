import { describe, expect, it } from "vitest"
import {
  buildInstruction,
  type ConfirmationOrder,
} from "./order-confirmation.js"

const order = (
  language: "ar" | "fr",
  delivery: ConfirmationOrder["order"]["delivery"]
): ConfirmationOrder => ({
  store: { name: "Boutique Yasmine" },
  customer: { name: "Sara", language },
  order: { items: [{ title: "Chemise", quantity: 2 }], total: 6500, delivery },
})
const now = new Date("2026-11-01T10:00:00Z")

describe("buildInstruction", () => {
  it("reads the place in the call's language", () => {
    const delivery = {
      type: "home",
      wilaya_code: 16,
      commune: "باب الزوار",
    } as const
    expect(buildInstruction(order("ar", delivery), now)).toContain(
      "home delivery to باب الزوار, الجزائر"
    )
    expect(buildInstruction(order("fr", delivery), now)).toContain(
      "home delivery to Bab Ezzouar, Alger"
    )
  })

  it("reads a commune that isn't on the list as it was sent", () => {
    const text = buildInstruction(
      order("ar", { type: "home", wilaya_code: 1, commune: "حي النصر" }),
      now
    )
    expect(text).toContain("home delivery to حي النصر, أدرار")
  })

  it("names the wilaya alone for an office pick-up without a commune", () => {
    const text = buildInstruction(
      order("fr", { type: "stop_desk", wilaya_code: 5, commune: null }),
      now
    )
    expect(text).toContain("pick-up at the delivery office in Batna")
  })
})
