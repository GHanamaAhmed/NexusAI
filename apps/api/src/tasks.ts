import { type CallWindow, firstAttemptAt, isAlgerianMobile } from "@nexus/core"
import type { Db, TaskPayload } from "@nexus/db"
import { z } from "zod"

const RETENTION_MS = 30 * 24 * 60 * 60_000

/** A task as a platform sends it. */
export function taskInputSchema(allowHttpCallbacks: boolean) {
  const callback = z
    .url()
    .refine(
      (url) => allowHttpCallbacks || url.startsWith("https://"),
      "must be https"
    )
  return z
    .object({
      type: z.literal("order_confirmation"),
      external_store_id: z.string().min(1).max(100),
      external_id: z.string().min(1).max(100),
      reference: z.string().max(40).optional(),
      store: z.object({ name: z.string().min(1).max(80) }).strict(),
      customer: z
        .object({
          phone: z
            .string()
            .refine(isAlgerianMobile, "not an Algerian mobile in +213 form"),
          language: z.enum(["ar", "fr"]),
        })
        .strict(),
      order: z
        .object({
          items: z
            .array(
              z
                .object({
                  title: z.string().min(1).max(120),
                  quantity: z.number().int().min(1).max(99),
                })
                .strict()
            )
            .min(1)
            .max(30),
          total: z.number().int().min(0),
          currency: z.literal("DZD"),
          delivery: z
            .object({
              type: z.enum(["home", "stop_desk"]),
              region: z.string().max(60),
              city: z.string().max(60).nullable(),
            })
            .strict(),
        })
        .strict(),
      mode: z.enum(["keypad", "spoken"]).default("keypad"),
      callbacks: z
        .object({ outcome_url: callback, check_url: callback })
        .strict(),
    })
    .strict()
}

export type TaskInput = z.infer<ReturnType<typeof taskInputSchema>>

/** Creates a task, or returns the one already made with this key. */
export async function createTask(
  db: Db,
  input: {
    accountId: string
    idempotencyKey: string
    task: TaskInput
    window: CallWindow
    now?: Date
  }
) {
  const { accountId, idempotencyKey, task, window } = input
  const now = input.now ?? new Date()

  const { id: clientStoreId } = await db
    .insertInto("client_store")
    .values({
      account_id: accountId,
      external_id: task.external_store_id,
      name: task.store.name,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["account_id", "external_id"])
        .doUpdateSet({ name: task.store.name })
    )
    .returning("id")
    .executeTakeFirstOrThrow()

  const payload: TaskPayload = {
    store: task.store,
    customer: task.customer,
    order: task.order,
  }
  const created = await db
    .insertInto("task")
    .values({
      account_id: accountId,
      client_store_id: clientStoreId,
      type: task.type,
      external_id: task.external_id,
      idempotency_key: idempotencyKey,
      reference: task.reference ?? null,
      payload: JSON.stringify(payload),
      language: task.customer.language,
      mode: task.mode,
      outcome_url: task.callbacks.outcome_url,
      check_url: task.callbacks.check_url,
      next_attempt_at: firstAttemptAt(now, window),
      outcome: null,
      purge_after: new Date(now.getTime() + RETENTION_MS),
    })
    .onConflict((conflict) =>
      conflict.columns(["account_id", "idempotency_key"]).doNothing()
    )
    .returning(["id", "status"])
    .executeTakeFirst()
  if (created) {
    return { ...created, created: true }
  }

  const existing = await db
    .selectFrom("task")
    .select(["id", "status"])
    .where("account_id", "=", accountId)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirstOrThrow()
  return { ...existing, created: false }
}
