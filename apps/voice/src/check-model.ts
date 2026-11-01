import { connectGeminiLive } from "@nexus/ai"
import {
  buildInstruction,
  CONFIRMATION_TOOLS,
  OPENING,
} from "@nexus/conversation"

/**
 * Checks that a Live model accepts our session and speaks, with no phone call:
 *   LIVE_MODEL=<model> tsx src/check-model.ts
 */
const model = process.env.LIVE_MODEL ?? "gemini-3.8-live"
const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  throw new Error("Set GEMINI_API_KEY")
}
const started = Date.now()
let bytes = 0
let firstAudioMs = 0

const session = await connectGeminiLive({
  apiKey,
  model,
  voice: "Aoede",
  instruction: buildInstruction(
    {
      store: { name: "متجر الياسمين" },
      customer: { name: "سارة", language: "ar" },
      order: {
        items: [{ title: "قميص قطن", quantity: 2 }],
        total: 6500,
        delivery: { type: "home", region: "الجزائر", city: "باب الزوار" },
      },
    },
    new Date()
  ),
  tools: CONFIRMATION_TOOLS,
  onClose: (reason) => {
    console.log(`closed: ${reason || "normally"}`)
    process.exit(bytes > 0 ? 0 : 1)
  },
})
session.onAudio((pcm) => {
  firstAudioMs ||= Date.now() - started
  bytes += pcm.length
})
session.onTranscript((who, text) => console.log(`${who}: ${text}`))
session.onTurnComplete(() => {
  console.log(
    `${model}: first audio after ${firstAudioMs} ms, ${(bytes / 48_000).toFixed(1)} s of speech`
  )
  session.close()
})
session.start(OPENING)
setTimeout(() => {
  console.log(`${model}: no answer in 20 s`)
  process.exit(1)
}, 20_000)
