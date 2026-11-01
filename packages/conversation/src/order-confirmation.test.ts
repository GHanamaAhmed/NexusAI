import { describe, expect, it } from "vitest"
import {
  answerLookup,
  buildInstruction,
  type ConfirmationOrder,
  placeChange,
  refuseChange,
  saidYes,
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

  it("names no place but the order's, and never asks for the street", () => {
    const text = buildInstruction(
      order("ar", { type: "home", wilaya_code: 16, commune: "باب الزوار" }),
      now
    )
    // A name in an example is what the model says when it mishears one.
    expect(text).not.toContain("تيبازة")
    expect(text).not.toContain("أدرار")
    expect(text).not.toContain("أولف")
    expect(text).toContain("never the street or the address")
    expect(text).toContain("never suggest picking the order up at an office")
  })
})

describe("answerLookup", () => {
  it("answers find_place with the place, in the call's language", () => {
    expect(
      answerLookup("find_place", { wilaya: "ادرار", commune: "اولاف" }, "ar")
    ).toEqual({
      status: "found",
      wilaya_code: "1",
      wilaya: "أدرار",
      commune: "أولف",
    })
    expect(
      answerLookup("find_place", { wilaya: "adrar", commune: "aoulef" }, "fr")
    ).toMatchObject({ status: "found", wilaya: "Adrar", commune: "Aoulef" })
  })

  it("finds a commune said without its wilaya", () => {
    expect(
      answerLookup("find_place", { wilaya: "", commune: "اولف" }, "ar")
    ).toMatchObject({ status: "found", wilaya_code: "1", commune: "أولف" })
  })

  it("offers options, the wilaya alone, or nothing", () => {
    expect(
      answerLookup("find_place", { wilaya: "الجزائر", commune: "تسالة" }, "ar")
    ).toMatchObject({
      status: "choose",
      options: [{ wilaya_code: "16", commune: "تسالة المرجة" }],
    })
    expect(
      answerLookup("find_place", { wilaya: "ادرار", commune: "تسالة" }, "ar")
    ).toEqual({
      status: "wilaya_only",
      wilaya_code: "1",
      wilaya: "أدرار",
      commune: null,
    })
    expect(answerLookup("find_place", { wilaya: 7 }, "ar")).toEqual({
      status: "not_found",
    })
  })

  it("leaves the outcome functions alone", () => {
    expect(answerLookup("confirm_order", {}, "ar")).toBeNull()
    expect(answerLookup("request_change", { what: "x" }, "ar")).toBeNull()
  })
})

describe("placeChange", () => {
  const aoulef = [
    answerLookup("find_place", { wilaya: "ادرار", commune: "اولاف" }, "ar")!,
  ]

  it("returns a commune the lookup offered", () => {
    expect(
      placeChange(
        { what: "بلدية أولف", wilaya_code: "1", commune: "أولف", yes: "إيه" },
        aoulef
      )
    ).toEqual({ wilaya_code: 1, commune_ar: "أولف", commune_fr: "Aoulef" })
    const choices = [
      answerLookup(
        "find_place",
        { wilaya: "الجزائر", commune: "تسالة" },
        "fr"
      )!,
    ]
    expect(
      placeChange(
        { wilaya_code: "16", commune: "Tessala El Merdja", yes: "oui" },
        choices
      )
    ).toMatchObject({ commune_ar: "تسالة المرجة" })
  })

  it("refuses a real commune the lookup never offered", () => {
    expect(
      placeChange({ wilaya_code: "1", commune: "أولف", yes: "إيه" }, [])
    ).toBeNull()
    expect(
      placeChange(
        { wilaya_code: "16", commune: "باب الزوار", yes: "إيه" },
        aoulef
      )
    ).toBeNull()
  })

  it("refuses a place the customer didn't say yes to", () => {
    const place = { wilaya_code: "1", commune: "أولف" }
    expect(placeChange(place, aoulef)).toBeNull()
    expect(placeChange({ ...place, yes: "أولف" }, aoulef)).toBeNull()
    expect(placeChange({ ...place, yes: "لا، أدرار رقان" }, aoulef)).toBeNull()
  })

  it("refuses a commune of another wilaya, or a missing one", () => {
    expect(
      placeChange({ wilaya_code: "1", commune: "باب الزوار" }, aoulef)
    ).toBeNull()
    expect(
      placeChange({ wilaya_code: "1", commune: "تسالة" }, aoulef)
    ).toBeNull()
    expect(placeChange({ wilaya_code: "1" }, aoulef)).toBeNull()
    expect(placeChange({ what: "يحب يبدل لولاية أدرار" }, aoulef)).toBeNull()
  })
})

describe("saidYes", () => {
  it.each(["إيه", "إيه صح", "آه", "صحا", "واه", "Oui.", "ouais", "d'accord"])(
    "hears a yes in %s",
    (words) => expect(saidYes(words)).toBe(true)
  )

  it.each([
    "لا",
    "لا، أدرار رقان",
    "الشرقان",
    "أدرار رقان",
    "non",
    "إيه، ماشي هذي",
    "",
  ])("hears no yes in %s", (words) => expect(saidYes(words)).toBe(false))
})

describe("refuseChange", () => {
  const aoulef = [
    answerLookup("find_place", { wilaya: "ادرار", commune: "اولاف" }, "ar")!,
  ]

  it("takes a change without a place, or a confirmed one", () => {
    expect(refuseChange({ what: "بدل البلدية، ما تفهمتش" }, [])).toBeNull()
    expect(
      refuseChange(
        { what: "x", wilaya_code: "1", commune: "أولف", yes: "إيه" },
        aoulef
      )
    ).toBeNull()
  })

  it("tells the agent why a place can't pass", () => {
    expect(
      refuseChange({ what: "x", wilaya_code: "1", commune: "أولف" }, aoulef)
    ).toContain("hasn't said yes")
  })
})
