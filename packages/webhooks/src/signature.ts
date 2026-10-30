import { createHmac, timingSafeEqual } from "node:crypto"

export const SIGNATURE_HEADER = "x-nexus-signature"
export const DELIVERY_HEADER = "x-nexus-delivery"

const DEFAULT_TOLERANCE_SECONDS = 300

function digest(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")
}

/** The signature header's value: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export function sign(secret: string, body: string, now = new Date()): string {
  const timestamp = Math.floor(now.getTime() / 1000)
  return `t=${timestamp},v1=${digest(secret, timestamp, body)}`
}

/** Whether a header was made with this secret, for this body, recently. */
export function verify(
  secret: string,
  header: string | undefined,
  body: string,
  now = new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "")
  if (!match) {
    return false
  }
  const timestamp = Number(match[1])
  const age = Math.abs(now.getTime() / 1000 - timestamp)
  if (age > toleranceSeconds) {
    return false
  }
  return timingSafeEqual(
    Buffer.from(match[2]!, "hex"),
    Buffer.from(digest(secret, timestamp, body), "hex")
  )
}
