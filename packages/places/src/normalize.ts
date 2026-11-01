const ARABIC_FOLDS: Record<string, string> = {
  أ: "ا",
  إ: "ا",
  آ: "ا",
  ٱ: "ا",
  ؤ: "و",
  ئ: "ي",
  ى: "ي",
  ة: "ه",
  ڨ: "ق",
  گ: "ق",
  ڤ: "ف",
}
/** Words people (and the model) put before a name; already folded. */
const ARABIC_FILLERS = new Set(["ولايه", "بلديه", "دايره", "مدينه"])
const LATIN_FILLERS = new Set([
  "wilaya",
  "commune",
  "de",
  "d",
  "el",
  "al",
  "la",
  "le",
  "les",
])

export function hasArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text)
}

export function hasLatin(text: string): boolean {
  return /[A-Za-zÀ-ɏ]/.test(text)
}

/** A key for an Arabic place name as a voice model writes it: spelling and articles don't count. */
export function arabicKey(text: string): string {
  return text
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱؤئىةڨگڤ]/g, (letter) => ARABIC_FOLDS[letter] ?? letter)
    .replace(/ء/g, "")
    .split(/[^ء-ي]+/)
    .filter((word) => word && !ARABIC_FILLERS.has(word))
    .map((word) =>
      word.length > 3 && word.startsWith("ال") ? word.slice(2) : word
    )
    .join("")
}

/** A key without its vowels after the first letter: a name heard on the phone often gains or loses one. */
export function skeleton(key: string): string {
  return key.slice(0, 1) + key.slice(1).replace(/[اويهaeiou]/g, "")
}

/** The same for a name in Latin letters, as French spells Algerian names. */
export function latinKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word && !LATIN_FILLERS.has(word))
    .join("")
    .replace(/dj/g, "j")
    .replace(/ou/g, "u")
    .replace(/w/g, "u")
    .replace(/y/g, "i")
    .replace(/q/g, "k")
    .replace(/sh/g, "ch")
    .replace(/(.)\1+/g, "$1")
}
