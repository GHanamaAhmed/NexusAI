import {
  type DialFormat,
  parseAllowedNumbers,
  parseCallWindow,
} from "@nexus/core"

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Set ${name}`)
  }
  return value
}

function count(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a whole number above 0`)
  }
  return parsed
}

export function loadConfig() {
  const dialFormat = (process.env.DIAL_FORMAT ?? "national") as DialFormat
  if (dialFormat !== "national" && dialFormat !== "international") {
    throw new Error("DIAL_FORMAT is national or international")
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    geminiApiKey: required("GEMINI_API_KEY"),
    ariPassword: required("ARI_PASSWORD"),
    /** Nothing is dialed unless this is "true". */
    callsEnabled: process.env.CALLS_ENABLED === "true",
    /** Calls go only to these numbers; unset allows none. */
    allowedNumbers: parseAllowedNumbers(process.env.ALLOWED_NUMBERS),
    callWindow: parseCallWindow(process.env.CALL_WINDOW ?? "09:00-20:00"),
    dialFormat,
    limits: {
      perLine: count("MAX_CALLS_PER_LINE", 1),
      total: count("MAX_CALLS_TOTAL", 10),
      perStore: count("MAX_CALLS_PER_STORE", 3),
    },
    registrationsFile:
      process.env.REGISTRATIONS_FILE ??
      "/var/run/asterisk/nexus/registrations.txt",
    liveModel: process.env.LIVE_MODEL || undefined,
    voices: {
      ar: process.env.VOICE_AR ?? "Callirrhoe",
      fr: process.env.VOICE_FR ?? "Kore",
    },
  }
}
