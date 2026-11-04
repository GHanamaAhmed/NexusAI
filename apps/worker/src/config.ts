function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Set ${name}`)
  }
  return value
}

export function loadConfig() {
  return {
    databaseUrl: required("DATABASE_URL"),
    callWindow: process.env.CALL_WINDOW ?? "09:00-20:00",
    healthcheckUrl: process.env.HEALTHCHECK_URL || null,
    /** Without it, generations aren't run (and the API doesn't take them). */
    metaApiKey: process.env.META_API_KEY || null,
    /** Meta's address, for a stand-in; the real one when unset. */
    metaApiUrl: process.env.META_API_URL || undefined,
  }
}
