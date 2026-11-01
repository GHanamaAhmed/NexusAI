import { describe, expect, it } from "vitest"
import { COMMUNES, WILAYAS } from "./data.js"
import { findPlace, resolveCommune, wilayaByCode } from "./match.js"
import { arabicKey, latinKey } from "./normalize.js"

describe("keys", () => {
  it("ignores vowel marks, letter forms and the words around a name", () => {
    expect(arabicKey("أَدْرَار")).toBe(arabicKey("ادرار"))
    expect(arabicKey("ولاية الجزائر")).toBe(arabicKey("جزائر"))
    expect(arabicKey("ڨالمة")).toBe(arabicKey("قالمه"))
  })

  it("ignores accents and the ways French spells sounds", () => {
    expect(latinKey("Aïn Defla")).toBe(latinKey("ain defla"))
    expect(latinKey("Djelfa")).toBe(latinKey("jelfa"))
    expect(latinKey("Commune de Bordj El Kiffan")).toBe(latinKey("borj kifan"))
  })
})

describe("findPlace", () => {
  it("finds a commune heard with another spelling", () => {
    expect(findPlace({ wilaya: "ادرار", commune: "اولاف" })).toMatchObject({
      status: "found",
      place: { wilaya: { code: 1 }, commune: { fr: "Aoulef" } },
    })
  })

  it("finds the same place in Latin letters", () => {
    expect(findPlace({ wilaya: "adrar", commune: "aoulef" })).toMatchObject({
      status: "found",
      place: { wilaya: { code: 1 }, commune: { ar: "أولف" } },
    })
  })

  it("finds a commune said without its wilaya", () => {
    expect(findPlace({ commune: "باب الزوار" })).toMatchObject({
      status: "found",
      place: { wilaya: { code: 16 }, commune: { fr: "Bab Ezzouar" } },
    })
  })

  it("never takes a commune from another wilaya when the wilaya is clear", () => {
    expect(findPlace({ wilaya: "ادرار", commune: "تسالة" })).toMatchObject({
      status: "wilaya_only",
      wilaya: { code: 1 },
    })
  })

  it("offers a longer name when only its first word was heard", () => {
    const result = findPlace({ wilaya: "الجزائر", commune: "تسالة" })
    expect(result.status).toBe("choose")
    expect(result).toMatchObject({
      options: [{ commune: { fr: "Tessala El Merdja" } }],
    })
  })

  it("gives the wilaya alone when no commune was heard", () => {
    expect(findPlace({ wilaya: "Batna" })).toMatchObject({
      status: "wilaya_only",
      wilaya: { code: 5 },
    })
  })

  it("finds a commune of a new wilaya when the former one is named", () => {
    expect(findPlace({ wilaya: "باتنة", commune: "بيطام" })).toMatchObject({
      status: "found",
      place: { wilaya: { code: 60 }, commune: { fr: "Bitam" } },
    })
  })

  it("finds nothing in noise", () => {
    expect(findPlace({ wilaya: "طماطم مقلية" })).toEqual({
      status: "not_found",
    })
    expect(findPlace({ wilaya: "computer" })).toEqual({ status: "not_found" })
    expect(findPlace({})).toEqual({ status: "not_found" })
  })

  it.each([
    ["ar", (name: { ar: string; fr: string }) => name.ar],
    ["fr", (name: { ar: string; fr: string }) => name.fr],
  ] as const)("lets every commune find itself (%s)", (_, nameOf) => {
    let found = 0
    for (const commune of COMMUNES) {
      const wilaya = wilayaByCode(commune.wilaya)!
      const result = findPlace({
        wilaya: nameOf(wilaya),
        commune: nameOf(commune),
      })
      const first =
        result.status === "found"
          ? result.place.commune
          : result.status === "choose"
            ? result.options[0]?.commune
            : undefined
      expect(first, `${commune.fr} (${wilaya.fr})`).toBe(commune)
      if (result.status === "found") {
        found++
      }
    }
    expect(found / COMMUNES.length).toBeGreaterThanOrEqual(0.98)
  })
})

describe("resolveCommune", () => {
  it("finds the order's commune by either name", () => {
    const arabic = resolveCommune(16, "باب الزوار")
    expect(arabic?.fr).toBe("Bab Ezzouar")
    expect(resolveCommune(16, "Bab Ezzouar")).toBe(arabic)
  })

  it("refuses a commune of an unrelated wilaya", () => {
    expect(resolveCommune(1, "باب الزوار")).toBeUndefined()
    expect(resolveCommune(99, "Adrar")).toBeUndefined()
  })

  it("has a wilaya for every code", () => {
    for (const wilaya of WILAYAS) {
      expect(wilayaByCode(wilaya.code)).toBe(wilaya)
    }
  })
})
