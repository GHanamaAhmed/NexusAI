const ALGERIAN_MOBILE = /^\+213[567]\d{8}$/

/** The only numbers NexusAI will ever dial. */
export function isAlgerianMobile(phone: string): boolean {
  return ALGERIAN_MOBILE.test(phone)
}

export type DialFormat = "national" | "international"

/** How the provider wants a +213 number spelled. */
export function toDialString(phone: string, format: DialFormat): string {
  if (!isAlgerianMobile(phone)) {
    throw new Error("Not an Algerian mobile number in +213 form")
  }
  const subscriber = phone.slice(4)
  return format === "national" ? `0${subscriber}` : `213${subscriber}`
}

/** The numbers calls may go to: any, or only these (+213 form). */
export type AllowedNumbers = "any" | ReadonlySet<string>

/**
 * Reads ALLOWED_NUMBERS: "any", or numbers separated by commas, each written
 * 0XXXXXXXXX or +213XXXXXXXXX. Unset or empty allows none, so a call only
 * reaches a number someone chose.
 */
export function parseAllowedNumbers(value: string | undefined): AllowedNumbers {
  const text = (value ?? "").trim()
  if (text === "any") {
    return "any"
  }
  const numbers = new Set<string>()
  for (const entry of text.split(",")) {
    const written = entry.replace(/[\s.-]/g, "")
    if (!written) {
      continue
    }
    const phone = written.startsWith("0")
      ? `+213${written.slice(1)}`
      : written.startsWith("213")
        ? `+${written}`
        : written
    if (!isAlgerianMobile(phone)) {
      throw new Error("ALLOWED_NUMBERS holds something that isn't a mobile")
    }
    numbers.add(phone)
  }
  return numbers
}

export function isAllowedNumber(
  phone: string,
  allowed: AllowedNumbers
): boolean {
  return allowed === "any" || allowed.has(phone)
}
