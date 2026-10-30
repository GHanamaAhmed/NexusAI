import { type CallWindow, isWithinCallWindow, nextOpening } from "@nexus/core"
import type { Db } from "@nexus/db"
import { sign } from "@nexus/webhooks"

const CHECK_TIMEOUT_MS = 5_000
const RETRY_CHECK_MS = 5 * 60_000
const BATCH = 20

export type CheckRequest = {
  url: string
  secret: string
  externalStoreId: string
  externalId: string
}

/** Asks the client whether a task is still wanted. Throws if it can't tell. */
export async function askClient(request: CheckRequest): Promise<boolean> {
  const body = JSON.stringify({
    external_store_id: request.externalStoreId,
    external_id: request.externalId,
  })
  const response = await fetch(request.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nexus-signature": sign(request.secret, body),
    },
    body,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`The check answered ${response.status}`)
  }
  const answer = (await response.json()) as { call?: unknown }
  if (typeof answer.call !== "boolean") {
    throw new Error("The check gave no answer")
  }
  return answer.call
}

/**
 * Takes the tasks that are due. Outside call hours they wait for the next
 * opening. Inside, each is checked with its client (outside the transaction,
 * so a slow client holds no lock) and either queued for a call or cancelled.
 */
export async function promoteDueTasks(
  db: Db,
  options: {
    window: CallWindow
    check?: (request: CheckRequest) => Promise<boolean>
    now?: Date
  }
): Promise<number> {
  const { window, check = askClient, now = new Date() } = options

  const claimed = await db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom("task")
      .select("id")
      .where("status", "=", "scheduled")
      .where("next_attempt_at", "<=", now)
      .orderBy("next_attempt_at")
      .limit(BATCH)
      .forUpdate()
      .skipLocked()
      .execute()
    const ids = due.map((task) => task.id)
    if (ids.length === 0) {
      return []
    }
    if (!isWithinCallWindow(now, window)) {
      await trx
        .updateTable("task")
        .set({ next_attempt_at: nextOpening(now, window) })
        .where("id", "in", ids)
        .execute()
      return []
    }
    await trx
      .updateTable("task")
      .set({ status: "calling" })
      .where("id", "in", ids)
      .execute()
    return ids
  })

  for (const id of claimed) {
    const task = await db
      .selectFrom("task")
      .innerJoin("account", "account.id", "task.account_id")
      .innerJoin("client_store", "client_store.id", "task.client_store_id")
      .select([
        "task.check_url",
        "task.external_id",
        "task.attempts",
        "account.webhook_secret",
        "client_store.external_id as external_store_id",
      ])
      .where("task.id", "=", id)
      .executeTakeFirstOrThrow()

    let wanted: boolean
    try {
      wanted = await check({
        url: task.check_url,
        secret: task.webhook_secret,
        externalStoreId: task.external_store_id,
        externalId: task.external_id,
      })
    } catch (error) {
      console.warn(`Check failed for task ${id}: ${String(error)}`)
      await db
        .updateTable("task")
        .set({
          status: "scheduled",
          next_attempt_at: new Date(now.getTime() + RETRY_CHECK_MS),
        })
        .where("id", "=", id)
        .execute()
      continue
    }

    if (!wanted) {
      await db
        .updateTable("task")
        .set({ status: "cancelled", completed_at: now })
        .where("id", "=", id)
        .execute()
      continue
    }

    const number = task.attempts + 1
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("attempt").values({ task_id: id, number }).execute()
      await trx
        .updateTable("task")
        .set({ attempts: number })
        .where("id", "=", id)
        .execute()
    })
  }
  return claimed.length
}
