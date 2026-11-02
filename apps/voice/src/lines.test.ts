import { mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseRegistrations, readRegistrations } from "./lines.js"

const OUTPUT = `
 <Registration/ServerURI..............................>  <Auth....................>  <Status.......>
==========================================================================================

 line01-reg/sip:196.41.228.32:5070;transport=tls         line01-auth                 Registered        (exp. 2998s)
 line02-reg/sip:196.41.228.32:5070;transport=tls         line02-auth                 Rejected
 line03-reg/sip:196.41.228.32:5070;transport=tls         line03-auth                 Unregistered

Objects found: 3
`

describe("line registrations", () => {
  it("reads each line's status", () => {
    expect(parseRegistrations(OUTPUT)).toEqual(
      new Map([
        ["line01", true],
        ["line02", false],
        ["line03", false],
      ])
    )
  })

  it("reads a fresh file, and none from a stale or missing one", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lines-"))
    const file = join(folder, "registrations.txt")
    await writeFile(file, OUTPUT)
    expect((await readRegistrations(file)).get("line01")).toBe(true)

    const old = new Date(Date.now() - 3 * 60_000)
    await utimes(file, old, old)
    expect(await readRegistrations(file)).toEqual(new Map())
    expect(await readRegistrations(join(folder, "missing.txt"))).toEqual(
      new Map()
    )
  })
})
