/** Meta's Model API, shared by its text and image clients. */
export const META_API_URL = "https://api.meta.ai/v1"

/** A request the provider refused or didn't finish. */
export class GenerationError extends Error {
  constructor(
    message: string,
    /** Whether trying again later may work: rate limits and outages. */
    readonly retryable: boolean
  ) {
    super(message)
    this.name = "GenerationError"
  }
}

export type MetaRequest = {
  apiKey: string
  /** Meta's address, for tests; the real one when left out. */
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/** Sends a JSON request; an answer that isn't 2xx is a GenerationError. */
export async function postJson(
  request: MetaRequest,
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<Response> {
  const fetchImpl = request.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${request.baseUrl ?? META_API_URL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new GenerationError(`no answer: ${String(error)}`, true)
  }
  if (!response.ok) {
    throw new GenerationError(
      `answered ${response.status}: ${await errorText(response)}`,
      response.status === 429 || response.status >= 500
    )
  }
  return response
}

/** The provider's own reason, short, from an error answer. */
async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "")
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; code?: string }
    }
    const reason = body.error?.message ?? body.error?.code
    if (reason) {
      return reason.slice(0, 300)
    }
  } catch {
    // Not JSON; the text itself is the reason.
  }
  return text.slice(0, 300)
}
