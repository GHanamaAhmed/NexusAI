import { GoogleGenAI } from "@google/genai"
import { buildInstruction, WILAYAS } from "@nexus/conversation"

/** Counts the call instruction's tokens, with and without the wilaya list. */
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })
const instruction = buildInstruction(
  {
    store: { name: "متجر الياسمين" },
    customer: { name: "غنامة أحمد", language: "ar" },
    order: {
      items: [
        { title: "قميص قطن", quantity: 2 },
        { title: "صباط رياضي", quantity: 1 },
      ],
      total: 6500,
      delivery: { type: "home", region: "الجزائر", city: "باب الزوار" },
    },
  },
  new Date()
)
const count = async (text: string) =>
  (
    await ai.models.countTokens({
      model: "gemini-3.8-flash",
      contents: [{ role: "user", parts: [{ text }] }],
    })
  ).totalTokens
console.log(`instruction: ${await count(instruction)} tokens`)
console.log(`wilaya list alone: ${await count(WILAYAS.join("، "))} tokens`)
