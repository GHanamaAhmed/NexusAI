import { describe, expect, it } from "vitest"
import { resample } from "./resample.js"

const pcm = (...samples: number[]) => {
  const buffer = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2))
  return buffer
}
const samplesOf = (buffer: Buffer) =>
  Array.from({ length: buffer.length / 2 }, (_, i) => buffer.readInt16LE(i * 2))

describe("resample", () => {
  it("returns the same audio at the same rate", () => {
    const audio = pcm(1, 2, 3)
    expect(resample(audio, 24_000, 24_000)).toBe(audio)
  })

  it.each([
    [8_000, 24_000, 160, 480],
    [16_000, 24_000, 320, 480],
    [24_000, 16_000, 480, 320],
    [24_000, 8_000, 480, 160],
  ])("from %d to %d turns %d samples into %d", (from, to, before, after) => {
    const output = resample(Buffer.alloc(before * 2), from, to)
    expect(output.length).toBe(after * 2)
  })

  it("keeps silence silent", () => {
    const output = resample(Buffer.alloc(320), 8_000, 24_000)
    expect(samplesOf(output).every((sample) => sample === 0)).toBe(true)
  })

  it("draws straight lines between samples", () => {
    expect(samplesOf(resample(pcm(0, 300), 8_000, 24_000))).toEqual([
      0, 100, 200, 300, 300, 300,
    ])
  })

  it("takes every third sample going down by three", () => {
    expect(samplesOf(resample(pcm(1, 2, 3, 4, 5, 6), 24_000, 8_000))).toEqual([
      1, 4,
    ])
  })

  it("ignores half a sample", () => {
    expect(samplesOf(resample(Buffer.from([0, 0, 9]), 8_000, 16_000))).toEqual([
      0, 0,
    ])
  })

  it("takes nothing", () => {
    expect(resample(Buffer.alloc(0), 8_000, 24_000)).toHaveLength(0)
  })
})
