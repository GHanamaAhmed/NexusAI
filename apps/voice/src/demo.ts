import { modelSettings } from "@nexus/ai"
import type { ConfirmationOrder } from "@nexus/conversation"
import { callCost } from "./cost.js"
import { modelArgument, testSettings } from "./sessions.js"
import { checkTestNumber, openTestLine } from "./test-line.js"

/**
 * One spoken test call with a made-up order:
 *   tsx src/demo.ts +213XXXXXXXXX [line] [ar|fr] [voice] [--model <id>]
 * Prints the conversation, the outcome, and the tokens and cost used. It runs
 * next to the voice app (test-line.ts).
 */

const { model, rest } = modelArgument(process.argv.slice(2))
const [phone = "", line = "line01", language = "ar", voice] = rest
if (language !== "ar" && language !== "fr") {
  throw new Error(
    "Usage: demo.ts +213XXXXXXXXX [line] [ar|fr] [voice] [--model <id>]"
  )
}
checkTestNumber(phone)

const french = language === "fr"
const order: ConfirmationOrder = {
  store: { name: french ? "Boutique Yasmine" : "متجر الياسمين" },
  customer: { name: french ? "Ghanama Ahmed" : "غنامة أحمد", language },
  order: {
    items: [
      { title: french ? "Chemise en coton" : "قميص قطن", quantity: 2 },
      { title: french ? "Baskets" : "صباط رياضي", quantity: 1 },
    ],
    total: 6500,
    delivery: { type: "home", wilaya_code: 16, commune: "باب الزوار" },
  },
}

const testLine = await openTestLine()
const result = await testLine.call({ phone, line, order, model, voice })
console.log(
  `outcome: ${result.outcome ?? "none"} ${JSON.stringify(result.args)}`
)
if (result.change) {
  console.log(`change: ${JSON.stringify(result.change)}`)
}
console.log(
  `tokens: prompt ${result.usage.promptTokens}, response ${result.usage.responseTokens}`
)
const settings = testSettings(model)
const { prices } = modelSettings(settings, settings.active_model)
console.log(
  `cost of ${settings.active_model}: ${JSON.stringify(callCost(result.usage, prices))}`
)
testLine.close()
process.exit(0)
