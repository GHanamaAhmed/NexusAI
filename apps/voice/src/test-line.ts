import type { ModelId } from "@nexus/ai"
import type { ConfirmationOrder } from "@nexus/conversation"
import {
  type DialFormat,
  isAlgerianMobile,
  isAllowedNumber,
  parseAllowedNumbers,
  toDialString,
} from "@nexus/core"
import { Ari } from "./ari.js"
import { Call, type CallResult } from "./call.js"
import { startMediaServer } from "./media.js"
import { callOptions, testKeys, testSettings } from "./sessions.js"

/**
 * Test calls run next to the voice app: their own Asterisk app and audio port
 * (websocket_client.conf's nexus_media_test), so the voice app keeps running
 * and its lines stay watched.
 */
const APP = "nexus-test"
const MEDIA_HOST = "nexus_media_test"
const MEDIA_PORT = 8788

export type TestCall = {
  /** +213XXXXXXXXX; it must be in ALLOWED_NUMBERS. */
  phone: string
  line: string
  order: ConfirmationOrder
  /** The default model unless named. */
  model?: ModelId
  voice?: string
  log?: (line: string) => void
}

export type TestLine = {
  /** One call at a time: it resolves when the call has ended. */
  call(options: TestCall): Promise<CallResult>
  close(): void
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Set ${name}`)
  }
  return value
}

/** Refuses a number NexusAI may not call, before anything connects. */
export function checkTestNumber(phone: string) {
  if (!isAlgerianMobile(phone)) {
    throw new Error(`${phone} isn't an Algerian mobile number in +213 form`)
  }
  if (
    !isAllowedNumber(phone, parseAllowedNumbers(process.env.ALLOWED_NUMBERS))
  ) {
    throw new Error("Test calls go only to numbers in ALLOWED_NUMBERS")
  }
}

export async function openTestLine(): Promise<TestLine> {
  const keys = testKeys()
  const ari = new Ari(APP, "nexus", required("ARI_PASSWORD"))
  const dialFormat = (process.env.DIAL_FORMAT ?? "national") as DialFormat
  let current: Call | null = null

  const media = startMediaServer({
    port: MEDIA_PORT,
    onCall: (audio) => {
      current?.attachMedia(audio).catch((error) => console.error(String(error)))
    },
  })
  const events = await ari.events((event) => {
    current?.onEvent(event).catch((error) => console.error(String(error)))
  })

  return {
    async call({ phone, line, order, model, voice, log = console.log }) {
      checkTestNumber(phone)
      if (current) {
        throw new Error("A test call is already running")
      }
      const { language } = order.customer
      const settings = testSettings(model, voice)
      const call: Call = new Call({
        ari,
        app: APP,
        mediaHost: MEDIA_HOST,
        order,
        endpoint: `PJSIP/${toDialString(phone, dialFormat)}@${line}`,
        log,
        ...callOptions(settings, language, keys, log),
      })
      current = call
      try {
        await call.dial()
        return await call.done
      } finally {
        current = null
      }
    },
    close() {
      events.close()
      media.close()
    },
  }
}
