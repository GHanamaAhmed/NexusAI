import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  answerLookup,
  buildInstruction,
  CONFIRMATION_TOOLS,
  type ConfirmationOrder,
  DEFAULT_GREETING,
  DEFAULT_SPEAKING,
  outcomeForTool,
  placeChange,
  refuseOutcome,
  saidYes,
  sampleOrder,
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

  describe("with an admin's style", () => {
    const task = (language: "ar" | "fr"): ConfirmationOrder => ({
      store: { name: "Boutique Yasmine" },
      customer: { name: "Sara", language },
      order: {
        items: [{ title: "Chemise", quantity: 2 }],
        total: 6500,
        delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
      },
    })
    const fingerprint = (text: string) =>
      createHash("sha256").update(text).digest("hex")

    // Taken from the text before any of it could be changed, then French's
    // again when its goodbye came to be said in French.
    it.each([
      [
        "ar",
        4870,
        "12679debbd00988238804b46b07812df12229cf44ff62a4910622d6182dbe44f",
      ],
      [
        "fr",
        4262,
        "a02ea2374f096bef42c449a822430f592014fa68d64f3023a565d2bb7ea696c9",
      ],
    ] as const)(
      "is today's text for %s without one",
      (language, length, hash) => {
        const nothing = { greeting: null, speaking: null, extra_rules: null }
        for (const style of [undefined, {}, nothing]) {
          const text = buildInstruction(task(language), now, style)
          expect(text).toHaveLength(length)
          expect(fingerprint(text)).toBe(hash)
        }
      }
    )

    it("changes only the parts it names", () => {
      const before = buildInstruction(task("fr"), now)
      const text = buildInstruction(task("fr"), now, {
        greeting: "Salut {name}, c'est la boutique",
        speaking: "Speak like a neighbour.",
        extra_rules: "Never mention the weather.",
      })
      expect(text).toContain(
        'Your first words are exactly "Salut Sara, c\'est la boutique"'
      )
      expect(text).toContain("Speak like a neighbour.")
      expect(text).toContain("Never mention the weather.")
      expect(text).not.toContain(DEFAULT_SPEAKING.fr)
      // The call's protocol stays, whatever the style says.
      for (const part of ["confirm_order", "request_change", "find_place"]) {
        expect(before).toContain(part)
        expect(text).toContain(part)
      }
    })

    it("takes a name with characters a replacement treats as special", () => {
      const named = task("fr")
      named.customer.name = "$& Sara"
      const text = buildInstruction(named, now, { greeting: "Salut {name}" })
      expect(text).toContain('exactly "Salut $& Sara"')
    })

    it("offers its default text for going back to", () => {
      expect(DEFAULT_GREETING.ar).toContain("{name}")
      expect(DEFAULT_GREETING.fr).toContain("{name}")
      expect(buildInstruction(task("ar"), now)).toContain(DEFAULT_SPEAKING.ar)
    })

    it("has a sample order for each language", () => {
      for (const language of ["ar", "fr"] as const) {
        expect(sampleOrder(language).customer.language).toBe(language)
        expect(buildInstruction(sampleOrder(language), now)).toContain(
          DEFAULT_GREETING[language].replace(
            "{name}",
            sampleOrder(language).customer.name
          )
        )
      }
    })
  })
})

describe("outcomeForTool", () => {
  it("gives each outcome function its outcome, and the lookup none", () => {
    expect(
      Object.fromEntries(
        CONFIRMATION_TOOLS.map(({ name }) => [name, outcomeForTool(name)])
      )
    ).toEqual({
      confirm_order: "confirmed",
      cancel_order: "cancelled",
      call_later: "call_later",
      wrong_number: "wrong_number",
      request_change: "request_change",
      find_place: null,
      talk_to_store: "talk_to_store",
      answering_machine: "machine",
    })
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

  it("doesn't offer the order's own place back", () => {
    const current = {
      type: "home",
      wilaya_code: 16,
      commune: "باب الزوار",
    } as const
    expect(
      answerLookup(
        "find_place",
        { wilaya: "الجزائر", commune: "باب الزوار" },
        "ar",
        current
      )
    ).toMatchObject({ status: "current_place" })
    expect(
      answerLookup(
        "find_place",
        { wilaya: "الجزائر", commune: "الشراقة" },
        "ar",
        current
      )
    ).toMatchObject({ status: "found", commune: "الشراقة" })
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

describe("refuseOutcome", () => {
  const aoulef = [
    answerLookup("find_place", { wilaya: "ادرار", commune: "اولاف" }, "ar")!,
  ]

  it("takes a change without a place, or a confirmed one", () => {
    expect(
      refuseOutcome("request_change", { what: "بدل البلدية" }, [])
    ).toBeNull()
    expect(
      refuseOutcome(
        "request_change",
        { what: "x", wilaya_code: "1", commune: "أولف", yes: "إيه" },
        aoulef
      )
    ).toBeNull()
  })

  it("tells the agent why a place can't pass", () => {
    expect(
      refuseOutcome(
        "request_change",
        { what: "x", wilaya_code: "1", commune: "أولف" },
        aoulef
      )
    ).toContain("hasn't said yes")
  })

  it("confirms only on a yes", () => {
    expect(
      refuseOutcome("confirm_order", { yes: "إيه، ابعثوها" }, [])
    ).toBeNull()
    expect(refuseOutcome("confirm_order", { yes: "posar" }, [])).toContain(
      "isn't a clear yes"
    )
    expect(refuseOutcome("confirm_order", {}, [])).toContain(
      "isn't a clear yes"
    )
  })

  it("confirms nothing once the customer has named another place", () => {
    expect(refuseOutcome("confirm_order", { yes: "إيه" }, aoulef)).toContain(
      "named another place"
    )
    const notFound = [answerLookup("find_place", { wilaya: "x" }, "ar")!]
    expect(refuseOutcome("confirm_order", { yes: "إيه" }, notFound)).toBeNull()
  })

  it("leaves the other outcomes alone", () => {
    expect(refuseOutcome("call_later", { when: "x" }, aoulef)).toBeNull()
  })
})
