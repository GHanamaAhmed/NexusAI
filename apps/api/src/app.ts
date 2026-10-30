import rateLimit from "@fastify/rate-limit"
import { type CallWindow } from "@nexus/core"
import type { Db } from "@nexus/db"
import Fastify, { type FastifyRequest } from "fastify"
import { sql } from "kysely"
import { z } from "zod"
import { accountForKey } from "./keys.js"
import { createTask, taskInputSchema } from "./tasks.js"

const IdParam = z.object({ id: z.uuid() })
const IdempotencyKey = z.string().min(1).max(200)

export async function buildApp(options: {
  db: Db
  callWindow: CallWindow
  allowHttpCallbacks: boolean
}) {
  const { db, callWindow } = options
  const TaskInput = taskInputSchema(options.allowHttpCallbacks)
  const app = Fastify({ logger: process.env.NODE_ENV === "production" })

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.headers.authorization ?? request.ip,
  })

  /** The account of the request's key, or null when it has no valid key. */
  async function account(request: FastifyRequest) {
    const [scheme, key] = (request.headers.authorization ?? "").split(" ")
    return scheme === "Bearer" && key ? accountForKey(db, key) : null
  }

  app.get("/health", async (_request, reply) => {
    try {
      await sql`SELECT 1`.execute(db)
      return { ok: true }
    } catch {
      return reply.code(503).send({ ok: false })
    }
  })

  app.post("/v1/tasks", async (request, reply) => {
    const accountId = await account(request)
    if (!accountId) {
      return reply.code(401).send({ code: "unauthorized" })
    }
    const key = IdempotencyKey.safeParse(request.headers["idempotency-key"])
    if (!key.success) {
      return reply.code(400).send({ code: "idempotency_key_required" })
    }
    const body = TaskInput.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({
        code: "invalid_task",
        problems: body.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }
    const task = await createTask(db, {
      accountId,
      idempotencyKey: key.data,
      task: body.data,
      window: callWindow,
    })
    return reply
      .code(task.created ? 201 : 200)
      .send({ id: task.id, status: task.status })
  })

  app.get("/v1/tasks/:id", async (request, reply) => {
    const accountId = await account(request)
    if (!accountId) {
      return reply.code(401).send({ code: "unauthorized" })
    }
    const params = IdParam.safeParse(request.params)
    const task =
      params.success &&
      (await db
        .selectFrom("task")
        .select([
          "id",
          "external_id",
          "status",
          "attempts",
          "next_attempt_at",
          "outcome",
          "created_at",
          "completed_at",
        ])
        .where("id", "=", params.data.id)
        .where("account_id", "=", accountId)
        .executeTakeFirst())
    if (!task) {
      return reply.code(404).send({ code: "not_found" })
    }
    const attempts = await db
      .selectFrom("attempt")
      .select(["number", "status", "outcome", "note", "hangup_cause"])
      .where("task_id", "=", task.id)
      .orderBy("number")
      .execute()
    return { ...task, attempts_detail: attempts }
  })

  app.delete("/v1/tasks/:id", async (request, reply) => {
    const accountId = await account(request)
    if (!accountId) {
      return reply.code(401).send({ code: "unauthorized" })
    }
    const params = IdParam.safeParse(request.params)
    if (!params.success) {
      return reply.code(404).send({ code: "not_found" })
    }
    const cancelled = await db
      .updateTable("task")
      .set({ status: "cancelled", completed_at: new Date() })
      .where("id", "=", params.data.id)
      .where("account_id", "=", accountId)
      .where("status", "=", "scheduled")
      .returning("id")
      .executeTakeFirst()
    if (cancelled) {
      return { id: cancelled.id, status: "cancelled" }
    }
    const exists = await db
      .selectFrom("task")
      .select("status")
      .where("id", "=", params.data.id)
      .where("account_id", "=", accountId)
      .executeTakeFirst()
    return exists
      ? reply.code(409).send({ code: "not_cancellable", status: exists.status })
      : reply.code(404).send({ code: "not_found" })
  })

  return app
}
