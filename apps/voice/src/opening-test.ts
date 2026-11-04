import { connectGeminiLive, modelInfo } from "@nexus/ai"
import {
  answerLookup,
  buildInstruction,
  CONFIRMATION_TOOLS,
  type ConfirmationOrder,
  OPENING,
  refuseOutcome,
} from "@nexus/conversation"
import { rms } from "./audio.js"

/**
 * The greeting alone, many times, with the real instruction and functions:
 *   tsx src/opening-test.ts [runs] [ar|fr] [opening text]
 * Counts greetings that hold reasoning or other text, and functions called
 * before the first word. Each run costs a fraction of a cent.
 */

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  throw new Error("Set GEMINI_API_KEY")
}
const [runs = "10", languageArg = "ar", text] = process.argv.slice(2)
if (languageArg !== "ar" && languageArg !== "fr") {
  throw new Error("The language is ar or fr")
}
const language: "ar" | "fr" = languageArg
const opening = text ?? OPENING[language]
const TURN_TIMEOUT_MS = 30_000
const BYTES_PER_SECOND = 24_000 * 2
const FRAME = BYTES_PER_SECOND / 50
const VOICE_RMS = 500

const order: ConfirmationOrder = {
  store: { name: "متجر الياسمين" },
  customer: { name: language === "ar" ? "غنامة أحمد" : "Sara", language },
  order: {
    items: [{ title: "قميص قطن", quantity: 2 }],
    total: 6500,
    delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
  },
}

/** Seconds of audio, and how many of them hold a voice. */
type Greeting = {
  said: string
  seconds: number
  voiced: number
  tools: string[]
}

async function greet(): Promise<Greeting> {
  const greeting: Greeting = { said: "", seconds: 0, voiced: 0, tools: [] }
  const session = await connectGeminiLive({
    apiKey: apiKey!,
    voice: modelInfo("gemini-3.8-live").defaultVoices[language],
    instruction: buildInstruction(order, new Date()),
    tools: CONFIRMATION_TOOLS,
  })
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      session.close()
      resolve(greeting)
    }
    const timer = setTimeout(done, TURN_TIMEOUT_MS)
    session.onAudio((pcm) => {
      greeting.seconds += pcm.length / BYTES_PER_SECOND
      for (let at = 0; at + FRAME <= pcm.length; at += FRAME) {
        if (rms(pcm.subarray(at, at + FRAME)) > VOICE_RMS) {
          greeting.voiced += 0.02
        }
      }
    })
    session.onTranscript((who, text) => {
      if (who === "agent") {
        greeting.said += text
      }
    })
    session.onTool(async ({ name, args }) => {
      greeting.tools.push(name)
      return (
        answerLookup(name, args, language, order.order.delivery) ?? {
          error: refuseOutcome(name, args, []) ?? "The call has only started.",
        }
      )
    })
    session.onTurnComplete(() => {
      if (greeting.said) {
        done()
      }
    })
    session.start(opening)
  })
}

/** Markdown, or letters of the other language, in the greeting. */
const leaked = (said: string) =>
  language === "ar" ? /[A-Za-z*#]/.test(said) : /[\u0600-\u06ff*#]/.test(said)

console.log(`opening: ${opening}`)
let leaks = 0
let early = 0
for (let run = 1; run <= Number(runs); run++) {
  const { said, seconds, voiced, tools } = await greet()
  const flags = [
    leaked(said) ? "LEAK" : "",
    tools.length ? `TOOLS ${tools.join(",")}` : "",
  ].filter(Boolean)
  leaks += leaked(said) ? 1 : 0
  early += tools.length ? 1 : 0
  console.log(
    `${String(run).padStart(3)} ${seconds.toFixed(1).padStart(5)}s (voice ${voiced.toFixed(1).padStart(4)}s) ${flags.join(" ").padEnd(24)} ${said.replace(/\s+/g, " ").slice(0, 120)}`
  )
}
console.log(`${leaks} leaks and ${early} early functions in ${runs} greetings`)
process.exit(0)
