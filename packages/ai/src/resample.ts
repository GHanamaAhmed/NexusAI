/**
 * Changes 16-bit little-endian PCM's sample rate by straight lines between
 * samples. Each frame stands alone, which a voice model's ear doesn't notice at
 * 20 ms a frame.
 */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) {
    return pcm
  }
  const samples = Math.floor(pcm.length / 2)
  const length = Math.round((samples * to) / from)
  const output = Buffer.alloc(length * 2)
  for (let i = 0; i < length; i++) {
    const position = (i * from) / to
    const before = Math.floor(position)
    const after = Math.min(before + 1, samples - 1)
    const a = pcm.readInt16LE(before * 2)
    const b = pcm.readInt16LE(after * 2)
    output.writeInt16LE(Math.round(a + (b - a) * (position - before)), i * 2)
  }
  return output
}
