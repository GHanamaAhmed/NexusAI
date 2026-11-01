import { connectGeminiLive } from "@nexus/ai"
import type { ConfirmationOrder } from "@nexus/conversation"
import { isAlgerianMobile, toDialString } from "@nexus/core"
import { Ari } from "./ari.js"
import { Call } from "./call.js"
import { startMediaServer } from "./media.js"

/**
 * One spoken test call with a made-up order:
 *   tsx src/demo.ts +213XXXXXXXXX [line] [ar|fr] [voice]
 * Prints the conversation, the outcome and the tokens used.
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Set ${name}`)
  }
  return value
}

const [phone = "", line = "line01", language = "ar", voice] =
  process.argv.slice(2)
if (!isAlgerianMobile(phone)) {
  throw new Error("Usage: demo.ts +213XXXXXXXXX [line] [ar|fr] [voice]")
}

const MEDIA_PORT = 8787

const order: ConfirmationOrder = {
  store: { name: "متجر الياسمين" },
  customer: { name: "غنامة أحمد", language: language as "ar" | "fr" },
  order: {
    items: [
      { title: "قميص قطن", quantity: 2 },
      { title: "صباط رياضي", quantity: 1 },
    ],
    total: 6500,
    delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
  },
}

const apiKey = required("GEMINI_API_KEY")
const ari = new Ari("nexus", "nexus", required("ARI_PASSWORD"))
const call = new Call({
  ari,
  connect: ({ instruction, tools, onClose }) =>
    connectGeminiLive({
      apiKey,
      model: process.env.LIVE_MODEL || undefined,
      voice:
        voice ??
        (language === "fr"
          ? (process.env.VOICE_FR ?? "Kore")
          : (process.env.VOICE_AR ?? "Callirrhoe")),
      instruction,
      tools,
      onClose,
    }),
  order,
  endpoint: `PJSIP/${toDialString(phone, "national")}@${line}`,
  log: (text) => console.log(text),
})

startMediaServer({
  port: MEDIA_PORT,
  onCall: (media) => {
    call.attachMedia(media).catch((error) => console.error(String(error)))
  },
})
await ari.events((event) => {
  call.onEvent(event).catch((error) => console.error(String(error)))
})
await call.dial()

const result = await call.done
console.log(
  `outcome: ${result.outcome ?? "none"} ${JSON.stringify(result.args)}`
)
if (result.change) {
  console.log(`change: ${JSON.stringify(result.change)}`)
}
console.log(
  `tokens: prompt ${result.usage.promptTokens}, response ${result.usage.responseTokens}`
)
process.exit(0)
