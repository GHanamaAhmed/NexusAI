/** Loudness of 16-bit little-endian PCM, as root mean square. */
export function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0) {
    return 0
  }
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2)
    sum += value * value
  }
  return Math.sqrt(sum / samples)
}

const MIN_HZ = 70
const MAX_HZ = 350
const WINDOW_MS = 40
const VOICED_RMS = 500

/**
 * The typical pitch of a voice in 16-bit PCM, in hertz, or null when there's
 * too little voiced sound. Below about 160 Hz is usually a man's voice, above a
 * woman's: enough to notice a voice changing mid-call.
 */
export function medianPitch(pcm: Buffer, sampleRate: number): number | null {
  const window = Math.floor((sampleRate * WINDOW_MS) / 1000)
  const minLag = Math.floor(sampleRate / MAX_HZ)
  const maxLag = Math.floor(sampleRate / MIN_HZ)
  const total = Math.floor(pcm.length / 2)
  const pitches: number[] = []

  for (let start = 0; start + window + maxLag < total; start += window) {
    const frame = new Float64Array(window + maxLag)
    for (let i = 0; i < frame.length; i++) {
      frame[i] = pcm.readInt16LE((start + i) * 2)
    }
    let energy = 0
    for (let i = 0; i < window; i++) {
      energy += frame[i]! * frame[i]!
    }
    if (Math.sqrt(energy / window) < VOICED_RMS) {
      continue
    }
    let bestLag = 0
    let best = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      for (let i = 0; i < window; i++) {
        sum += frame[i]! * frame[i + lag]!
      }
      if (sum > best) {
        best = sum
        bestLag = lag
      }
    }
    if (bestLag && best / energy > 0.5) {
      pitches.push(sampleRate / bestLag)
    }
  }
  if (pitches.length < 5) {
    return null
  }
  pitches.sort((a, b) => a - b)
  return Math.round(pitches[Math.floor(pitches.length / 2)]!)
}
