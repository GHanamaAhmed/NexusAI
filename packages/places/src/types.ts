/** A wilaya. `parent` is the former wilaya for those created in 2026 (59-69), else its own code. */
export type Wilaya = { code: number; parent: number; ar: string; fr: string }

export type Commune = { wilaya: number; ar: string; fr: string }
