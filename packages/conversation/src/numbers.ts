const UNITS = [
  "",
  "واحد",
  "زوج",
  "ثلاثة",
  "ربعة",
  "خمسة",
  "ستة",
  "سبعة",
  "ثمنية",
  "تسعة",
  "عشرة",
  "حداش",
  "طناش",
  "طلطاش",
  "ربعطاش",
  "خمسطاش",
  "سطاش",
  "سبعطاش",
  "ثمنطاش",
  "تسعطاش",
]
const TENS = [
  "",
  "",
  "عشرين",
  "ثلاثين",
  "ربعين",
  "خمسين",
  "ستين",
  "سبعين",
  "ثمانين",
  "تسعين",
]
const HUNDREDS = [
  "",
  "مية",
  "ميتين",
  "ثلاثمية",
  "ربعمية",
  "خمسمية",
  "ستمية",
  "سبعمية",
  "ثمنمية",
  "تسعمية",
]

/** 1 to 999 in Algerian Darija. */
function belowThousand(n: number): string {
  const parts: string[] = []
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  if (hundreds) {
    parts.push(HUNDREDS[hundreds]!)
  }
  if (rest >= 20) {
    const unit = rest % 10
    parts.push(
      unit ? `${UNITS[unit]} و${TENS[Math.floor(rest / 10)]}` : TENS[rest / 10]!
    )
  } else if (rest) {
    parts.push(UNITS[rest]!)
  }
  return parts.join(" و")
}

/** How a count of thousands is said: ألف, ألفين, ثلاثة آلاف, حداش ألف... */
function thousands(n: number): string {
  if (n === 1) {
    return "ألف"
  }
  if (n === 2) {
    return "ألفين"
  }
  if (n <= 10) {
    return `${UNITS[n]} آلاف`
  }
  return `${belowThousand(n)} ألف`
}

/** A whole number of dinars, said the way people in Algiers say it. */
export function darijaAmount(dinars: number): string {
  if (!Number.isInteger(dinars) || dinars < 0 || dinars >= 1_000_000) {
    throw new Error(`Can't say ${dinars} dinars`)
  }
  if (dinars === 0) {
    return "صفر دينار"
  }
  const parts: string[] = []
  const high = Math.floor(dinars / 1000)
  const low = dinars % 1000
  if (high) {
    parts.push(thousands(high))
  }
  if (low) {
    parts.push(belowThousand(low))
  }
  return `${parts.join(" و")} دينار`
}
