import { EventEmitter } from "node:events"
import type { ConfirmationOrder } from "@nexus/conversation"
import { parseCallWindow } from "@nexus/core"
import type { Db, TaskPayload } from "@nexus/db"
import { createTestDb, resetTestDb } from "@nexus/db/testing"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { WebSocket } from "ws"
import type { AriEvent } from "./ari.js"
import type { CallResult } from "./call.js"
import { type ActiveCall, Dialer, type Limits } from "./dialer.js"
import { MediaCall } from "./media.js"

const window = parseCallWindow("09:00-20:00")
const noon = new Date("2026-10-30T11:00:00Z") // 12:00 in Algiers
const night = new Date("2026-10-30T22:00:00Z") // 23:00 in Algiers
const FRAME = 960

const noUsage = {
  promptTokens: 0,
  responseTokens: 0,
  promptAudioTokens: 0,
  cachedTokens: 0,
  responseAudioTokens: 0,
}
const result = (overrides: Partial<CallResult> = {}): CallResult => ({
  outcome: null,
  args: {},
  change: null,
  cause: 16,
  answeredAt: null,
  usage: noUsage,
  agentSaid: [],
  ...overrides,
})

let made = 0

class FakeCall implements ActiveCall {
  readonly mediaChannel = `ws-${++made}`
  readonly events: AriEvent[] = []
  media?: MediaCall
  finish!: (result: CallResult) => void
  readonly done = new Promise<CallResult>((resolve) => (this.finish = resolve))
  constructor(
    readonly order: ConfirmationOrder,
    readonly endpoint: string
  ) {}
  async onEvent(event: AriEvent) {
    this.events.push(event)
  }
  async attachMedia(media: MediaCall) {
    this.media = media
  }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sent: unknown[] = []
  send(data: unknown) {
    this.sent.push(data)
  }
}

const payload = (phone: string): TaskPayload => ({
  store: { name: "متجر الياسمين" },
  customer: { name: "سارة", phone, language: "ar" },
  order: {
    items: [{ title: "قميص قطن", quantity: 2 }],
    total: 6500,
    currency: "DZD",
    delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
  },
})

describe("Dialer", () => {
  let db: Db
  let calls: FakeCall[]
  let sockets: FakeSocket[]
  let accountId: string

  beforeAll(async () => {
    db = await createTestDb()
  })
  beforeEach(async () => {
    await resetTestDb(db)
    calls = []
    sockets = []
    const account = await db
      .insertInto("account")
      .values({ name: "One", webhook_secret: "secret" })
      .returning("id")
      .executeTakeFirstOrThrow()
    accountId = account.id
  })
  afterEach(() => sockets.forEach((socket) => socket.emit("close")))
  afterAll(() => db.destroy())

  function makeDialer(
    options: { callsEnabled?: boolean; limits?: Partial<Limits> } = {}
  ) {
    return new Dialer({
      db,
      callsEnabled: options.callsEnabled ?? true,
      window,
      dialFormat: "national",
      limits: { perLine: 1, total: 10, perStore: 3, ...options.limits },
      log: () => {},
      startCall: (order, endpoint) => {
        const call = new FakeCall(order, endpoint)
        calls.push(call)
        return call
      },
    })
  }

  const lines = (...names: string[]) =>
    new Map(names.map((name) => [name.replace("!", ""), !name.endsWith("!")]))

  /** Queues one attempt per phone for a store, a second apart. */
  async function queue(store: string, phones: string[], at = noon) {
    const { id: storeId } = await db
      .insertInto("client_store")
      .values({ account_id: accountId, external_id: store, name: store })
      .onConflict((conflict) =>
        conflict.columns(["account_id", "external_id"]).doUpdateSet({
          name: store,
        })
      )
      .returning("id")
      .executeTakeFirstOrThrow()
    const ids: string[] = []
    for (const [index, phone] of phones.entries()) {
      const { id: taskId } = await db
        .insertInto("task")
        .values({
          account_id: accountId,
          client_store_id: storeId,
          type: "order_confirmation",
          external_id: `${store}-${phone}`,
          idempotency_key: `${store}-${phone}`,
          payload: JSON.stringify(payload(phone)),
          language: "ar",
          outcome_url: "https://client.example.com/outcome",
          check_url: "https://client.example.com/check",
          status: "calling",
          attempts: 1,
          next_attempt_at: at,
          purge_after: new Date(at.getTime() + 86_400_000),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const { id } = await db
        .insertInto("attempt")
        .values({
          task_id: taskId,
          number: 1,
          queued_at: new Date(at.getTime() - 60_000 + index * 1000),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      ids.push(id)
    }
    return ids
  }

  const readAttempt = (id: string) =>
    db
      .selectFrom("attempt")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow()

  /** Ends a call and waits for its result to be written. */
  async function finish(call: FakeCall, id: string, ended: CallResult) {
    call.finish(ended)
    await vi.waitFor(async () =>
      expect((await readAttempt(id)).status).toBe("done")
    )
  }

  it("dials nothing while calls are off", async () => {
    const [id] = await queue("store-a", ["+213551234567"])
    const dialer = makeDialer({ callsEnabled: false })
    await dialer.updateLines(lines("line01"), noon)
    expect(await dialer.dialQueued(noon)).toBe(0)
    expect(calls).toEqual([])
    expect((await readAttempt(id!)).status).toBe("queued")
  })

  it("dials queued attempts on the free registered lines, oldest first", async () => {
    const ids = await queue("store-a", ["+213551234567", "+213661234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01", "line02!", "line03"), noon)
    expect(await dialer.dialQueued(noon)).toBe(2)
    expect(calls.map((call) => call.endpoint)).toEqual([
      "PJSIP/0551234567@line01",
      "PJSIP/0661234567@line03",
    ])
    expect(calls[0]!.order).toEqual({
      store: { name: "متجر الياسمين" },
      customer: { name: "سارة", language: "ar" },
      order: {
        items: [{ title: "قميص قطن", quantity: 2 }],
        total: 6500,
        delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
      },
    })
    expect(await readAttempt(ids[0]!)).toMatchObject({
      status: "dialing",
      line: "line01",
      started_at: noon,
    })
  })

  it("keeps to the limits per store and in total", async () => {
    await queue("store-a", ["+213550000001", "+213550000002", "+213550000003"])
    await queue(
      "store-b",
      ["+213660000001", "+213660000002"],
      new Date(noon.getTime() + 10_000)
    )
    const dialer = makeDialer({ limits: { total: 3, perStore: 2 } })
    await dialer.updateLines(
      lines("line01", "line02", "line03", "line04"),
      noon
    )
    expect(await dialer.dialQueued(noon)).toBe(3)
    expect(calls.map((call) => call.endpoint.slice(6, 9))).toEqual([
      "055",
      "055",
      "066",
    ])
    expect(new Set(calls.map((call) => call.endpoint.split("@")[1])).size).toBe(
      3
    )
    expect(await dialer.dialQueued(noon)).toBe(0)
  })

  it("frees the line once the call is recorded", async () => {
    const ids = await queue("store-a", ["+213551234567", "+213661234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01"), noon)
    expect(await dialer.dialQueued(noon)).toBe(1)
    expect(await dialer.dialQueued(noon)).toBe(0)
    await finish(calls[0]!, ids[0]!, result({ cause: 17 }))
    expect(await dialer.dialQueued(noon)).toBe(1)
    expect(calls[1]!.endpoint).toBe("PJSIP/0661234567@line01")
  })

  it("records a number it can't dial without dialing it", async () => {
    const [id] = await queue("store-a", ["+33612345678"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01"), noon)
    expect(await dialer.dialQueued(noon)).toBe(1)
    expect(calls).toEqual([])
    expect(await readAttempt(id!)).toMatchObject({
      status: "done",
      outcome: "invalid_number",
    })
  })

  it("records an answered call: outcome, words, place, transcript and cost", async () => {
    const [id] = await queue("store-a", ["+213551234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01"), noon)
    await dialer.dialQueued(noon)
    const change = { wilaya_code: 1, commune_ar: "رقان", commune_fr: "Reggane" }
    await finish(
      calls[0]!,
      id!,
      result({
        outcome: "request_change",
        args: {
          what: "بدل لرقان",
          wilaya_code: "1",
          commune: "رقان",
          yes: "إيه",
        },
        change,
        answeredAt: noon,
        usage: {
          promptTokens: 20_000,
          responseTokens: 650,
          promptAudioTokens: 8_000,
          cachedTokens: 0,
          responseAudioTokens: 650,
        },
        agentSaid: ["السلام عليكم، معايا سارة؟"],
      })
    )
    const attempt = await readAttempt(id!)
    expect(attempt).toMatchObject({
      status: "done",
      outcome: "request_change",
      note: "بدل لرقان",
      change,
      answered_at: noon,
      hangup_cause: 16,
      transcript: [{ who: "agent", text: "السلام عليكم، معايا سارة؟" }],
      callback_at: null,
    })
    expect(attempt.cost).toMatchObject({ usd: 0.0408 })
  })

  it.each([
    [{ cause: 17 }, "busy"],
    [{ cause: 19 }, "no_answer"],
    [{ cause: 1 }, "invalid_number"],
    [{ cause: 16, answeredAt: noon }, "no_input"],
  ] as const)("records %o as %s", async (ended, outcome) => {
    const [id] = await queue("store-a", ["+213551234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01"), noon)
    await dialer.dialQueued(noon)
    await finish(calls[0]!, id!, result(ended))
    expect(await readAttempt(id!)).toMatchObject({ outcome, cost: null })
  })

  it("keeps when to call back, and the words when they aren't a time", async () => {
    const ids = await queue("store-a", ["+213551234567", "+213661234567"])
    const dialer = makeDialer({ limits: { perLine: 2 } })
    await dialer.updateLines(lines("line01"), noon)
    await dialer.dialQueued(noon)
    const later = { outcome: "call_later", answeredAt: noon } as const
    await finish(
      calls[0]!,
      ids[0]!,
      result({ ...later, args: { when: "2026-10-31T15:00:00+01:00" } })
    )
    await finish(
      calls[1]!,
      ids[1]!,
      result({ ...later, args: { when: "بعد العصر" } })
    )
    expect(await readAttempt(ids[0]!)).toMatchObject({
      callback_at: new Date("2026-10-31T14:00:00Z"),
      note: null,
    })
    expect(await readAttempt(ids[1]!)).toMatchObject({
      callback_at: null,
      note: "بعد العصر",
    })
  })

  it("joins audio only to the call that named it", async () => {
    await queue("store-a", ["+213551234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01"), noon)
    await dialer.dialQueued(noon)
    const media = () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return new MediaCall(socket as unknown as WebSocket, FRAME, 24_000)
    }

    const own = media()
    dialer.attachMedia(own, calls[0]!.mediaChannel)
    expect(calls[0]!.media).toBe(own)

    for (const channel of ["ws-unknown", calls[0]!.mediaChannel, undefined]) {
      const stray = media()
      dialer.attachMedia(stray, channel)
      expect(sockets.at(-1)!.sent).toContain('{"command":"HANGUP"}')
      expect(calls[0]!.media).toBe(own)
    }
  })

  it("passes Asterisk's events to each call", async () => {
    await queue("store-a", ["+213551234567", "+213661234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01", "line02"), noon)
    await dialer.dialQueued(noon)
    const event = { type: "StasisStart", channel: { id: "call-x" } }
    dialer.onEvent(event)
    expect(calls.map((call) => call.events)).toEqual([[event], [event]])
  })

  it("puts back attempts left in the queue, without counting a try", async () => {
    const [id] = await queue("store-a", ["+213551234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01"), night)
    expect(await dialer.dialQueued(night)).toBe(0)
    expect(calls).toEqual([])
    await expect(readAttempt(id!)).rejects.toThrow()
    const task = await db
      .selectFrom("task")
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(task).toMatchObject({
      status: "scheduled",
      attempts: 0,
      next_attempt_at: night,
    })
  })

  it("ends attempts a stopped dialer left mid-call", async () => {
    const ids = await queue("store-a", ["+213551234567", "+213661234567"])
    await db
      .updateTable("attempt")
      .set({
        status: "dialing",
        started_at: new Date(noon.getTime() - 10 * 60_000),
      })
      .where("id", "=", ids[0]!)
      .execute()
    await db
      .updateTable("attempt")
      .set({ status: "dialing", started_at: new Date(noon.getTime() - 60_000) })
      .where("id", "=", ids[1]!)
      .execute()
    expect(await makeDialer().endStale(noon)).toBe(1)
    expect(await readAttempt(ids[0]!)).toMatchObject({
      status: "done",
      outcome: "no_input",
    })
    expect((await readAttempt(ids[1]!)).status).toBe("dialing")
  })

  it("records each line's registration and calls", async () => {
    await queue("store-a", ["+213551234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01", "line02!"), noon)
    await dialer.dialQueued(noon)
    await dialer.updateLines(lines("line01", "line02!"), noon)
    const rows = await db
      .selectFrom("line_status")
      .select(["line", "registered", "in_flight"])
      .orderBy("line")
      .execute()
    expect(rows).toEqual([
      { line: "line01", registered: true, in_flight: 1 },
      { line: "line02", registered: false, in_flight: 0 },
    ])
  })

  it("stops dialing at once, and waits for the calls in progress", async () => {
    const [id] = await queue("store-a", ["+213551234567", "+213661234567"])
    const dialer = makeDialer()
    await dialer.updateLines(lines("line01", "line02"), noon)
    await dialer.dialQueued(noon)
    expect(calls).toHaveLength(2)
    await queue("store-b", ["+213770000001"])
    let stopped = false
    const stopping = dialer.stop().then(() => (stopped = true))
    expect(await dialer.dialQueued(noon)).toBe(0)
    calls[0]!.finish(result({ cause: 17 }))
    await vi.waitFor(async () =>
      expect((await readAttempt(id!)).status).toBe("done")
    )
    expect(stopped).toBe(false)
    calls[1]!.finish(result({ cause: 17 }))
    await stopping
    expect(stopped).toBe(true)
  })
})
