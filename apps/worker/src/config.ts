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
  }
}
