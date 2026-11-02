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

/**
 * How a call nobody answered ended, from its Q.850 hang-up cause. The ring
 * timeout, and causes the network doesn't explain, count as no answer.
 */
export function unansweredOutcome(cause: number | null): Outcome {
  switch (cause) {
    case 17: // user busy
    case 21: // call rejected: the customer declined it
      return "busy"
    case 1: // unallocated number
    case 28: // invalid number format
      return "invalid_number"
    case 20: // subscriber absent
    case 27: // destination out of order
    case 34: // no circuit available
      return "unreachable"
    default:
      return "no_answer"
  }
}
