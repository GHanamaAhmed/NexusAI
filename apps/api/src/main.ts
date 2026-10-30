import { parseCallWindow } from "@nexus/core"
import { createDb } from "@nexus/db"
import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"

const config = loadConfig()
const db = createDb(config.databaseUrl)
const app = await buildApp({
  db,
  callWindow: parseCallWindow(config.callWindow),
  allowHttpCallbacks: config.allowHttpCallbacks,
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void app.close().then(() => db.destroy())
  })
}

await app.listen({ host: "0.0.0.0", port: config.port })
