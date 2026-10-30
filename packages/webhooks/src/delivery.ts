import { DELIVERY_HEADER, SIGNATURE_HEADER, sign } from "./signature.js"

const TIMEOUT_MS = 10_000
const RETRY_MINUTES = [1, 5, 15, 60]

export const MAX_TRIES = 24

export type DeliveryResult = { ok: true } | { ok: false; error: string }

/** Minutes to wait after failed try number `tries`, or null to give up. */
export function retryDelayMinutes(tries: number): number | null {
  if (tries >= MAX_TRIES) {
    return null
  }
  return RETRY_MINUTES[tries - 1] ?? 60
}

/** POSTs a signed JSON body. Only a 2xx answer counts as delivered. */
export async function deliver(input: {
  url: string
  secret: string
  deliveryId: string
  body: string
}): Promise<DeliveryResult> {
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: sign(input.secret, input.body),
        [DELIVERY_HEADER]: input.deliveryId,
      },
      body: input.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return response.ok
      ? { ok: true }
      : { ok: false, error: `answered ${response.status}` }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
