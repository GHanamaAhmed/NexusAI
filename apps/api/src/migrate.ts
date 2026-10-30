import { createDb, migrateToLatest } from "@nexus/db"
import { loadConfig } from "./config.js"

const db = createDb(loadConfig().databaseUrl)
await migrateToLatest(db)
await db.destroy()
console.log("Migrations applied")
