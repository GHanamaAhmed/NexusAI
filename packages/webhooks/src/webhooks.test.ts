import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  deliver,
  MAX_TRIES,
  retryDelayMinutes,
  SIGNATURE_HEADER,
  sign,
  verify,
} from "./index.js"

const now = new Date("2026-10-30T12:00:00Z")

describe("signatures", () => {
  it("accepts what it signed", () => {
    expect(verify("secret", sign("secret", "{}", now), "{}", now)).toBe(true)
  })

  it("refuses another secret", () => {
    expect(verify("other", sign("secret", "{}", now), "{}", now)).toBe(false)
  })

  it("refuses a changed body", () => {
    expect(verify("secret", sign("secret", "{}", now), "{ }", now)).toBe(false)
  })

  it("refuses an old signature", () => {
    const later = new Date(now.getTime() + 301_000)
    expect(verify("secret", sign("secret", "{}", now), "{}", later)).toBe(false)
  })

  it.each([undefined, "", "t=1", "t=abc,v1=00", "v1=abc"])(
    "refuses the malformed header %s",
    (header) => {
      expect(verify("secret", header, "{}", now)).toBe(false)
    }
  )
})

describe("retries", () => {
  it("waits longer each time, then hourly, then gives up", () => {
    expect([1, 2, 3, 4, 5, 23].map(retryDelayMinutes)).toEqual([
      1, 5, 15, 60, 60, 60,
    ])
    expect(retryDelayMinutes(MAX_TRIES)).toBeNull()
  })
})

describe("deliver", () => {
  let server: Server | undefined

  afterEach(() => server?.close())

  async function serve(status: number) {
    const received: { body: string; signature?: string }[] = []
    server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        received.push({
          body,
          signature: request.headers[SIGNATURE_HEADER] as string,
        })
        response.writeHead(status).end()
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, resolve))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}/hook`, received }
  }

  it("sends a body the client can verify", async () => {
    const { url, received } = await serve(200)
    const result = await deliver({
      url,
      secret: "secret",
      deliveryId: "d1",
      body: '{"a":1}',
    })
    expect(result).toEqual({ ok: true })
    expect(verify("secret", received[0]!.signature, received[0]!.body)).toBe(
      true
    )
  })

  it("treats any other status as a failure", async () => {
    const { url } = await serve(500)
    expect(
      await deliver({ url, secret: "s", deliveryId: "d", body: "{}" })
    ).toEqual({ ok: false, error: "answered 500" })
  })

  it("reports a connection failure", async () => {
    const result = await deliver({
      url: "http://127.0.0.1:1/hook",
      secret: "s",
      deliveryId: "d",
      body: "{}",
    })
    expect(result.ok).toBe(false)
  })
})
