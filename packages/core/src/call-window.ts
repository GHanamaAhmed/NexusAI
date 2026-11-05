/** The hours customers may be called, as minutes after local midnight. */
export type CallWindow = { opens: number; closes: number }

const TIME_ZONE = "Africa/Algiers"
const MINUTE_MS = 60_000
const DAY_MINUTES = 24 * 60

const WINDOW_PATTERN = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/

/** Reads a window such as "09:00-20:00". */
export function parseCallWindow(text: string): CallWindow {
  const match = WINDOW_PATTERN.exec(text)
  if (!match) {
    throw new Error(`Call window "${text}" is not HH:MM-HH:MM`)
  }
  const [, openHour, openMinute, closeHour, closeMinute] = match.map(Number)
  const opens = openHour! * 60 + openMinute!
  const closes = closeHour! * 60 + closeMinute!
  if (opens >= closes || closes > DAY_MINUTES) {
    throw new Error(`Call window "${text}" must open before it closes`)
  }
  return { opens, closes }
}

function localMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value)
  return part("hour") * 60 + part("minute")
}

/** The start of the minute `minutes` from now on the local clock. */
function afterMinutes(at: Date, minutes: number): Date {
  const start = new Date(at)
  start.setSeconds(0, 0)
  // Algeria keeps one UTC offset all year, so local minutes add up exactly.
  return new Date(start.getTime() + minutes * MINUTE_MS)
}

export function isWithinCallWindow(at: Date, window: CallWindow): boolean {
  const now = localMinutes(at)
  return now >= window.opens && now < window.closes
}

/** `at` if the window is open then, otherwise the moment it next opens. */
export function nextOpening(at: Date, window: CallWindow): Date {
  if (isWithinCallWindow(at, window)) {
    return at
  }
  const now = localMinutes(at)
  const wait =
    now < window.opens ? window.opens - now : DAY_MINUTES - now + window.opens
  return afterMinutes(at, wait)
}

/** The given local time on the day after `at`. */
export function nextDayAt(at: Date, minutes: number): Date {
  return afterMinutes(at, DAY_MINUTES - localMinutes(at) + minutes)
}

/** Call hours as an account saves them, such as `{ opens: "08:00", closes: "22:00" }`. */
export type CallHours = { opens: string; closes: string }

const HOURS_PATTERN = /^\d{2}:\d{2}$/

/**
 * An account's call window from its saved hours, or the platform's when it has
 * saved none or they can't be read, so calls never stop over them.
 */
export function callWindowFromHours(
  hours: unknown,
  fallback: CallWindow
): CallWindow {
  const value = hours as Partial<CallHours> | null | undefined
  if (
    !value ||
    typeof value.opens !== "string" ||
    typeof value.closes !== "string" ||
    !HOURS_PATTERN.test(value.opens) ||
    !HOURS_PATTERN.test(value.closes)
  ) {
    return fallback
  }
  try {
    return parseCallWindow(`${value.opens}-${value.closes}`)
  } catch {
    return fallback
  }
}

/** A window as hours, for a form to show. */
export function callHoursOf(window: CallWindow): CallHours {
  const clock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
  return { opens: clock(window.opens), closes: clock(window.closes) }
}
