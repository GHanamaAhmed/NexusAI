import type { ConfirmationOrder } from "@nexus/conversation"
import {
  type CallWindow,
  type DialFormat,
  isWithinCallWindow,
  type Outcome,
  toDialString,
  unansweredOutcome,
} from "@nexus/core"
import type { Db } from "@nexus/db"
import type { AriEvent } from "./ari.js"
import type { CallResult } from "./call.js"
import { callCost } from "./cost.js"
import type { MediaCall } from "./media.js"

/**
 * An attempt queued longer than this goes back to the worker, which asks the
 * store again before calling: a long queue, or call hours ending, would
 * otherwise call about an order the merchant may have settled meanwhile.
 */
const QUEUE_LIMIT_MS = 15 * 60_000
/** A call still dialing after this belonged to a dialer that stopped. */
const STALE_CALL_MS = 5 * 60_000
/** Queued rows read per free slot, so one busy store doesn't hold the others back. */
const ROWS_PER_SLOT = 5

/** What the dialer needs from a call; Call provides it. */
export type ActiveCall = {
  readonly mediaChannel: string
  readonly done: Promise<CallResult>
  onEvent(event: AriEvent): Promise<void>
  attachMedia(media: MediaCall): Promise<void>
}

export type StartCall = (
  order: ConfirmationOrder,
  endpoint: string
) => ActiveCall

export type Limits = { perLine: number; total: number; perStore: number }

type Running = {
  call: ActiveCall
  line: string
  storeId: string
  mediaAttached: boolean
  /** Settles once the result is written. */
  recorded: Promise<void>
}

/**
 * Takes queued attempts and calls them, within the limits per line, in total
 * and per store, on the registered line with the fewest calls; then writes
 * each call's result for the worker to send on.
 */
export class Dialer {
  private readonly running = new Map<string, Running>()
  private registered = new Map<string, boolean>()
  private stopping = false

  constructor(
    private readonly deps: {
      db: Db
      startCall: StartCall
      /** Nothing is dialed while this is false. */
      callsEnabled: boolean
      window: CallWindow
      dialFormat: DialFormat
      limits: Limits
      log: (line: string) => void
    }
  ) {}

  private callsOn(line: string): number {
    return [...this.running.values()].filter((run) => run.line === line).length
  }

  /** Takes the lines' registrations, and records them with each line's calls. */
  async updateLines(registered: Map<string, boolean>, now = new Date()) {
    this.registered = registered
    for (const [line, isRegistered] of registered) {
      const values = {
        registered: isRegistered,
        in_flight: this.callsOn(line),
        updated_at: now,
      }
      await this.deps.db
        .insertInto("line_status")
        .values({ line, ...values })
        .onConflict((conflict) => conflict.column("line").doUpdateSet(values))
        .execute()
    }
  }

  /** Starts as many queued calls as the lines and limits allow. */
  async dialQueued(now = new Date()): Promise<number> {
    const { db, limits, callsEnabled, window } = this.deps
    if (!callsEnabled || this.stopping) {
      return 0
    }
    await this.requeueStale(now)
    const free = limits.total - this.running.size
    if (!isWithinCallWindow(now, window) || free <= 0) {
      return 0
    }
    const lineCalls = new Map(
      [...this.registered]
        .filter(([, isRegistered]) => isRegistered)
        .map(([line]) => [line, this.callsOn(line)])
    )
    const storeCalls = new Map<string, number>()
    for (const run of this.running.values()) {
      storeCalls.set(run.storeId, (storeCalls.get(run.storeId) ?? 0) + 1)
    }

    const chosen = await db.transaction().execute(async (trx) => {
      const queued = await trx
        .selectFrom("attempt")
        .innerJoin("task", "task.id", "attempt.task_id")
        .select(["attempt.id", "task.client_store_id", "task.payload"])
        .where("attempt.status", "=", "queued")
        .orderBy("attempt.queued_at")
        .limit(free * ROWS_PER_SLOT)
        .forUpdate("attempt")
        .skipLocked()
        .execute()
      const picks: { row: (typeof queued)[number]; line: string }[] = []
      for (const row of queued) {
        if (picks.length === free) {
          break
        }
        const storeId = row.client_store_id
        if ((storeCalls.get(storeId) ?? 0) >= limits.perStore) {
          continue
        }
        const line = [...lineCalls]
          .filter(([, calls]) => calls < limits.perLine)
          .sort(([a, x], [b, y]) => x - y || a.localeCompare(b))[0]?.[0]
        if (!line) {
          break
        }
        lineCalls.set(line, lineCalls.get(line)! + 1)
        storeCalls.set(storeId, (storeCalls.get(storeId) ?? 0) + 1)
        picks.push({ row, line })
        await trx
          .updateTable("attempt")
          .set({ status: "dialing", line, started_at: now })
          .where("id", "=", row.id)
          .execute()
      }
      return picks
    })

    for (const { row, line } of chosen) {
      try {
        this.start(row.id, row.client_store_id, row.payload, line)
      } catch (error) {
        // toDialString refuses anything but an Algerian mobile.
        this.deps.log(`Attempt ${row.id} not dialed: ${String(error)}`)
        await db
          .updateTable("attempt")
          .set({ status: "done", outcome: "invalid_number", ended_at: now })
          .where("id", "=", row.id)
          .execute()
      }
    }
    return chosen.length
  }

  private start(
    attemptId: string,
    storeId: string,
    payload: {
      store: ConfirmationOrder["store"]
      customer: ConfirmationOrder["customer"] & { phone: string }
      order: ConfirmationOrder["order"]
    },
    line: string
  ) {
    const { store, customer, order } = payload
    const call = this.deps.startCall(
      {
        store: { name: store.name },
        customer: { name: customer.name, language: customer.language },
        order: {
          items: order.items,
          total: order.total,
          delivery: order.delivery,
        },
      },
      `PJSIP/${toDialString(customer.phone, this.deps.dialFormat)}@${line}`
    )
    const recorded = call.done
      .then((result) => this.record(attemptId, result))
      .catch((error: unknown) =>
        this.deps.log(`Recording attempt ${attemptId}: ${String(error)}`)
      )
      .finally(() => this.running.delete(attemptId))
    this.running.set(attemptId, {
      call,
      line,
      storeId,
      mediaAttached: false,
      recorded,
    })
  }

  private async record(attemptId: string, result: CallResult) {
    const outcome: Outcome =
      result.outcome ??
      (result.answeredAt ? "no_input" : unansweredOutcome(result.cause))
    await this.deps.db
      .updateTable("attempt")
      .set({
        status: "done",
        ended_at: new Date(),
        answered_at: result.answeredAt,
        hangup_cause: result.cause,
        outcome,
        note: noteOf(outcome, result.args),
        callback_at: outcome === "call_later" ? callbackAt(result.args) : null,
        change: result.change ? JSON.stringify(result.change) : null,
        // The customer's side isn't kept: its transcription came out in
        // other languages, even when the model understood.
        transcript: result.agentSaid.length
          ? JSON.stringify(
              result.agentSaid.map((text) => ({ who: "agent", text }))
            )
          : null,
        cost: result.usage.promptTokens
          ? JSON.stringify(callCost(result.usage))
          : null,
      })
      .where("id", "=", attemptId)
      .execute()
  }

  /** Passes Asterisk's events on; each call keeps those about its channels. */
  onEvent(event: AriEvent) {
    for (const { call } of this.running.values()) {
      call.onEvent(event).catch((error: unknown) => {
        this.deps.log(`${event.type}: ${String(error)}`)
      })
    }
  }

  /**
   * Asterisk opened a call's audio. It joins the call whose channel it names,
   * and no other: a wrong match would let one customer hear another.
   */
  attachMedia(media: MediaCall, channelId: string | undefined) {
    const run = [...this.running.values()].find(
      (candidate) =>
        candidate.call.mediaChannel === channelId && !candidate.mediaAttached
    )
    if (!run) {
      this.deps.log(`Audio for no known call (${channelId}), hung up`)
      media.hangup()
      return
    }
    run.mediaAttached = true
    run.call.attachMedia(media).catch((error: unknown) => {
      this.deps.log(`Audio: ${String(error)}`)
    })
  }

  /**
   * Puts attempts queued too long back for the worker, as if never made: they
   * don't count as a try.
   */
  private async requeueStale(now: Date) {
    await this.deps.db.transaction().execute(async (trx) => {
      const stale = await trx
        .selectFrom("attempt")
        .select(["id", "task_id"])
        .where("status", "=", "queued")
        .where("queued_at", "<", new Date(now.getTime() - QUEUE_LIMIT_MS))
        .forUpdate()
        .skipLocked()
        .execute()
      if (stale.length === 0) {
        return
      }
      await trx
        .deleteFrom("attempt")
        .where(
          "id",
          "in",
          stale.map((attempt) => attempt.id)
        )
        .execute()
      await trx
        .updateTable("task")
        .set((eb) => ({
          status: "scheduled",
          attempts: eb("attempts", "-", 1),
          next_attempt_at: now,
        }))
        .where(
          "id",
          "in",
          stale.map((attempt) => attempt.task_id)
        )
        .execute()
    })
  }

  /**
   * Ends attempts a stopped dialer left mid-call, with no answer recorded, so
   * the worker tries them again.
   */
  async endStale(now = new Date()): Promise<number> {
    let query = this.deps.db
      .updateTable("attempt")
      .set({ status: "done", outcome: "no_input", ended_at: now })
      .where("status", "in", ["dialing", "answered"])
      .where("started_at", "<", new Date(now.getTime() - STALE_CALL_MS))
    const own = [...this.running.keys()]
    if (own.length > 0) {
      query = query.where("id", "not in", own)
    }
    const { numUpdatedRows } = await query.executeTakeFirst()
    return Number(numUpdatedRows)
  }

  /** Stops taking calls; resolves once the calls in progress are recorded. */
  async stop() {
    this.stopping = true
    await Promise.all([...this.running.values()].map((run) => run.recorded))
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * The customer's words the agent passed with the outcome: what, or why; and
 * when to call back, if that isn't a time callback_at can hold.
 */
function noteOf(outcome: Outcome, args: Record<string, unknown>) {
  const words =
    text(args.what) ||
    text(args.reason) ||
    (outcome === "call_later" && !callbackAt(args) ? text(args.when) : "")
  return words ? words.slice(0, 500) : null
}

/** The time the customer asked to be called back, when the agent gave one. */
function callbackAt(args: Record<string, unknown>): Date | null {
  const when = new Date(text(args.when))
  return Number.isNaN(when.getTime()) ? null : when
}
