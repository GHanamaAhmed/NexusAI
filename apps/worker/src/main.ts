import { generateDesign } from "@nexus/ai/generation"
import { parseCallWindow } from "@nexus/core"
import { createDb } from "@nexus/db"
import { loadConfig } from "./config.js"
import { deliverWebhooks } from "./deliver.js"
import { finishAttempts } from "./finish.js"
import {
  failStaleGenerations,
  GenerationRunner,
  purgeExpiredGenerations,
} from "./generate.js"
import { pingHealthcheck, purgeExpiredTasks } from "./housekeeping.js"
import { promoteDueTasks } from "./promote.js"

const config = loadConfig()
const db = createDb(config.databaseUrl)
const window = parseCallWindow(config.callWindow)

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

const timers = [
  every(10_000, "promote", () => promoteDueTasks(db, { window })),
  every(5_000, "finish", () => finishAttempts(db, { window })),
  every(5_000, "deliver", () => deliverWebhooks(db)),
  every(60 * 60_000, "purge", async () => {
    await purgeExpiredTasks(db)
    await purgeExpiredGenerations(db)
  }),
]
if (config.metaApiKey) {
  const apiKey = config.metaApiKey
  const runner = new GenerationRunner({
    db,
    limit: 2,
    log: (line) => console.log(line),
    generate: (input) =>
      generateDesign(input, {
        apiKey,
        baseUrl: config.metaApiUrl,
        log: (line) => console.log(line),
      }),
  })
  timers.push(
    every(3_000, "generate", () => runner.tick()),
    every(60_000, "stale generations", () =>
      failStaleGenerations(db, runner.runningIds)
    )
  )
}
if (config.healthcheckUrl) {
  const url = config.healthcheckUrl
  timers.push(every(60_000, "health", () => pingHealthcheck(db, url)))
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    timers.forEach(clearInterval)
    void db.destroy()
  })
}
console.log("Worker started")
