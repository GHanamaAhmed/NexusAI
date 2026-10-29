import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { GoogleGenAI } from "@google/genai"

/**
 * Renders the line check's samples: one made-up order read by several Gemini
 * voices, and its total said three ways, in 8 kHz A-law (the phone line's own
 * format). The test call plays them in order and asks for a key after each,
 * so the listener can rate the voices. samples.json says what each file is.
 */

const MODEL = "gemini-3.8-flash-tts"
const API = "https://generativelanguage.googleapis.com/v1beta"
const DARIJA_STYLE =
  "Algerian Darija with a natural Algiers accent, warm and clear, at a calm phone pace"
const DESIGNED_VOICE =
  "A warm woman from Algiers in her thirties, speaking Algerian Darija naturally, " +
  "mixing French words as Algerians do, clear on the phone"

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  throw new Error("Set GEMINI_API_KEY")
}
const outDir = process.env.OUT_DIR ?? "/srv/nexus/sounds/samples"
const ai = new GoogleGenAI({ apiKey })

const DARIJA_OPENING =
  "السلام عليكم، هذي مكالمة أوتوماتيكية من متجر الياسمين. " +
  "طلبتو زوج قمجان قطن و صباط رياضي، "
const DARIJA_CLOSING =
  " مع التوصيل، التوصيل للدار في باب الزوار، الجزائر. " +
  "باش تأكدو الطلبية اضغطو واحد. باش تلغيوها اضغطو زوج. " +
  "باش تهدرو مع المحل اضغطو ثلاثة."

const DARIJA_TOTALS = {
  digits: "المجموع 6500 دينار",
  words: "المجموع ستة آلاف و خمسمية دينار",
  centimes: "المجموع ستمية و خمسين ألف",
}

const FRENCH_ORDER =
  "Bonjour, ceci est un appel automatique de la boutique Yasmine. " +
  "Vous avez commandé deux chemises en coton et une paire de baskets, " +
  "pour un total de 6500 dinars, livraison comprise, livrée à domicile " +
  "à Bab Ezzouar, Alger. Pour confirmer la commande, appuyez sur 1. " +
  "Pour l'annuler, appuyez sur 2. Pour parler au magasin, appuyez sur 3."

const PRESS_A_KEY = "إذا عجبكم هذا الصوت اضغطو واحد، إذا ما عجبكمش اضغطو زوج."
const DIGITS = [
  "صفر",
  "واحد",
  "زوج",
  "ثلاثة",
  "ربعة",
  "خمسة",
  "ستة",
  "سبعة",
  "ثمنية",
  "تسعة",
]

type Sample = { voice: string; text: string; style?: string; note: string }

async function main() {
  await mkdir(outDir, { recursive: true })

  const darija = DARIJA_OPENING + DARIJA_TOTALS.digits + DARIJA_CLOSING
  const samples: Sample[] = ["Kore", "Puck", "Charon"].map((voice) => ({
    voice,
    text: darija,
    style: DARIJA_STYLE,
    note: `prebuilt ${voice}, Darija`,
  }))

  for (const voice of await regionalVoices()) {
    samples.push({
      voice: voice.id,
      text: darija,
      note: `library ${voice.name}, Darija`,
    })
  }

  const designed = await designVoice()
  if (designed) {
    samples.push({ voice: designed, text: darija, note: "designed, Darija" })
  }

  const totalsVoice = designed ?? "Kore"
  for (const style of ["words", "centimes"] as const) {
    samples.push({
      voice: totalsVoice,
      text: DARIJA_OPENING + DARIJA_TOTALS[style] + DARIJA_CLOSING,
      style: designed ? undefined : DARIJA_STYLE,
      note: `total in ${style}, ${designed ? "designed" : "Kore"}`,
    })
  }

  for (const voice of ["Kore", "Charon"]) {
    samples.push({
      voice,
      text: FRENCH_ORDER,
      note: `prebuilt ${voice}, French`,
    })
  }

  const index: Record<string, Sample> = {}
  for (const [i, sample] of samples.entries()) {
    const file = `sample-${i + 1}.alaw`
    await writeFile(join(outDir, file), await speak(sample))
    index[file] = sample
    console.log(`${file}: ${sample.note}`)
  }

  await writeFile(
    join(outDir, "press-a-key.alaw"),
    await speak({ voice: totalsVoice, text: PRESS_A_KEY, note: "prompt" })
  )
  for (const [digit, word] of DIGITS.entries()) {
    await writeFile(
      join(outDir, `digit-${digit}.alaw`),
      await speak({ voice: totalsVoice, text: word, note: "digit" })
    )
  }
  await writeFile(
    join(outDir, "samples.json"),
    JSON.stringify(index, null, 2) + "\n"
  )
}

/** Text to 8 kHz A-law, streamed as the Interactions API documents it. */
async function speak(sample: Sample): Promise<Buffer> {
  const stream = await ai.interactions.create({
    model: MODEL,
    input: [
      {
        type: "user_input",
        content: [
          {
            type: "text",
            text: sample.text,
            ...(sample.style
              ? {
                  annotations: [
                    { type: "speech_metadata", style: sample.style },
                  ],
                }
              : {}),
          },
        ],
      },
    ],
    response_format: {
      type: "audio",
      mime_type: "audio/alaw",
      sample_rate: 8000,
    },
    generation_config: { speech_config: [{ voice: sample.voice }] },
    stream: true,
  })

  const chunks: Buffer[] = []
  for await (const event of stream) {
    if (
      event.event_type === "step.delta" &&
      event.delta.type === "audio" &&
      event.delta.data
    ) {
      chunks.push(Buffer.from(event.delta.data, "base64"))
    }
  }
  if (chunks.length === 0) {
    throw new Error(`No audio for "${sample.note}"`)
  }
  return Buffer.concat(chunks)
}

/** Voices in Google's library tagged with Algeria, if there are any. */
async function regionalVoices(): Promise<{ id: string; name: string }[]> {
  const response = await fetch(`${API}/voices?region_code=DZ&page_size=20`, {
    headers: { "x-goog-api-key": apiKey! },
  })
  if (!response.ok) {
    console.warn(`Voice library: ${response.status} ${await response.text()}`)
    return []
  }
  const body = (await response.json()) as {
    voices?: { id?: string; name?: string; display_name?: string }[]
  }
  return (body.voices ?? []).slice(0, 3).flatMap((voice) => {
    const id = voice.id ?? voice.name?.split("/").pop()
    return id ? [{ id, name: voice.display_name ?? id }] : []
  })
}

/** A voice made from a written description ("Voice design"), or null. */
async function designVoice(): Promise<string | null> {
  const response = await fetch(`${API}/voices`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey!,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      store: true,
      voice: {
        model: MODEL,
        type: "prompted",
        display_name: "darija-algiers-1",
        language_code: "ar",
        prompted: { input: DESIGNED_VOICE },
      },
    }),
  })
  if (!response.ok) {
    console.warn(`Voice design: ${response.status} ${await response.text()}`)
    return null
  }
  const body = (await response.json()) as { id?: string; name?: string }
  return body.id ?? body.name?.split("/").pop() ?? null
}

await main()
