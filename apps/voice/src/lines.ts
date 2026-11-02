import { readFile, stat } from "node:fs/promises"

/** A file older than this means Asterisk stopped writing it. */
const STALE_MS = 2 * 60_000

/**
 * Each line's registration, from Asterisk's "pjsip show registrations":
 *   line01-reg/sip:196.41.228.32:5070;transport=tls  line01-auth  Registered  (exp. 2998s)
 */
export function parseRegistrations(text: string): Map<string, boolean> {
  const lines = new Map<string, boolean>()
  for (const row of text.split("\n")) {
    const match = /^\s*(\S+)-reg\/\S+\s+\S+\s+(\S+)/.exec(row)
    if (match) {
      lines.set(match[1]!, match[2] === "Registered")
    }
  }
  return lines
}

/**
 * The registrations the Asterisk container writes every 30 seconds; none
 * when the file is missing or stale, so nothing is dialed.
 */
export async function readRegistrations(
  path: string,
  now = new Date()
): Promise<Map<string, boolean>> {
  try {
    const { mtime } = await stat(path)
    if (now.getTime() - mtime.getTime() > STALE_MS) {
      return new Map()
    }
    return parseRegistrations(await readFile(path, "utf8"))
  } catch {
    return new Map()
  }
}
