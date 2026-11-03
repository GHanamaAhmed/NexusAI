import type { ConfirmationOrder } from "@nexus/conversation"
import { checkTestNumber, openTestLine } from "./test-line.js"

/**
 * One spoken test call with a made-up order:
 *   tsx src/demo.ts +213XXXXXXXXX [line] [ar|fr] [voice]
 * Prints the conversation, the outcome and the tokens used. It runs next to
 * the voice app (test-line.ts).
 */

const [phone = "", line = "line01", language = "ar", voice] =
  process.argv.slice(2)
if (language !== "ar" && language !== "fr") {
  throw new Error("Usage: demo.ts +213XXXXXXXXX [line] [ar|fr] [voice]")
}
checkTestNumber(phone)

const order: ConfirmationOrder = {
  store: { name: "متجر الياسمين" },
  customer: { name: "غنامة أحمد", language },
  order: {
    items: [
      { title: "قميص قطن", quantity: 2 },
      { title: "صباط رياضي", quantity: 1 },
    ],
    total: 6500,
    delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
  },
}

const testLine = await openTestLine()
const result = await testLine.call({ phone, line, order, voice })
console.log(
  `outcome: ${result.outcome ?? "none"} ${JSON.stringify(result.args)}`
)
if (result.change) {
  console.log(`change: ${JSON.stringify(result.change)}`)
}
console.log(
  `tokens: prompt ${result.usage.promptTokens}, response ${result.usage.responseTokens}`
)
testLine.close()
process.exit(0)
