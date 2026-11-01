import { COMMUNES, WILAYAS } from "./data.js"
import {
  arabicKey,
  hasArabic,
  hasLatin,
  latinKey,
  skeleton,
} from "./normalize.js"
import type { Commune, Wilaya } from "./types.js"

export type Place = { wilaya: Wilaya; commune: Commune | null }

export type PlaceLookup =
  /** One clear match: say it back. */
  | { status: "found"; place: Place }
  /** Two or three close ones: ask which. */
  | { status: "choose"; options: Place[] }
  /** The wilaya, but no commune in it. */
  | { status: "wilaya_only"; wilaya: Wilaya }
  | { status: "not_found" }

/** A match at least this good, and clearly ahead of the next, is taken. */
const SURE = 0.85
/** Anything below this isn't offered at all. */
const CLOSE = 0.7
const MARGIN = 0.1
/** Options offered together are at most this far behind the best one. */
const WITHIN = 0.15
const MAX_OPTIONS = 3
/** A match without vowels counts for less than the same spelling. */
const SKELETON_WEIGHT = 0.9
/** The first word of a longer name ("تسالة" for "تسالة المرجة") is offered, never taken. */
const PREFIX_SCORE = 0.8
const PREFIX_MIN_LENGTH = 4

type Keys = { ar: string; fr: string; arBare: string; frBare: string }
type Keyed<T> = Keys & { item: T }
type Scored<T> = { item: T; score: number }

function keysOf(ar: string, fr: string): Keys {
  return { ar, fr, arBare: skeleton(ar), frBare: skeleton(fr) }
}

function keyed<T extends { ar: string; fr: string }>(
  items: readonly T[]
): Keyed<T>[] {
  return items.map((item) => ({
    item,
    ...keysOf(arabicKey(item.ar), latinKey(item.fr)),
  }))
}

const WILAYA_KEYS = keyed(WILAYAS)
const COMMUNE_KEYS = keyed(COMMUNES)
const BY_CODE = new Map(WILAYAS.map((wilaya) => [wilaya.code, wilaya]))

function heardKeys(text: string): Keys {
  return keysOf(
    hasArabic(text) ? arabicKey(text) : "",
    hasLatin(text) ? latinKey(text) : ""
  )
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost
      )
    }
    previous = current
  }
  return previous[b.length]!
}

function similarity(a: string, b: string): number {
  if (!a || !b) {
    return 0
  }
  return 1 - distance(a, b) / Math.max(a.length, b.length)
}

function startsName(heard: string, key: string): number {
  return heard.length >= PREFIX_MIN_LENGTH &&
    key.length > heard.length &&
    key.startsWith(heard)
    ? PREFIX_SCORE
    : 0
}

function rank<T>(places: Keyed<T>[], heard: Keys): Scored<T>[] {
  return places
    .map((place) => ({
      item: place.item,
      score: Math.max(
        similarity(heard.ar, place.ar),
        similarity(heard.fr, place.fr),
        SKELETON_WEIGHT * similarity(heard.arBare, place.arBare),
        SKELETON_WEIGHT * similarity(heard.frBare, place.frBare),
        startsName(heard.ar, place.ar),
        startsName(heard.fr, place.fr)
      ),
    }))
    .filter((scored) => scored.score >= CLOSE)
    .sort((a, b) => b.score - a.score)
}

function isSure(ranked: Scored<unknown>[]): boolean {
  const [best, next] = ranked
  if (!best || best.score < SURE) {
    return false
  }
  if (!next) {
    return true
  }
  // An exact match is taken unless another name matches exactly too.
  return (
    best.score - next.score >= MARGIN || (best.score === 1 && next.score < 1)
  )
}

function closest<T>(ranked: Scored<T>[]): Scored<T>[] {
  const best = ranked[0]
  if (!best) {
    return []
  }
  return ranked
    .filter((scored) => best.score - scored.score <= WITHIN)
    .slice(0, MAX_OPTIONS)
}

/** The wilaya, the one it was taken from and the others taken from that one. */
function related(wilaya: Wilaya): Set<number> {
  return new Set(
    WILAYAS.filter((other) => other.parent === wilaya.parent).map(
      (other) => other.code
    )
  )
}

function communesOf(codes: Set<number>): Keyed<Commune>[] {
  return COMMUNE_KEYS.filter((commune) => codes.has(commune.item.wilaya))
}

function placeOf(commune: Commune): Place {
  return { wilaya: BY_CODE.get(commune.wilaya)!, commune }
}

function fromCommunes(communes: Scored<Commune>[]): PlaceLookup {
  if (isSure(communes)) {
    return { status: "found", place: placeOf(communes[0]!.item) }
  }
  return {
    status: "choose",
    options: closest(communes).map((scored) => placeOf(scored.item)),
  }
}

export function wilayaByCode(code: number): Wilaya | undefined {
  return BY_CODE.get(code)
}

/** The places a wilaya and commune heard on the phone may mean. */
export function findPlace(heard: {
  wilaya?: string
  commune?: string
}): PlaceLookup {
  const wilayaText = heard.wilaya?.trim() ?? ""
  const communeText = heard.commune?.trim() ?? ""
  const wilayas = wilayaText ? rank(WILAYA_KEYS, heardKeys(wilayaText)) : []
  // A name that is no wilaya may be the commune said on its own.
  const communeHeard = communeText
    ? heardKeys(communeText)
    : !wilayas.length && wilayaText
      ? heardKeys(wilayaText)
      : null

  if (isSure(wilayas)) {
    const wilaya = wilayas[0]!.item
    const communes = communeHeard
      ? rank(communesOf(related(wilaya)), communeHeard)
      : []
    return communes.length
      ? fromCommunes(communes)
      : { status: "wilaya_only", wilaya }
  }
  if (wilayas.length) {
    const options = closest(wilayas)
    if (communeHeard) {
      const codes = new Set(options.flatMap(({ item }) => [...related(item)]))
      const communes = rank(communesOf(codes), communeHeard)
      if (communes.length) {
        return fromCommunes(communes)
      }
    }
    return {
      status: "choose",
      options: options.map(({ item }) => ({ wilaya: item, commune: null })),
    }
  }
  if (communeHeard) {
    const communes = rank(COMMUNE_KEYS, communeHeard)
    if (communes.length) {
      return fromCommunes(communes)
    }
  }
  return { status: "not_found" }
}

/** The commune of that wilaya (or its former or newer wilayas) whose name has the same key. */
export function resolveCommune(
  wilayaCode: number,
  name: string
): Commune | undefined {
  const wilaya = BY_CODE.get(wilayaCode)
  if (!wilaya) {
    return undefined
  }
  const heard = heardKeys(name)
  const same = (commune: Keyed<Commune>) =>
    (heard.ar !== "" && heard.ar === commune.ar) ||
    (heard.fr !== "" && heard.fr === commune.fr)
  const group = communesOf(related(wilaya))
  return (
    group.find(
      (commune) => commune.item.wilaya === wilayaCode && same(commune)
    ) ?? group.find(same)
  )?.item
}
