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
