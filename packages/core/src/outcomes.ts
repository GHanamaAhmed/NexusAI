/** How an attempt to reach a customer ended. */
export const OUTCOMES = [
  "confirmed",
  "cancelled",
  "call_later",
  "talk_to_store",
  "no_answer",
  "busy",
  "machine",
  "unreachable",
  "no_input",
  "invalid_number",
  "wrong_number",
  "request_change",
] as const

export type Outcome = (typeof OUTCOMES)[number]

/** Outcomes that end the task; the others are retried while attempts remain. */
export const FINAL_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  "confirmed",
  "cancelled",
  "call_later",
  "talk_to_store",
  "invalid_number",
  "wrong_number",
  "request_change",
])
