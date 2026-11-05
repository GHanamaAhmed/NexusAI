import type { Db } from "./client.js"

/**
 * The call hours each account saved in its voice settings, as stored: the
 * caller reads them with `callWindowFromHours`, which falls back to the
 * platform's hours for an account that saved none.
 */
export async function callHoursByAccount(
  db: Db,
  accountIds: readonly string[]
): Promise<Map<string, unknown>> {
  const ids = [...new Set(accountIds)]
  if (ids.length === 0) {
    return new Map()
  }
  const rows = await db
    .selectFrom("voice_settings")
    .select(["account_id", "settings"])
    .where("account_id", "in", ids)
    .execute()
  return new Map(
    rows.map((row) => [row.account_id, row.settings?.call_hours ?? null])
  )
}
