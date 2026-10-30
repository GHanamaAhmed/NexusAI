import { type CallWindow, nextDayAt, nextOpening } from "./call-window.js"

export const MAX_ATTEMPTS = 3

const FIRST_DELAY_MS = 2 * 60_000
const SECOND_DELAY_MS = 60 * 60_000
const NEXT_DAY_MINUTES = 10 * 60 // 10:00 local

/** The first call comes shortly after the order, while it's on their mind. */
export function firstAttemptAt(createdAt: Date, window: CallWindow): Date {
  return nextOpening(new Date(createdAt.getTime() + FIRST_DELAY_MS), window)
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
