import WebSocket from "ws"

export type AriChannel = { id: string; state?: string }

export type AriEvent = {
  type: string
  channel?: AriChannel
  args?: string[]
  cause?: number
  cause_txt?: string
  digit?: string
}

/** Asterisk's REST interface and event stream, on this server. */
export class Ari {
  private readonly base: string
  private readonly auth: string

  constructor(
    private readonly app: string,
    private readonly user: string,
    private readonly password: string,
    private readonly host = "127.0.0.1:8088"
  ) {
    this.base = `http://${host}/ari`
    this.auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
  }

  async request(
    method: string,
    path: string,
    query: Record<string, string> = {}
  ): Promise<unknown> {
    const url = `${this.base}${path}?${new URLSearchParams(query)}`
    const response = await fetch(url, {
      method,
      headers: { authorization: this.auth },
    })
    if (!response.ok) {
      throw new Error(
        `${method} ${path}: ${response.status} ${await response.text()}`
      )
    }
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  /** Opens the event stream; resolves once it's connected. */
  events(listener: (event: AriEvent) => void): Promise<WebSocket> {
    const query = new URLSearchParams({
      app: this.app,
      api_key: `${this.user}:${this.password}`,
    })
    const socket = new WebSocket(`ws://${this.host}/ari/events?${query}`)
    socket.on("message", (data) => listener(JSON.parse(String(data))))
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket))
      socket.once("error", reject)
    })
  }
}
