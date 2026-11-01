import { connectGeminiLive } from "@nexus/ai"
import {
  buildInstruction,
  CONFIRMATION_TOOLS,
  OPENING,
} from "@nexus/conversation"
import { medianPitch } from "./audio.js"

/**
 * How steady each voice's pitch stays over a scripted call, with no phone:
 *   VOICES=Aoede,Kore tsx src/voice-test.ts
 * A voice that swings between low and high can sound like two people.
 */
const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  throw new Error("Set GEMINI_API_KEY")
}
const voices = (process.env.VOICES ?? "Aoede,Kore,Leda,Zephyr").split(",")
const CUSTOMER = [
  "إيه، أنا هو.",
  "بصح حاب نبدل العنوان.",
  "ولاية أدرار، بلدية أدرار، حي مية مسكن.",
  "إيه صح.",
]
const RATE = 24_000

async function measure(voice: string): Promise<number[]> {
  const pitches: number[] = []
  let turn: Buffer[] = []
  let next = 0
  const session = await connectGeminiLive({
    apiKey: apiKey!,
    voice,
    instruction: buildInstruction(
      {
        store: { name: "متجر الياسمين" },
        customer: { name: "غنامة أحمد", language: "ar" },
        order: {
          items: [
            { title: "قميص قطن", quantity: 2 },
            { title: "صباط رياضي", quantity: 1 },
          ],
          total: 6500,
          delivery: { type: "home", region: "الجزائر", city: "باب الزوار" },
        },
      },
      new Date()
    ),
    tools: CONFIRMATION_TOOLS,
  })
  return new Promise((resolve) => {
    const done = () => {
      session.close()
      resolve(pitches)
    }
    const timer = setTimeout(done, 60_000)
    session.onAudio((pcm) => turn.push(pcm))
    session.onTool(async () => ({ ok: true }))
    session.onTurnComplete(() => {
      const pitch = medianPitch(Buffer.concat(turn), RATE)
      turn = []
      if (pitch) {
        pitches.push(pitch)
      }
      const reply = CUSTOMER[next++]
      if (reply) {
        session.start(reply)
      } else {
        clearTimeout(timer)
        done()
      }
    })
    session.start(OPENING)
  })
}

for (const voice of voices) {
  const pitches = await measure(voice)
  const spread = pitches.length
    ? Math.max(...pitches) - Math.min(...pitches)
    : 0
  console.log(
    `${voice.padEnd(10)} lowest ${Math.min(...pitches)} Hz, spread ${spread} Hz: ${pitches.join(", ")}`
  )
}
process.exit(0)
