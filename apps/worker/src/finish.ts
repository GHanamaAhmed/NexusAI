import {
  type CallWindow,
  FINAL_OUTCOMES,
  MAX_ATTEMPTS,
  nextAttemptAt,
  type Outcome,
} from "@nexus/core"
import type { AttemptChange, Db, DeliveryEvent } from "@nexus/db"

const BATCH = 20

/** The result sent to the client after each attempt. */
export type ResultBody = {
  event: DeliveryEvent
  task_id: string
  attempt_id: string
  external_store_id: string
  external_id: string
  reference: string | null
  /** This attempt's number, from 1 to max_attempts. */
  attempt: number
  max_attempts: number
  outcome: Outcome
  /** The customer's words the agent passed: what to change, or why. */
  note: string | null
  /** When the customer asked to be called back, with call_later. */
  callback_at: string | null
  /** The new place the customer confirmed, with request_change. */
  change: AttemptChange | null
  ended_at: string
}

/**
 * Turns finished attempts into results for the client. A final outcome, or
 * the last attempt, completes the task; otherwise the next attempt is
 * scheduled. The task and its result change in one transaction, so a result
 * is never lost or made twice.
 */
export async function finishAttempts(
  db: Db,
  options: { window: CallWindow; now?: Date }
): Promise<number> {
  const { window, now = new Date() } = options
  return db.transaction().execute(async (trx) => {
    const finished = await trx
      .selectFrom("attempt")
      .innerJoin("task", "task.id", "attempt.task_id")
      .innerJoin("client_store", "client_store.id", "task.client_store_id")
      .leftJoin("webhook_delivery", "webhook_delivery.attempt_id", "attempt.id")
      .select([
        "attempt.id",
        "attempt.task_id",
        "attempt.number",
        "attempt.outcome",
        "attempt.note",
        "attempt.callback_at",
        "attempt.change",
        "attempt.ended_at",
        "task.external_id",
        "task.reference",
        "client_store.external_id as external_store_id",
      ])
      .where("attempt.status", "=", "done")
      .where("task.status", "=", "calling")
      .where("webhook_delivery.id", "is", null)
      .orderBy("attempt.ended_at")
      .limit(BATCH)
      .forUpdate("attempt")
      .skipLocked()
      .execute()

    for (const attempt of finished) {
      const outcome = (attempt.outcome ?? "no_input") as Outcome
      const endedAt = attempt.ended_at ?? now
      const next = FINAL_OUTCOMES.has(outcome)
        ? null
        : nextAttemptAt(attempt.number, endedAt, window)
      await trx
        .updateTable("task")
        .set(
          next
            ? { status: "scheduled", next_attempt_at: next }
            : { status: "done", outcome, completed_at: now }
        )
        .where("id", "=", attempt.task_id)
        .execute()

      const body: ResultBody = {
        event: next ? "task.attempted" : "task.completed",
        task_id: attempt.task_id,
        attempt_id: attempt.id,
        external_store_id: attempt.external_store_id,
        external_id: attempt.external_id,
        reference: attempt.reference,
        attempt: attempt.number,
        max_attempts: MAX_ATTEMPTS,
        outcome,
        note: attempt.note,
        callback_at: attempt.callback_at?.toISOString() ?? null,
        change: attempt.change,
        ended_at: endedAt.toISOString(),
      }
      await trx
        .insertInto("webhook_delivery")
        .values({
          task_id: attempt.task_id,
          attempt_id: attempt.id,
          event: body.event,
          body: JSON.stringify(body),
          next_try_at: now,
        })
        .execute()
    }
    return finished.length
  })
}
