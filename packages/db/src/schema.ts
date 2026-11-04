import type {
  ColumnType,
  Generated,
  Insertable,
  JSONColumnType,
  Selectable,
} from "kysely"

type CreatedAt = ColumnType<Date, Date | undefined, never>
type Timestamp = ColumnType<Date, Date, Date>
type NullableTimestamp = ColumnType<
  Date | null,
  Date | null | undefined,
  Date | null
>

export type TaskStatus = "scheduled" | "calling" | "done" | "cancelled"
export type AttemptStatus = "queued" | "dialing" | "answered" | "done"
export type DeliveryStatus = "pending" | "delivered" | "failed"
export type TaskLanguage = "ar" | "fr"
export type DeliveryEvent = "task.attempted" | "task.completed"

/** A new place the customer confirmed on a call. */
export type AttemptChange = {
  wilaya_code: number
  commune_ar: string
  commune_fr: string
}

/** What a task needs to say and do; the client's system stays the record. */
export type TaskPayload = {
  store: { name: string }
  customer: { name: string; phone: string; language: TaskLanguage }
  order: {
    items: { title: string; quantity: number }[]
    total: number
    currency: "DZD"
    delivery: {
      type: "home" | "stop_desk"
      /** 1-69, after the 2026 reform. */
      wilaya_code: number
      /** The commune's name in Arabic or French; read as sent if it isn't on the list. */
      commune: string | null
    }
  }
}

export interface AccountTable {
  id: Generated<string>
  name: string
  webhook_secret: string
  created_at: CreatedAt
}

export interface ApiKeyTable {
  id: Generated<string>
  account_id: string
  prefix: string
  key_hash: string
  created_at: CreatedAt
  revoked_at: NullableTimestamp
}

export interface ClientStoreTable {
  id: Generated<string>
  account_id: string
  external_id: string
  name: string
  created_at: CreatedAt
}

export interface TaskTable {
  id: Generated<string>
  account_id: string
  client_store_id: string
  type: "order_confirmation"
  external_id: string
  idempotency_key: string
  reference: string | null
  payload: JSONColumnType<TaskPayload>
  language: TaskLanguage
  outcome_url: string
  check_url: string
  status: ColumnType<TaskStatus, TaskStatus | undefined, TaskStatus>
  attempts: ColumnType<number, number | undefined, number>
  next_attempt_at: Timestamp
  outcome: string | null
  created_at: CreatedAt
  completed_at: NullableTimestamp
  purge_after: Timestamp
}

export interface AttemptTable {
  id: Generated<string>
  task_id: string
  number: number
  line: string | null
  status: ColumnType<AttemptStatus, AttemptStatus | undefined, AttemptStatus>
  queued_at: CreatedAt
  started_at: NullableTimestamp
  answered_at: NullableTimestamp
  ended_at: NullableTimestamp
  hangup_cause: number | null
  amd_status: string | null
  digits: string | null
  outcome: string | null
  note: string | null
  transcript: JSONColumnType<{ who: string; text: string }[]> | null
  cost: JSONColumnType<Record<string, number | string>> | null
  change: JSONColumnType<AttemptChange> | null
  /** When the customer asked to be called back. */
  callback_at: NullableTimestamp
}

export interface WebhookDeliveryTable {
  id: Generated<string>
  task_id: string
  attempt_id: string
  event: DeliveryEvent
  body: JSONColumnType<Record<string, unknown>>
  status: ColumnType<DeliveryStatus, DeliveryStatus | undefined, DeliveryStatus>
  tries: ColumnType<number, number | undefined, number>
  next_try_at: Timestamp
  last_error: string | null
  delivered_at: NullableTimestamp
}

export interface LineStatusTable {
  line: string
  registered: boolean
  in_flight: ColumnType<number, number | undefined, number>
  updated_at: Timestamp
}

export interface VoiceSettingsTable {
  account_id: string
  settings: JSONColumnType<Record<string, unknown>>
  version: ColumnType<number, number | undefined, number>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

export type GenerationStatus = "queued" | "running" | "done" | "failed"

export interface GenerationTable {
  id: Generated<string>
  account_id: string
  idempotency_key: string
  external_store_id: string
  status: ColumnType<GenerationStatus, GenerationStatus | undefined>
  input: JSONColumnType<Record<string, unknown>>
  result: JSONColumnType<
    Record<string, unknown> | null,
    string | null,
    string | null
  >
  error: string | null
  cost: JSONColumnType<
    Record<string, unknown> | null,
    string | null,
    string | null
  >
  created_at: CreatedAt
  started_at: NullableTimestamp
  finished_at: NullableTimestamp
  purge_after: Timestamp
}

export interface GenerationImageTable {
  generation_id: string
  slot: number
  shape: "wide" | "tall"
  format: string
  bytes: Buffer
}

export interface Database {
  account: AccountTable
  api_key: ApiKeyTable
  client_store: ClientStoreTable
  task: TaskTable
  attempt: AttemptTable
  webhook_delivery: WebhookDeliveryTable
  line_status: LineStatusTable
  voice_settings: VoiceSettingsTable
  generation: GenerationTable
  generation_image: GenerationImageTable
}

export type Task = Selectable<TaskTable>
export type NewTask = Insertable<TaskTable>
export type Attempt = Selectable<AttemptTable>
