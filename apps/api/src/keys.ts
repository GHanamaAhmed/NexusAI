import { createHash, randomBytes } from "node:crypto"
import type { Db } from "@nexus/db"

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/** Makes a key for an account. The key itself is stored only as a hash. */
export async function createApiKey(db: Db, accountId: string): Promise<string> {
  const prefix = randomBytes(4).toString("hex")
  const key = `nx_${prefix}_${randomBytes(24).toString("base64url")}`
  await db
    .insertInto("api_key")
    .values({ account_id: accountId, prefix, key_hash: hashKey(key) })
    .execute()
  return key
}

export async function createAccount(db: Db, name: string) {
  return db
    .insertInto("account")
    .values({ name, webhook_secret: randomBytes(32).toString("hex") })
    .returning(["id", "webhook_secret"])
    .executeTakeFirstOrThrow()
}

/** The account a key belongs to, unless the key is unknown or revoked. */
export async function accountForKey(db: Db, key: string) {
  const row = await db
    .selectFrom("api_key")
    .select("account_id")
    .where("key_hash", "=", hashKey(key))
    .where("revoked_at", "is", null)
    .executeTakeFirst()
  return row?.account_id ?? null
}
