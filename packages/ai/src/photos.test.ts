import { describe, expect, it, vi } from "vitest"
import { inlinePhotos, MAX_PHOTO_BYTES } from "./photos.js"

const image = (
  bytes: Buffer,
  type = "image/jpeg",
  status = 200,
  headers: Record<string, string> = {}
) =>
  new Response(bytes, { status, headers: { "content-type": type, ...headers } })

describe("inlinePhotos", () => {
  it("downloads each photo and sends it inline, in order", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("a.jpg")
        ? image(Buffer.from("first"))
        : image(Buffer.from("second"), "image/webp; charset=binary")
    )
    const inlined = await inlinePhotos(
      ["https://files.example/a.jpg", "https://files.example/b.webp"],
      fetchImpl as unknown as typeof fetch
    )
    expect(inlined).toEqual([
      `data:image/jpeg;base64,${Buffer.from("first").toString("base64")}`,
      `data:image/webp;base64,${Buffer.from("second").toString("base64")}`,
    ])
  })

  it("keeps a photo already inline", async () => {
    const fetchImpl = vi.fn()
    expect(
      await inlinePhotos(
        ["data:image/png;base64,AAAA"],
        fetchImpl as unknown as typeof fetch
      )
    ).toEqual(["data:image/png;base64,AAAA"])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    [
      "http://files.example/a.jpg",
      () => image(Buffer.from("x")),
      "isn't an https address",
    ],
    [
      "https://files.example/a.jpg",
      () => image(Buffer.from("x"), "image/jpeg", 404),
      "couldn't be downloaded: 404",
    ],
    [
      "https://files.example/a.svg",
      () => image(Buffer.from("<svg/>"), "image/svg+xml"),
      "isn't a JPEG",
    ],
    [
      "https://files.example/a.html",
      () => image(Buffer.from("<p>"), "text/html"),
      "isn't a JPEG",
    ],
    [
      "https://files.example/big.jpg",
      () =>
        image(Buffer.from("x"), "image/jpeg", 200, {
          "content-length": String(MAX_PHOTO_BYTES + 1),
        }),
      "is over",
    ],
    [
      "https://files.example/big.jpg",
      () => image(Buffer.alloc(MAX_PHOTO_BYTES + 1)),
      "is over",
    ],
  ])("refuses %s (%#)", async (url, answer, reason) => {
    const fetchImpl = vi.fn(async () => answer())
    await expect(
      inlinePhotos([url], fetchImpl as unknown as typeof fetch)
    ).rejects.toMatchObject({
      message: expect.stringContaining(`photo 0 ${reason}`),
      retryable: false,
    })
  })

  it("refuses photos too large together", async () => {
    const fetchImpl = vi.fn(async () => image(Buffer.alloc(MAX_PHOTO_BYTES)))
    await expect(
      inlinePhotos(
        Array.from({ length: 5 }, (_, i) => `https://files.example/${i}.jpg`),
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toMatchObject({ message: expect.stringContaining("together") })
  })

  it("reports a download that fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND")
    })
    await expect(
      inlinePhotos(
        ["https://nowhere.example/a.jpg"],
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining("photo 0 couldn't be downloaded"),
    })
  })
})
