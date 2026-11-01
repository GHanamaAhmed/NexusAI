import { randomUUID } from "node:crypto"
import { connectGeminiLive, type VoiceSession } from "@nexus/ai"
import {
  buildInstruction,
  CONFIRMATION_TOOLS,
  type ConfirmationOrder,
  OPENING,
  outcomeForTool,
} from "@nexus/conversation"
import { isAlgerianMobile, toDialString } from "@nexus/core"
import { Ari, type AriEvent } from "./ari.js"
import { medianPitch, rms } from "./audio.js"
import { type MediaCall, startMediaServer } from "./media.js"

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
  throw new Error("Usage: demo.ts +213XXXXXXXXX [line] [ar|fr]")
}

const MEDIA_PORT = 8787
const MAX_CALL_MS = 150_000
const AUDIO_RATE = 24_000
const GOODBYE_WAIT_MS = 12_000
const ANSWER_PAUSE_MS = 900
const GOODBYE_DEADLINE_MS = 8_000
/** After the goodbye, the call ends once the customer has been quiet this long. */
const QUIET_BEFORE_HANGUP_MS = 1_200
const SPEECH_RMS = 700

const task: ConfirmationOrder = {
  store: { name: "متجر الياسمين" },
  customer: { name: "غنامة أحمد", language: language as "ar" | "fr" },
  order: {
    items: [
      { title: "قميص قطن", quantity: 2 },
      { title: "صباط رياضي", quantity: 1 },
    ],
    total: 6500,
    delivery: { type: "home", region: "الجزائر", city: "باب الزوار" },
  },
}

const id = randomUUID()
const callChannel = `call-${id}`
const mediaChannel = `ws-${id}`
const bridgeId = `bridge-${id}`
const ari = new Ari("nexus", "nexus", required("ARI_PASSWORD"))
const started = Date.now()
const seconds = () => ((Date.now() - started) / 1000).toFixed(1).padStart(5)

let session: VoiceSession | undefined
let media: MediaCall | undefined
let outcome: string | null = null
let outcomeArgs: Record<string, unknown> = {}
let hangingUp = false
let lastCustomerVoiceAt = 0
let agentTurnAudio: Buffer[] = []
let promptTokens = 0
let responseTokens = 0

const finish = (reason: string) => {
  console.log(`\n${seconds()}s ended: ${reason}`)
  console.log(`outcome: ${outcome ?? "none"} ${JSON.stringify(outcomeArgs)}`)
  console.log(`tokens: prompt ${promptTokens}, response ${responseTokens}`)
  session?.close()
  process.exit(0)
}

async function hangup() {
  await ari.request("DELETE", `/channels/${callChannel}`).catch(() => {})
}

/** Hangs up once the customer has been quiet for a moment. */
function hangupWhenQuiet() {
  const check = setInterval(() => {
    if (Date.now() - lastCustomerVoiceAt >= QUIET_BEFORE_HANGUP_MS) {
      clearInterval(check)
      void hangup()
    }
  }, 200)
}

/** Lets the goodbye play to the end, then hangs up when the customer is quiet. */
function hangupAfterGoodbye() {
  if (hangingUp) {
    return
  }
  hangingUp = true
  if (!media) {
    void hangup()
    return
  }
  media.onDrained = () => hangupWhenQuiet()
  media.whenDrained()
  setTimeout(() => void hangup(), GOODBYE_WAIT_MS)
}

startMediaServer({
  port: MEDIA_PORT,
  onCall: async (call) => {
    media = call
    console.log(`${seconds()}s audio connected`)
    const live = await connectGeminiLive({
      apiKey: required("GEMINI_API_KEY"),
      voice:
        voice ??
        (language === "fr"
          ? (process.env.VOICE_FR ?? "Kore")
          : (process.env.VOICE_AR ?? "Aoede")),
      instruction: buildInstruction(task, new Date()),
      tools: CONFIRMATION_TOOLS,
      onClose: (reason) =>
        console.log(`${seconds()}s Gemini closed: ${reason}`),
    })
    session = live
    live.onInterrupted(() => {
      console.log(`${seconds()}s (customer interrupted)`)
      call.flush()
    })
    live.onTranscript((who, text) =>
      console.log(`${seconds()}s ${who}: ${text}`)
    )
    live.onUsage((usage) => {
      promptTokens += usage.promptTokens
      responseTokens += usage.responseTokens
    })
    live.onTool(async (tool) => {
      console.log(
        `${seconds()}s tool: ${tool.name} ${JSON.stringify(tool.args)}`
      )
      outcome = outcomeForTool(tool.name)
      outcomeArgs = tool.args
      // The goodbye usually takes a couple of seconds; never wait for more.
      setTimeout(() => hangupAfterGoodbye(), GOODBYE_DEADLINE_MS)
      return { ok: true }
    })
    live.onTurnComplete(() => {
      const pitch = medianPitch(Buffer.concat(agentTurnAudio), AUDIO_RATE)
      agentTurnAudio = []
      if (pitch) {
        console.log(`${seconds()}s (agent voice pitch ${pitch} Hz)`)
      }
      if (outcome) {
        hangupAfterGoodbye()
      }
    })
    let heardBytes = 0
    let saidBytes = 0
    live.onAudio((pcm) => {
      saidBytes += pcm.length
      agentTurnAudio.push(pcm)
      call.play(pcm)
    })
    setInterval(() => {
      console.log(
        `${seconds()}s audio in ${heardBytes}, model ${saidBytes}, sent speech ${call.sent.speech} silence ${call.sent.silence}`
      )
    }, 5_000)
    call.onAudio = (pcm) => {
      heardBytes += pcm.length
      if (rms(pcm) > SPEECH_RMS) {
        lastCustomerVoiceAt = Date.now()
      }
      // Once the answer is in, the model only says goodbye; nothing it hears
      // can start the conversation again.
      if (!outcome) {
        live.sendAudio(pcm, AUDIO_RATE)
      }
    }
    // People say "allo" first; a short pause keeps the greeting from colliding.
    setTimeout(() => live.start(OPENING), ANSWER_PAUSE_MS)
  },
})

async function onEvent(event: AriEvent) {
  const channel = event.channel?.id
  if (event.type === "StasisStart" && channel === callChannel) {
    console.log(`${seconds()}s answered`)
    await ari.request("POST", "/bridges", { type: "mixing", bridgeId })
    await ari.request("POST", `/bridges/${bridgeId}/addChannel`, {
      channel: callChannel,
    })
    await ari.request("POST", "/channels/externalMedia", {
      app: "nexus",
      channelId: mediaChannel,
      transport: "websocket",
      encapsulation: "none",
      external_host: "nexus_media",
      format: "slin24",
      transport_data: "f(json)",
    })
  } else if (event.type === "StasisStart" && channel === mediaChannel) {
    await ari.request("POST", `/bridges/${bridgeId}/addChannel`, {
      channel: mediaChannel,
    })
  } else if (event.type === "ChannelDestroyed" && channel === callChannel) {
    await ari.request("DELETE", `/channels/${mediaChannel}`).catch(() => {})
    await ari.request("DELETE", `/bridges/${bridgeId}`).catch(() => {})
    finish(`${event.cause_txt ?? "hung up"} (cause ${event.cause})`)
  }
}

await ari.events((event) => {
  onEvent(event).catch((error) => console.error(String(error)))
})

await ari.request("POST", "/channels", {
  endpoint: `PJSIP/${toDialString(phone, "national")}@${line}`,
  app: "nexus",
  channelId: callChannel,
  callerId: "NexusAI",
  timeout: "40",
})
console.log(`${seconds()}s calling through ${line}`)

setTimeout(() => {
  console.log(`${seconds()}s time limit`)
  void hangup()
}, MAX_CALL_MS)
