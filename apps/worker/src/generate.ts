import type { GenerationInput, GenerationOutcome } from "@nexus/ai/generation"
import type { Db } from "@nexus/db"

/**
 * A generation still running after this belonged to a worker that stopped. Two
 * text requests of at most 4 minutes each and the images fit well inside it.
 */
const STALE_MS = 15 * 60_000

export type Generate = (input: GenerationInput) => Promise<GenerationOutcome>

/**
 * Runs queued generations, a few at a time. A tick starts what it can and
 * returns; each generation records its own outcome when it ends.
 */
export class GenerationRunner {
  private readonly running = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: {
      db: Db
      generate: Generate
      /** Generations running at once. */
      limit: number
      log: (line: string) => void
    }
  ) {}

  /** The ids of the generations this worker is running. */
  get runningIds(): string[] {
    return [...this.running.keys()]
  }

  /** Starts as many queued generations as the limit allows. */
  async tick(now = new Date()): Promise<number> {
    const free = this.deps.limit - this.running.size
    if (free <= 0) {
      return 0
    }
    const claimed = await this.deps.db.transaction().execute(async (trx) => {
      const queued = await trx
        .selectFrom("generation")
        .select(["id", "input"])
        .where("status", "=", "queued")
        .orderBy("created_at")
        .limit(free)
        .forUpdate()
        .skipLocked()
        .execute()
      if (queued.length > 0) {
        await trx
          .updateTable("generation")
          .set({ status: "running", started_at: now })
          .where(
            "id",
            "in",
            queued.map((generation) => generation.id)
          )
          .execute()
      }
      return queued
    })
    for (const generation of claimed) {
      const run = this.run(
        generation.id,
        generation.input as unknown as GenerationInput
      ).finally(() => this.running.delete(generation.id))
      this.running.set(generation.id, run)
    }
    return claimed.length
  }

  /** Resolves once every generation started so far has ended. */
  async idle() {
    await Promise.all(this.running.values())
  }

  private async run(id: string, input: GenerationInput) {
    const { db, log } = this.deps
    const started = Date.now()
    try {
      const outcome = await this.deps.generate(input)
      await db.transaction().execute(async (trx) => {
        if (outcome.images.length > 0) {
          await trx
            .insertInto("generation_image")
            .values(
              outcome.images.map((image) => ({
                generation_id: id,
                slot: image.slot,
                shape: image.shape,
                format: image.format,
                bytes: image.bytes,
              }))
            )
            .execute()
        }
        await trx
          .updateTable("generation")
          .set({
            status: "done",
            result: JSON.stringify({
              design: outcome.design,
              images: outcome.images.map(({ slot, shape }) => ({
                slot,
                shape,
              })),
              problems: outcome.problems,
            }),
            cost: JSON.stringify(outcome.cost),
            finished_at: new Date(),
          })
          .where("id", "=", id)
          .execute()
      })
      log(
        `Generation ${id} done in ${Math.round((Date.now() - started) / 1000)} s, ${outcome.cost.usd} USD`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`Generation ${id} failed: ${message.slice(0, 200)}`)
      await db
        .updateTable("generation")
        .set({
          status: "failed",
          error: message.slice(0, 2_000),
          finished_at: new Date(),
        })
        .where("id", "=", id)
        .execute()
    }
  }
}

/**
 * Fails generations a stopped worker left running, so their client stops
 * waiting. `own` are this worker's, which are never stale.
 */
export async function failStaleGenerations(
  db: Db,
  own: string[],
  now = new Date()
): Promise<number> {
  let query = db
    .updateTable("generation")
    .set({ status: "failed", error: "interrupted", finished_at: now })
    .where("status", "=", "running")
    .where("started_at", "<", new Date(now.getTime() - STALE_MS))
  if (own.length > 0) {
    query = query.where("id", "not in", own)
  }
  const { numUpdatedRows } = await query.executeTakeFirst()
  return Number(numUpdatedRows)
}

/** Deletes generations past their time, with their images. */
export async function purgeExpiredGenerations(db: Db, now = new Date()) {
  const { numDeletedRows } = await db
    .deleteFrom("generation")
    .where("purge_after", "<", now)
    .executeTakeFirst()
  return Number(numDeletedRows)
}
