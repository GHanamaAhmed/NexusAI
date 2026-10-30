import type { Db } from "@nexus/db"
import { deliver, retryDelayMinutes } from "@nexus/webhooks"

const BATCH = 20
const CLAIM_MS = 60_000

/**
 * Sends results that are due. Each row is claimed by moving its next try
 * forward, so no lock is held while waiting on the client, and a crash only
 * delays a delivery.
 */
export async function deliverWebhooks(
  db: Db,
  options: { send?: typeof deliver; now?: Date } = {}
): Promise<number> {
  const { send = deliver, now = new Date() } = options

  const due = await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("webhook_delivery")
      .innerJoin("task", "task.id", "webhook_delivery.task_id")
      .innerJoin("account", "account.id", "task.account_id")
      .select([
        "webhook_delivery.id",
        "webhook_delivery.body",
        "webhook_delivery.tries",
        "task.outcome_url",
        "account.webhook_secret",
      ])
      .where("webhook_delivery.status", "=", "pending")
      .where("webhook_delivery.next_try_at", "<=", now)
      .orderBy("webhook_delivery.next_try_at")
      .limit(BATCH)
      .forUpdate("webhook_delivery")
      .skipLocked()
      .execute()
    if (rows.length > 0) {
      await trx
        .updateTable("webhook_delivery")
        .set({ next_try_at: new Date(now.getTime() + CLAIM_MS) })
        .where(
          "id",
          "in",
          rows.map((row) => row.id)
        )
        .execute()
    }
    return rows
  })

  for (const row of due) {
    const result = await send({
      url: row.outcome_url,
      secret: row.webhook_secret,
      deliveryId: row.id,
      body: JSON.stringify(row.body),
    })
    const tries = row.tries + 1
    if (result.ok) {
      await db
        .updateTable("webhook_delivery")
        .set({
          status: "delivered",
          tries,
          delivered_at: now,
          last_error: null,
        })
        .where("id", "=", row.id)
        .execute()
      continue
    }
    const delay = retryDelayMinutes(tries)
    await db
      .updateTable("webhook_delivery")
      .set({
        tries,
        last_error: result.error,
        ...(delay === null
          ? { status: "failed" as const }
          : { next_try_at: new Date(now.getTime() + delay * 60_000) }),
      })
      .where("id", "=", row.id)
      .execute()
  }
  return due.length
}
