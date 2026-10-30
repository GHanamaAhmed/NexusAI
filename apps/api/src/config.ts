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
    port: Number(process.env.PORT ?? 3000),
    callWindow: process.env.CALL_WINDOW ?? "09:00-20:00",
    // Local development only: a client on this machine has no HTTPS.
    allowHttpCallbacks: process.env.NODE_ENV !== "production",
  }
}
