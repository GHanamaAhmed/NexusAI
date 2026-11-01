import { randomUUID } from "node:crypto"
import type { ToolDeclaration, VoiceSession } from "@nexus/ai"
import {
  answerLookup,
  buildInstruction,
  CONFIRMATION_TOOLS,
  type ConfirmationOrder,
  OPENING,
  outcomeForTool,
  type PlaceChange,
  placeChange,
  refuseOutcome,
} from "@nexus/conversation"
import type { Outcome } from "@nexus/core"
import type { Ari, AriEvent } from "./ari.js"
import { medianPitch, rms } from "./audio.js"
import type { MediaCall } from "./media.js"

const AUDIO_RATE = 24_000
const RING_TIMEOUT_S = 40
const MAX_CALL_MS = 150_000
/**
 * Most people say "allo" first. Greeting at a fixed moment often collided with
 * it: the model stopped, and the customer waited several seconds in silence.
 * The greeting waits for them to finish, or starts if they say nothing.
 */
const GREET_AFTER_QUIET_MS = 400
const GREET_IF_UNHEARD_MS = 2_000
const GREET_AT_LATEST_MS = 3_000
/** The goodbye usually takes a couple of seconds; never wait for more. */
const GOODBYE_DEADLINE_MS = 8_000
const GOODBYE_WAIT_MS = 12_000
/**
 * The phone plays our audio a little after Asterisk sends it; hanging up as
 * soon as it's sent cut the end of the goodbye off.
 */
const NETWORK_DELAY_MS = 1_000
/** After the goodbye, the call ends once the customer has been quiet this long. */
const QUIET_BEFORE_HANGUP_MS = 1_200
const MAX_WAIT_FOR_QUIET_MS = 3_000
const SPEECH_RMS = 700

export type CallResult = {
  outcome: Outcome | null
  args: Record<string, unknown>
  /** The new place, when the customer confirmed one. */
  change: PlaceChange | null
  /** Q.850 hang-up cause. */
  cause: number | null
  usage: { promptTokens: number; responseTokens: number }
  agentSaid: string[]
}

export type Connect = (options: {
  instruction: string
  tools: ToolDeclaration[]
  onClose: (reason: string) => void
}) => Promise<VoiceSession>

type Session = Promise<VoiceSession | null>

/**
 * One confirmation call: dials, holds the conversation and hangs up. Gemini is
 * connected while the phone rings, so the greeting doesn't wait for it.
 */
export class Call {
  readonly done: Promise<CallResult>
  private resolve!: (result: CallResult) => void
  private readonly id = randomUUID()
  private readonly callChannel = `call-${this.id}`
  private readonly mediaChannel = `ws-${this.id}`
  private readonly bridgeId = `bridge-${this.id}`
  private readonly started = Date.now()
  private session: Session | null = null
  private media?: MediaCall
  private answeredAt = 0
  private greeted = false
  private heardAgent = false
  private outcome: Outcome | null = null
  private args: Record<string, unknown> = {}
  private change: PlaceChange | null = null
  /** What find_place answered during the call; a new place must be one of them. */
  private readonly lookups: Record<string, unknown>[] = []
  private hangingUp = false
  private ended = false
  private lastCustomerVoiceAt = 0
  private agentTurnAudio: Buffer[] = []
  private readonly usage = { promptTokens: 0, responseTokens: 0 }
  private readonly agentSaid: string[] = []
  private readonly timers: NodeJS.Timeout[] = []

  constructor(
    private readonly deps: {
      ari: Pick<Ari, "request">
      connect: Connect
      order: ConfirmationOrder
      /** PJSIP/<number>@<line> */
      endpoint: string
      log: (line: string) => void
    }
  ) {
    this.done = new Promise((resolve) => (this.resolve = resolve))
  }

  private log(line: string) {
    const seconds = ((Date.now() - this.started) / 1000).toFixed(1)
    this.deps.log(`${seconds.padStart(5)}s ${line}`)
  }

  /** Starts connecting to Gemini, then dials. */
  async dial() {
    this.session = this.connect()
    try {
      await this.deps.ari.request("POST", "/channels", {
        endpoint: this.deps.endpoint,
        app: "nexus",
        channelId: this.callChannel,
        callerId: "NexusAI",
        timeout: String(RING_TIMEOUT_S),
      })
    } catch (error) {
      this.end(`could not dial: ${String(error)}`, null)
      throw error
    }
    this.log(`calling ${this.deps.endpoint}`)
    this.timers.push(
      setTimeout(() => {
        this.log("time limit")
        void this.hangup()
      }, MAX_CALL_MS)
    )
  }

  private connect(): Session {
    const session: Session = this.deps
      .connect({
        instruction: buildInstruction(this.deps.order, new Date()),
        tools: CONFIRMATION_TOOLS,
        onClose: (reason) => this.closed(session, reason),
      })
      .catch((error: unknown) => {
        this.log(`Gemini: could not connect: ${String(error)}`)
        return null
      })
    return session
  }

  private closed(session: Session, reason: string) {
    if (this.ended || session !== this.session) {
      return
    }
    this.log(`Gemini closed: ${reason}`)
    if (!this.media) {
      // Closed while the phone rang: connect again when they answer.
      this.session = null
    } else if (!this.outcome) {
      // Never leave the customer on a silent line.
      void this.hangup()
    }
  }

  /** Asterisk opened this call's audio socket. */
  async attachMedia(media: MediaCall) {
    this.media = media
    this.log("audio connected")
    let live = this.session ? await this.session : null
    if (!live) {
      this.session = this.connect()
      live = await this.session
    }
    if (!live) {
      void this.hangup()
      return
    }
    if (this.ended) {
      live.close()
      return
    }
    const session = live
    session.onInterrupted(() => {
      this.log("(customer interrupted)")
      media.flush()
    })
    session.onTranscript((who, text) => {
      this.log(`${who}: ${text}`)
      if (who === "agent") {
        this.agentSaid.push(text)
      }
    })
    session.onUsage((usage) => {
      this.usage.promptTokens += usage.promptTokens
      this.usage.responseTokens += usage.responseTokens
      this.log(
        `(usage report: prompt ${usage.promptTokens}, response ${usage.responseTokens})`
      )
    })
    session.onTool(async (tool) => this.answerTool(tool.name, tool.args))
    session.onTurnComplete(() => {
      const pitch = medianPitch(Buffer.concat(this.agentTurnAudio), AUDIO_RATE)
      this.agentTurnAudio = []
      if (pitch) {
        this.log(`(agent voice pitch ${pitch} Hz)`)
      }
      if (this.outcome) {
        this.hangupAfterGoodbye()
      }
    })
    session.onAudio((pcm) => {
      if (!this.heardAgent) {
        this.heardAgent = true
        this.log(
          `(first words ${Date.now() - this.answeredAt} ms after answer)`
        )
      }
      this.agentTurnAudio.push(pcm)
      media.play(pcm)
    })
    media.onAudio = (pcm) => {
      if (rms(pcm) > SPEECH_RMS) {
        this.lastCustomerVoiceAt = Date.now()
      }
      // The model hears the customer from the greeting on, so an "allo" can't
      // cut it off. Once the answer is in, the model only says goodbye;
      // nothing it hears can start the conversation again.
      if (this.greeted && !this.outcome) {
        session.sendAudio(pcm, AUDIO_RATE)
      }
    }
    this.greetWhenReady(session)
  }

  private greetWhenReady(session: VoiceSession) {
    const start = Date.now()
    const check = setInterval(() => {
      const now = Date.now()
      const spoke = this.lastCustomerVoiceAt > start
      const ready = spoke
        ? now - this.lastCustomerVoiceAt >= GREET_AFTER_QUIET_MS
        : now - start >= GREET_IF_UNHEARD_MS
      if (ready || now - start >= GREET_AT_LATEST_MS) {
        clearInterval(check)
        this.greeted = true
        this.log(`(greeting; the customer ${spoke ? "spoke" : "said nothing"})`)
        session.start(OPENING)
      }
    }, 100)
    this.timers.push(check)
  }

  private answerTool(
    name: string,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    this.log(`tool: ${name} ${JSON.stringify(args)}`)
    const { customer, order } = this.deps.order
    const lookup = answerLookup(name, args, customer.language, order.delivery)
    if (lookup) {
      this.log(`lookup: ${JSON.stringify(lookup)}`)
      this.lookups.push(lookup)
      return lookup
    }
    const outcome = outcomeForTool(name)
    if (!outcome) {
      return { error: `no function named ${name}` }
    }
    // The first answer stands: a confirm after a change request would ship
    // the order to the old place.
    if (this.outcome) {
      this.log(`(ignored ${name}: the outcome is already ${this.outcome})`)
      return { ok: true }
    }
    const refusal = refuseOutcome(name, args, this.lookups)
    if (refusal) {
      this.log(`(refused ${name}: ${refusal})`)
      return { error: refusal }
    }
    this.outcome = outcome
    this.args = args
    if (name === "request_change") {
      this.change = placeChange(args, this.lookups)
    }
    this.timers.push(
      setTimeout(() => this.hangupAfterGoodbye(), GOODBYE_DEADLINE_MS)
    )
    return { ok: true }
  }

  async onEvent(event: AriEvent) {
    const { ari } = this.deps
    const channel = event.channel?.id
    if (event.type === "StasisStart" && channel === this.callChannel) {
      this.answeredAt = Date.now()
      this.log("answered")
      await ari.request("POST", "/bridges", {
        type: "mixing",
        bridgeId: this.bridgeId,
      })
      await ari.request("POST", `/bridges/${this.bridgeId}/addChannel`, {
        channel: this.callChannel,
      })
      await ari.request("POST", "/channels/externalMedia", {
        app: "nexus",
        channelId: this.mediaChannel,
        transport: "websocket",
        encapsulation: "none",
        external_host: "nexus_media",
        format: "slin24",
        transport_data: "f(json)",
      })
    } else if (event.type === "StasisStart" && channel === this.mediaChannel) {
      await ari.request("POST", `/bridges/${this.bridgeId}/addChannel`, {
        channel: this.mediaChannel,
      })
    } else if (
      event.type === "ChannelDestroyed" &&
      channel === this.callChannel
    ) {
      await ari
        .request("DELETE", `/channels/${this.mediaChannel}`)
        .catch(() => {})
      await ari.request("DELETE", `/bridges/${this.bridgeId}`).catch(() => {})
      this.end(
        `${event.cause_txt ?? "hung up"} (cause ${event.cause})`,
        event.cause ?? null
      )
    }
  }

  private async hangup() {
    await this.deps.ari
      .request("DELETE", `/channels/${this.callChannel}`)
      .catch(() => {})
  }

  /** Hangs up once the customer has been quiet for a moment, or soon anyway. */
  private hangupWhenQuiet() {
    const until = Date.now() + MAX_WAIT_FOR_QUIET_MS
    const check = setInterval(() => {
      const quiet =
        Date.now() - this.lastCustomerVoiceAt >= QUIET_BEFORE_HANGUP_MS
      if (quiet || Date.now() >= until) {
        clearInterval(check)
        void this.hangup()
      }
    }, 200)
    this.timers.push(check)
  }

  /** Lets the goodbye play to the end, then hangs up when the customer is quiet. */
  private hangupAfterGoodbye() {
    if (this.hangingUp) {
      return
    }
    this.hangingUp = true
    if (!this.media) {
      void this.hangup()
      return
    }
    this.media.whenSpeechPlayed(() =>
      this.timers.push(
        setTimeout(() => this.hangupWhenQuiet(), NETWORK_DELAY_MS)
      )
    )
    this.timers.push(setTimeout(() => void this.hangup(), GOODBYE_WAIT_MS))
  }

  private end(reason: string, cause: number | null) {
    if (this.ended) {
      return
    }
    this.ended = true
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.log(`ended: ${reason}`)
    void this.session?.then((session) => session?.close())
    this.resolve({
      outcome: this.outcome,
      args: this.args,
      change: this.change,
      cause,
      usage: { ...this.usage },
      agentSaid: [...this.agentSaid],
    })
  }
}
