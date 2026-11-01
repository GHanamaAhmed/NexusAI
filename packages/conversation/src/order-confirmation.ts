import type { ToolDeclaration } from "@nexus/ai"
import type { Outcome } from "@nexus/core"
import {
  findPlace,
  type Place,
  resolveCommune,
  wilayaByCode,
} from "@nexus/places"
import { darijaAmount } from "./numbers.js"

type Language = "ar" | "fr"
type Delivery = {
  type: "home" | "stop_desk"
  wilaya_code: number
  commune: string | null
}

export type ConfirmationOrder = {
  store: { name: string }
  customer: { name: string; language: Language }
  order: {
    items: { title: string; quantity: number }[]
    total: number
    delivery: Delivery
  }
}

/** The commune and wilaya in the call's language; a commune not on the list is read as sent. */
function placeName(delivery: Delivery, language: Language): string {
  const commune = delivery.commune
    ? (resolveCommune(delivery.wilaya_code, delivery.commune)?.[language] ??
      delivery.commune)
    : null
  const wilaya = wilayaByCode(delivery.wilaya_code)?.[language]
  return [commune, wilaya].filter(Boolean).join(", ")
}

function orderLines(task: ConfirmationOrder): string {
  const { items, total, delivery } = task.order
  const spoken =
    task.customer.language === "ar"
      ? `Say the total exactly as "${darijaAmount(total)}". Never in centimes, and never another number.`
      : `Say the total as ${total} dinars, in words. Never in centimes.`
  const lines = items.map((item) => `- ${item.quantity} × ${item.title}`)
  const place = placeName(delivery, task.customer.language)
  const where =
    delivery.type === "home"
      ? `home delivery to ${place}`
      : `pick-up at the delivery office in ${place}`
  return [
    ...lines,
    `Total, delivery included: ${total} dinars. ${spoken}`,
    `Delivery: ${where}.`,
  ].join("\n")
}

const LANGUAGE = {
  ar: `Speak Algerian Darija, the way people in Algiers really talk, with French words where they'd naturally use them ("la commande", "l'adresse", "d'accord"). Not Modern Standard Arabic, and not Egyptian or Moroccan. You are a woman: always use feminine forms for yourself ("فاهمة", "سمعتك", "راني نعيطلك"), never masculine ones ("فاهم"). Speak to the customer directly and warmly, as "عندك", "حاب", guessing from their name and how they answer. Everyday words sound right: "إيه", "مليح", "صحيت", "ماشي مشكل", "درك", "شوية". Stay in Darija. Algerians mix in French all the time, so words like "oui", "allo", "d'accord" or "merci" mean nothing: answer them in Darija. Switch to French only if they speak whole sentences in French. Use no other language.`,
  fr: `Speak simple, warm, everyday French. You are a woman, so use feminine forms for yourself. If the customer speaks Darija, switch to Algerian Darija. Use no other language.`,
}

const GREETING = {
  ar: (name: string) => `السلام عليكم، معايا ${name}؟`,
  fr: (name: string) => `Bonjour, je suis bien avec ${name} ?`,
}

/** What the model must do on a confirmation call. */
export function buildInstruction(task: ConfirmationOrder, now: Date): string {
  const { name, language } = task.customer
  return `You work at the store "${task.store.name}" and you're calling ${name} about a cash-on-delivery order they placed online. It is ${now.toISOString()} (Algeria is UTC+1).

${LANGUAGE[language]}

The order:
${orderLines(task)}

This has to sound like an ordinary phone call from someone at the shop. Speak casually and briefly, the way people do on the phone. Listen, react to what they just said, then go on.
- Never open with an introduction such as "I'm the assistant of...". Never sound like an announcement, a script or a form.
- Never use office words such as "registered", "recorded", "your request" ("تسجيل", "سجلنا", "طلب التغيير"), and never thank them for a change. Say simply what will happen, for example "مليح، نقولو للمحل يبدلولك البلاصة".
- Say one short thing, then let them answer. Don't say the whole order in one long sentence if you can split it.
- Never invent prices, delivery dates or stock. If they ask something you can't answer, say the shop will call them.
- If they ask whether you're a person or a machine, tell the truth: you're the shop's automated assistant. Never claim to be human.

How the call usually goes:
1. Your first words are exactly "${GREETING[language](name)}", and nothing else. Then wait for them to answer. If they say nothing, wait; then say only "ألو؟", never the whole greeting again.
2. When they say it's them, tell them they have an order from ${task.store.name}: what it is, the total and where it's going. For example "عندك كوموند من عند ${task.store.name}...". Then ask if it's good to send.
3. Talk it through. If something is unclear, ask again in other words.
4. Only when everything is settled and they've answered your last question, call the function that fits. Never call one while you're still asking or checking something; find_place is the only exception. After the function, say a short goodbye ("يعطيك الصحة، بالسلامة") and stop.

When to call each function:
- confirm_order: they clearly said yes to the order: "إيه", "واه", "صحا", "oui", "d'accord" and the like all count. If you're not sure what they said, ask again; never guess a yes.
- cancel_order: they don't want it. First ask once if they're sure, and call it only when they say so again.
- call_later: they can't talk now. Ask when suits them, and pass that time.
- wrong_number: this isn't ${name}, or they didn't place the order.
- find_place: the customer has just said a wilaya or a commune; it tells you what they may mean. Never call it before they've said one, or with the order's current place.
- request_change: they want something changed. Ask what exactly first. For where it's delivered, ask only for the wilaya and the commune, never the street or the address, and wait for their answer. Then call find_place with what you heard, and:
  - found: say it back ("يعني ولاية ...، بلدية ...، صح؟") and wait;
  - choose: ask which one ("تقصد ... ولا ...؟");
  - wilaya_only: ask for the commune again;
  - not_found: ask them to say it again.
  Try at least twice. Call request_change with the wilaya_code and commune find_place gave only once they say yes to the place you said back. If it's still not clear, don't guess: say "ماشي مشكل، المحل يعيطلك باش تتفاهمو على البلاصة", and call request_change with what was confirmed and what's missing, for example "يحب يبدل لولاية أدرار، البلدية ما تفهمتش". Never pass a place they haven't confirmed, and never suggest picking the order up at an office. Write "what" in the customer's own words, in Arabic letters for Darija, never translated to English.
- talk_to_store: they want to speak to someone, or you still can't understand them after asking twice.
- answering_machine: you hear a voicemail or recorded greeting. Say nothing to it.`
}

/** The first turn: the line is open and the customer has answered. */
export const OPENING = "The customer has answered. Start the call now."

export const CONFIRMATION_TOOLS: ToolDeclaration[] = [
  { name: "confirm_order", description: "The customer confirms the order." },
  {
    name: "cancel_order",
    description: "The customer repeated that they want to cancel.",
    parameters: {
      properties: {
        reason: { type: "string", description: "Why, if they said." },
      },
    },
  },
  {
    name: "call_later",
    description: "The customer wants a call at another time.",
    parameters: {
      properties: {
        when: {
          type: "string",
          description: "The time they asked for, as an ISO 8601 date and time.",
        },
      },
      required: ["when"],
    },
  },
  { name: "wrong_number", description: "This person didn't place the order." },
  {
    name: "request_change",
    description:
      "The customer wants something changed, once you have the details.",
    parameters: {
      properties: {
        what: {
          type: "string",
          description:
            "Exactly what to change, in the customer's own words and language.",
        },
        wilaya_code: {
          type: "string",
          description:
            "The wilaya_code find_place returned, only for a place the customer confirmed.",
        },
        commune: {
          type: "string",
          description:
            "The commune find_place returned, only for a place the customer confirmed.",
        },
      },
      required: ["what"],
    },
  },
  {
    name: "find_place",
    description:
      "Looks up the wilaya and commune the customer just said, as you heard them. Returns the places they may mean. Only call it after they've said one.",
    parameters: {
      properties: {
        wilaya: {
          type: "string",
          description:
            "The wilaya as you heard it, in Arabic letters, or in Latin letters if they spelled it the French way. Empty if they didn't say one.",
        },
        commune: {
          type: "string",
          description:
            "The commune as you heard it, written the same way. Empty if they didn't say one.",
        },
      },
    },
  },
  {
    name: "talk_to_store",
    description: "The customer wants a person, or can't be understood.",
    parameters: {
      properties: {
        reason: { type: "string", description: "Why, in a few words." },
      },
    },
  },
  {
    name: "answering_machine",
    description: "A voicemail or recorded greeting answered, not a person.",
  },
]

const TOOL_OUTCOMES: Record<string, Outcome> = {
  confirm_order: "confirmed",
  cancel_order: "cancelled",
  call_later: "call_later",
  wrong_number: "wrong_number",
  request_change: "request_change",
  talk_to_store: "talk_to_store",
  answering_machine: "machine",
}

export function outcomeForTool(name: string): Outcome | null {
  return TOOL_OUTCOMES[name] ?? null
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Answers a lookup made mid-call; null when the function isn't one (outcome functions aren't). */
export function answerLookup(
  name: string,
  args: Record<string, unknown>,
  language: Language
): Record<string, unknown> | null {
  if (name !== "find_place") {
    return null
  }
  // Codes go back as text, like every value the model passes.
  const describe = ({ wilaya, commune }: Place) => ({
    wilaya_code: String(wilaya.code),
    wilaya: wilaya[language],
    commune: commune?.[language] ?? null,
  })
  const result = findPlace({
    wilaya: text(args.wilaya),
    commune: text(args.commune),
  })
  switch (result.status) {
    case "found":
      return { status: "found", ...describe(result.place) }
    case "choose":
      return { status: "choose", options: result.options.map(describe) }
    case "wilaya_only":
      return {
        status: "wilaya_only",
        ...describe({ wilaya: result.wilaya, commune: null }),
      }
    case "not_found":
      return { status: "not_found" }
  }
}

export type PlaceChange = {
  wilaya_code: number
  commune_ar: string
  commune_fr: string
}

type Offer = { wilaya_code: string; commune: string | null }

/** The places the call's lookups offered the agent to say back. */
function offered(lookups: readonly Record<string, unknown>[]): Offer[] {
  return lookups.flatMap((lookup) =>
    lookup.status === "found"
      ? [lookup as Offer]
      : lookup.status === "choose"
        ? (lookup.options as Offer[])
        : []
  )
}

/**
 * The new place from request_change's arguments: a real commune of that
 * wilaya, and one find_place offered during the call, so never a guess.
 */
export function placeChange(
  args: Record<string, unknown>,
  lookups: readonly Record<string, unknown>[]
): PlaceChange | null {
  const code = Number(text(args.wilaya_code))
  const commune = Number.isInteger(code)
    ? resolveCommune(code, text(args.commune))
    : undefined
  const wasOffered =
    commune !== undefined &&
    offered(lookups).some(
      (offer) =>
        Number(offer.wilaya_code) === commune.wilaya &&
        (offer.commune === commune.ar || offer.commune === commune.fr)
    )
  return commune && wasOffered
    ? {
        wilaya_code: commune.wilaya,
        commune_ar: commune.ar,
        commune_fr: commune.fr,
      }
    : null
}
