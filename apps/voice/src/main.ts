import { connectGeminiLive } from "@nexus/ai"
import { createDb } from "@nexus/db"
import { Ari } from "./ari.js"
import { Call } from "./call.js"
import { loadConfig } from "./config.js"
import { Dialer } from "./dialer.js"
import { readRegistrations } from "./lines.js"
import { startMediaServer } from "./media.js"

const MEDIA_PORT = 8787
const RECONNECT_MS = 5_000

const config = loadConfig()
const db = createDb(config.databaseUrl)
const ari = new Ari("nexus", "nexus", config.ariPassword)
const log = (line: string) => console.log(line)

const dialer = new Dialer({
  db,
  callsEnabled: config.callsEnabled,
  allowedNumbers: config.allowedNumbers,
  window: config.callWindow,
  dialFormat: config.dialFormat,
  limits: config.limits,
  log,
  startCall: (order, endpoint) => {
    const call: Call = new Call({
      ari,
      order,
      endpoint,
      // What was said is in the attempt's transcript, not the logs.
      log: (line) => {
        if (!/ (agent|customer): /.test(line)) {
          log(`${call.mediaChannel} ${line}`)
        }
      },
      connect: ({ instruction, tools, onClose }) =>
        connectGeminiLive({
          apiKey: config.geminiApiKey,
          model: config.liveModel,
          voice: config.voices[order.customer.language],
          instruction,
          tools,
          onClose,
        }),
    })
    call.dial().catch((error: unknown) => log(`Dial: ${String(error)}`))
    return call
  },
})

startMediaServer({
  port: MEDIA_PORT,
  onCall: (media, start) => dialer.attachMedia(media, start.channel_id),
})

/** Calls wait while Asterisk's events can't reach them. */
let connected = false
async function listen() {
  try {
    const socket = await ari.events((event) => dialer.onEvent(event))
    connected = true
    log("Connected to Asterisk")
    socket.once("close", () => {
      connected = false
      log("Asterisk's events stopped; reconnecting")
      setTimeout(listen, RECONNECT_MS)
    })
  } catch (error) {
    log(`Asterisk's events: ${String(error)}`)
    setTimeout(listen, RECONNECT_MS)
  }
}

/** Runs a job on a timer, skipping a turn while the last one is running. */
function every(ms: number, name: string, job: () => Promise<unknown>) {
  let running = false
  return setInterval(() => {
    if (running) {
      return
    }
    running = true
    job()
      .catch((error) => console.error(`${name} failed: ${String(error)}`))
      .finally(() => {
        running = false
      })
  }, ms)
}

const updateLines = async () =>
  dialer.updateLines(await readRegistrations(config.registrationsFile))
await updateLines()
await listen()
const timers = [
  every(1_000, "dial", async () => connected && dialer.dialQueued()),
  every(15_000, "lines", updateLines),
  every(60_000, "stale", () => dialer.endStale()),
]

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    timers.forEach(clearInterval)
    log("Stopping: no new calls; waiting for those in progress")
    void dialer.stop().finally(() => {
      void db.destroy()
      process.exit(0)
    })
  })
}
const allowed =
  config.allowedNumbers === "any"
    ? "any number"
    : `${config.allowedNumbers.size} allowed numbers only`
log(
  config.callsEnabled
    ? `Voice started; calls are on, to ${allowed}`
    : "Voice started; calls are off (CALLS_ENABLED isn't true)"
)
