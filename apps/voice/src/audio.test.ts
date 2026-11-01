import { describe, expect, it } from "vitest"
import { medianPitch, rms } from "./audio.js"

const RATE = 24_000

function tone(hz: number, seconds: number, amplitude = 8000): Buffer {
  const samples = Math.floor(RATE * seconds)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(
      Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)),
      i * 2
    )
  }
  return pcm
}

describe("audio", () => {
  it("measures loudness", () => {
    expect(rms(Buffer.alloc(960))).toBe(0)
    expect(rms(tone(200, 0.1))).toBeGreaterThan(5000)
  })

  it.each([110, 140, 210, 250])("finds a %i Hz voice", (hz) => {
    expect(Math.abs(medianPitch(tone(hz, 0.5), RATE)! - hz)).toBeLessThan(6)
  })

  it("finds nothing in silence", () => {
    expect(medianPitch(Buffer.alloc(RATE), RATE)).toBeNull()
  })
})
