import { type CallWindow, nextDayAt, nextOpening } from "./call-window.js"

export const MAX_ATTEMPTS = 3

/** The wait before the first call when the client names none, in minutes. */
export const DEFAULT_FIRST_CALL_DELAY_MINUTES = 2
/** The longest wait a client may ask for: a day. */
export const MAX_FIRST_CALL_DELAY_MINUTES = 24 * 60
const SECOND_DELAY_MS = 60 * 60_000
const NEXT_DAY_MINUTES = 10 * 60 // 10:00 local

/**
 * The first call comes after the client's wait, 2 minutes unless it names
 * another, at the next moment the call hours are open.
 */
export function firstAttemptAt(
  createdAt: Date,
  window: CallWindow,
  delayMinutes: number = DEFAULT_FIRST_CALL_DELAY_MINUTES
): Date {
  return nextOpening(
    new Date(createdAt.getTime() + delayMinutes * 60_000),
    window
  )
}

/** When to call again after attempt `number` failed; null after the last. */
export function nextAttemptAt(
  number: number,
  lastAt: Date,
  window: CallWindow
): Date | null {
  if (number >= MAX_ATTEMPTS) {
    return null
  }
  const next =
    number === 1
      ? new Date(lastAt.getTime() + SECOND_DELAY_MS)
      : nextDayAt(lastAt, NEXT_DAY_MINUTES)
  return nextOpening(next, window)
}
