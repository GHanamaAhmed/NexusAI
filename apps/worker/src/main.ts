import { parseCallWindow } from "@nexus/core"
import { createDb } from "@nexus/db"
import { loadConfig } from "./config.js"
import { deliverWebhooks } from "./deliver.js"
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
  every(5_000, "deliver", () => deliverWebhooks(db)),
  every(60 * 60_000, "purge", () => purgeExpiredTasks(db)),
]
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
