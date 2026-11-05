import { type CallWindow, callHoursOf } from "@nexus/core"
import {
  defaultVoiceSettings,
  fullVoiceSettings,
  modelInfo,
  MODELS,
  PROVIDER_KEY,
  readVoiceSettings,
  StyleSchema,
  greetingProblem,
  VoiceSettingsSchema,
} from "@nexus/ai/settings"
import {
  buildInstruction,
  DEFAULT_GREETING,
  DEFAULT_SPEAKING,
  sampleOrder,
} from "@nexus/conversation"
import type { Db } from "@nexus/db"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"

const PutBody = z
  .object({
    settings: VoiceSettingsSchema,
    version: z.number().int().min(0),
  })
  .strict()

const PreviewBody = z
  .object({
    language: z.enum(["ar", "fr"]),
    style: StyleSchema.optional(),
  })
  .strict()

const problemsOf = (error: z.ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }))

async function readRow(db: Db, accountId: string) {
  return db
    .selectFrom("voice_settings")
    .select(["settings", "version"])
    .where("account_id", "=", accountId)
    .executeTakeFirst()
}

/**
 * An account's voice settings: the models it can use and how calls sound. Each
 * account reads and changes only its own, with its own key.
 */
export function registerVoiceRoutes(
  app: FastifyInstance,
  options: {
    db: Db
    account: (request: FastifyRequest) => Promise<string | null>
    /** Whose API keys the voice app has: "gemini", "openai". */
    providers: Set<string>
    /** The platform's call hours, shown for an account that saved none. */
    callWindow: CallWindow
  }
) {
  const { db, account, providers, callWindow } = options
  const available = (provider: keyof typeof PROVIDER_KEY) =>
    providers.has(PROVIDER_KEY[provider])

  /** The account of the request, or a 401 already sent. */
  const authorized = async (
    request: FastifyRequest,
    reply: { code(status: number): { send(body: unknown): unknown } }
  ) => {
    const accountId = await account(request)
    if (!accountId) {
      reply.code(401).send({ code: "unauthorized" })
    }
    return accountId
  }

  app.get("/v1/voice/models", async (request, reply) => {
    if (!(await authorized(request, reply))) {
      return reply
    }
    return {
      models: MODELS.map((model) => ({
        ...model,
        available: available(model.provider),
      })),
    }
  })

  app.get("/v1/voice/settings", async (request, reply) => {
    const accountId = await authorized(request, reply)
    if (!accountId) {
      return reply
    }
    const row = await readRow(db, accountId)
    const settings = fullVoiceSettings(
      row ? readVoiceSettings(row.settings) : defaultVoiceSettings()
    )
    return {
      settings: {
        ...settings,
        call_hours: settings.call_hours ?? callHoursOf(callWindow),
      },
      version: row?.version ?? 0,
      defaults: { greeting: DEFAULT_GREETING, speaking: DEFAULT_SPEAKING },
    }
  })

  app.put("/v1/voice/settings", async (request, reply) => {
    const accountId = await authorized(request, reply)
    if (!accountId) {
      return reply
    }
    const body = PutBody.safeParse(request.body)
    if (!body.success) {
      return reply
        .code(400)
        .send({ code: "invalid_settings", problems: problemsOf(body.error) })
    }
    const { settings, version } = body.data
    if (!available(modelInfo(settings.active_model).provider)) {
      return reply.code(400).send({
        code: "model_unavailable",
        message: `${settings.active_model} has no API key here`,
      })
    }
    const value = JSON.stringify(settings)
    // Version 0 means there's no row yet; anything else must still be current,
    // so two admins can't overwrite each other.
    const saved =
      version === 0
        ? await db
            .insertInto("voice_settings")
            .values({ account_id: accountId, settings: value, version: 1 })
            .onConflict((conflict) => conflict.column("account_id").doNothing())
            .returning("version")
            .executeTakeFirst()
        : await db
            .updateTable("voice_settings")
            .set((eb) => ({
              settings: value,
              version: eb("version", "+", 1),
              updated_at: new Date(),
            }))
            .where("account_id", "=", accountId)
            .where("version", "=", version)
            .returning("version")
            .executeTakeFirst()
    if (!saved) {
      return reply.code(409).send({ code: "version_conflict" })
    }
    return { settings: fullVoiceSettings(settings), version: saved.version }
  })

  app.post("/v1/voice/preview", async (request, reply) => {
    const accountId = await authorized(request, reply)
    if (!accountId) {
      return reply
    }
    const body = PreviewBody.safeParse(request.body)
    if (!body.success) {
      return reply
        .code(400)
        .send({ code: "invalid_preview", problems: problemsOf(body.error) })
    }
    const { language } = body.data
    const greeting = body.data.style?.greeting
    const problem = greeting ? greetingProblem(greeting) : null
    if (problem) {
      return reply.code(400).send({
        code: "invalid_preview",
        problems: [{ path: "style.greeting", message: problem }],
      })
    }
    let style = body.data.style
    if (!style) {
      const row = await readRow(db, accountId)
      style = row ? readVoiceSettings(row.settings).style[language] : undefined
    }
    return {
      instruction: buildInstruction(sampleOrder(language), new Date(), style),
    }
  })
}
