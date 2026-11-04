import { designSchemaProblem } from "@nexus/ai/generation"
import type { Db } from "@nexus/db"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

const RETENTION_MS = 7 * 24 * 60 * 60_000
/** Generations an account may have waiting or running at once. */
const ACCOUNT_LIMIT = 3

const IdParam = z.object({ id: z.uuid() })
const ImageParam = z.object({ id: z.uuid(), slot: z.coerce.number().int() })
const IdempotencyKey = z.string().min(1).max(200)

const GenerationInput = z
  .object({
    external_store_id: z.string().min(1).max(100),
    schema: z.record(z.string(), z.unknown()),
    instructions: z.string().max(20_000),
    brief: z.string().min(1).max(4_000),
    photos: z
      .array(
        z.url().refine((url) => url.startsWith("https://"), "must be https")
      )
      .max(8),
    language: z.enum(["ar", "fr"]),
    max_generated_images: z.number().int().min(0).max(4),
  })
  .strict()

/**
 * Designs a client asks for: it sends its own parts as a JSON Schema, and the
 * worker designs from them. Each account reads only its own.
 */
export function registerGenerationRoutes(
  app: FastifyInstance,
  options: {
    db: Db
    account: (request: FastifyRequest) => Promise<string | null>
    /** Whose API keys the worker has for designing. */
    providers: Set<string>
  }
) {
  const { db, account, providers } = options

  const authorized = async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = await account(request)
    if (!accountId) {
      reply.code(401).send({ code: "unauthorized" })
    }
    return accountId
  }

  app.post("/v1/generations", async (request, reply) => {
    const accountId = await authorized(request, reply)
    if (!accountId) {
      return reply
    }
    if (!providers.has("meta")) {
      return reply.code(503).send({ code: "generation_unavailable" })
    }
    const key = IdempotencyKey.safeParse(request.headers["idempotency-key"])
    if (!key.success) {
      return reply.code(400).send({ code: "idempotency_key_required" })
    }
    const body = GenerationInput.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({
        code: "invalid_generation",
        problems: body.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }
    const schemaProblem = designSchemaProblem(body.data.schema)
    if (schemaProblem) {
      return reply.code(400).send({
        code: "invalid_generation",
        problems: [{ path: "schema", message: schemaProblem }],
      })
    }

    const existing = await db
      .selectFrom("generation")
      .select(["id", "status"])
      .where("account_id", "=", accountId)
      .where("idempotency_key", "=", key.data)
      .executeTakeFirst()
    if (existing) {
      return reply.code(200).send(existing)
    }
    const { count } = await db
      .selectFrom("generation")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("account_id", "=", accountId)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirstOrThrow()
    if (Number(count) >= ACCOUNT_LIMIT) {
      return reply.code(429).send({ code: "too_many_generations" })
    }

    const { external_store_id, ...input } = body.data
    const created = await db
      .insertInto("generation")
      .values({
        account_id: accountId,
        idempotency_key: key.data,
        external_store_id,
        input: JSON.stringify(input),
        purge_after: new Date(Date.now() + RETENTION_MS),
      })
      .onConflict((conflict) =>
        conflict.columns(["account_id", "idempotency_key"]).doNothing()
      )
      .returning(["id", "status"])
      .executeTakeFirst()
    if (!created) {
      // The same key arrived twice at once; the other request made it.
      const made = await db
        .selectFrom("generation")
        .select(["id", "status"])
        .where("account_id", "=", accountId)
        .where("idempotency_key", "=", key.data)
        .executeTakeFirstOrThrow()
      return reply.code(200).send(made)
    }
    return reply.code(202).send(created)
  })

  app.get("/v1/generations/:id", async (request, reply) => {
    const accountId = await authorized(request, reply)
    if (!accountId) {
      return reply
    }
    const params = IdParam.safeParse(request.params)
    const generation =
      params.success &&
      (await db
        .selectFrom("generation")
        .select([
          "id",
          "external_store_id",
          "status",
          "result",
          "error",
          "cost",
          "created_at",
          "started_at",
          "finished_at",
        ])
        .where("id", "=", params.data.id)
        .where("account_id", "=", accountId)
        .executeTakeFirst())
    if (!generation) {
      return reply.code(404).send({ code: "not_found" })
    }
    return generation
  })

  app.get("/v1/generations/:id/images/:slot", async (request, reply) => {
    const accountId = await authorized(request, reply)
    if (!accountId) {
      return reply
    }
    const params = ImageParam.safeParse(request.params)
    const image =
      params.success &&
      (await db
        .selectFrom("generation_image")
        .innerJoin(
          "generation",
          "generation.id",
          "generation_image.generation_id"
        )
        .select(["generation_image.bytes", "generation_image.format"])
        .where("generation.id", "=", params.data.id)
        .where("generation.account_id", "=", accountId)
        .where("generation_image.slot", "=", params.data.slot)
        .executeTakeFirst())
    if (!image) {
      return reply.code(404).send({ code: "not_found" })
    }
    return reply.type(`image/${image.format}`).send(image.bytes)
  })
}
