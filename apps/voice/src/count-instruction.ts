import { GoogleGenAI } from "@google/genai"
import { buildInstruction } from "@nexus/conversation"

/** Counts the call instruction's tokens, which every turn of a call bills again. */
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
      delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
    },
  },
  new Date()
)
const { totalTokens } = await ai.models.countTokens({
  model: "gemini-3.8-flash",
  contents: [{ role: "user", parts: [{ text: instruction }] }],
})
console.log(`instruction: ${totalTokens} tokens`)
