import type { ToolDeclaration } from "@nexus/ai"
import type { Outcome } from "@nexus/core"

export type ConfirmationOrder = {
  store: { name: string }
  customer: { name: string; language: "ar" | "fr" }
  order: {
    items: { title: string; quantity: number }[]
    total: number
    delivery: {
      type: "home" | "stop_desk"
      region: string
      city: string | null
    }
  }
}

function orderLines(task: ConfirmationOrder): string {
  const { items, total, delivery } = task.order
  const lines = items.map((item) => `- ${item.quantity} × ${item.title}`)
  const where =
    delivery.type === "home"
      ? `home delivery to ${delivery.city ?? ""}, ${delivery.region}`
      : `pick-up at the delivery office in ${delivery.region}`
  return [
    ...lines,
    `Total, delivery included: ${total} dinars. Say it in words.`,
    `Delivery: ${where}.`,
  ].join("\n")
}

const LANGUAGE = {
  ar: `Speak Algerian Darija, the way people in Algiers really talk, with French words where they'd naturally use them ("la commande", "l'adresse", "d'accord"). Not Modern Standard Arabic, and not Egyptian or Moroccan. You are a woman, so use feminine forms for yourself. Speak to the customer directly and warmly, as "عندك", "حاب", guessing from their name and how they answer. Everyday words sound right: "إيه", "مليح", "صحيت", "ماشي مشكل", "درك", "شوية". Stay in Darija. Algerians mix in French all the time, so words like "oui", "allo", "d'accord" or "merci" mean nothing: answer them in Darija. Switch to French only if they speak whole sentences in French. Use no other language.`,
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
- Never use office words such as "registered", "recorded", "your request" ("تسجيل", "سجلنا", "طلب التغيير"), and never thank them for a change. Say simply what will happen, for example "مليح، نقولو للمحل يبدلولك العنوان".
- Say one short thing, then let them answer. Don't say the whole order in one long sentence if you can split it.
- Never invent prices, delivery dates or stock. If they ask something you can't answer, say the shop will call them.
- If they ask whether you're a person or a machine, tell the truth: you're the shop's automated assistant. Never claim to be human.

How the call usually goes:
1. Your first words are exactly "${GREETING[language](name)}", and nothing else. Then wait for them to answer.
2. When they say it's them, tell them they have an order from ${task.store.name}: what it is, the total and where it's going. For example "عندك كوموند من عند ${task.store.name}...". Then ask if it's good to send.
3. Talk it through. If something is unclear, ask again in other words.
4. When it's settled, call one function. Then say a short goodbye ("يعطيك الصحة، بالسلامة") and stop.

When to call each function:
- confirm_order: they clearly said yes to the order: "إيه", "واه", "صحا", "oui", "d'accord" and the like all count. If you're not sure what they said, ask again; never guess a yes.
- cancel_order: they don't want it. First ask once if they're sure, and call it only when they say so again.
- call_later: they can't talk now. Ask when suits them, and pass that time.
- wrong_number: this isn't ${name}, or they didn't place the order.
- request_change: they want something changed. Ask what exactly first. For an address, ask for the new address and the commune, and repeat it back to check. Pass all the details.
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
            "Exactly what to change, with the new address or details.",
        },
      },
      required: ["what"],
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
