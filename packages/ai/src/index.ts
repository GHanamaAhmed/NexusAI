/** Turns text into 8 kHz A-law, the phone line's own format. */
export interface Speech {
  render(input: {
    text: string
    voice: string
    style?: string
  }): Promise<{ audio: Buffer; seconds: number }>
}
