import type { Db } from "@nexus/db"
import { sql } from "kysely"

const LINES_STALE_MS = 5 * 60_000

/** Deletes tasks past their retention, with their attempts and deliveries. */
export async function purgeExpiredTasks(db: Db, now = new Date()) {
  const { numDeletedRows } = await db
    .deleteFrom("task")
    .where("purge_after", "<", now)
    .executeTakeFirst()
  return Number(numDeletedRows)
}

/** Healthy when the database answers and a line registered in the last while. */
export async function isHealthy(db: Db, now = new Date()): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db)
    const line = await db
      .selectFrom("line_status")
      .select("line")
      .where("registered", "=", true)
      .where("updated_at", ">", new Date(now.getTime() - LINES_STALE_MS))
      .limit(1)
      .executeTakeFirst()
    return line !== undefined
  } catch {
    return false
  }
}

/** Pings the health check, on its failure address when something is wrong. */
export async function pingHealthcheck(db: Db, url: string) {
  const target = (await isHealthy(db)) ? url : `${url}/fail`
  await fetch(target, { signal: AbortSignal.timeout(10_000) })
}
