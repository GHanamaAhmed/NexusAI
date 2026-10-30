import { createDb } from "@nexus/db"
import { loadConfig } from "./config.js"
import { createAccount, createApiKey } from "./keys.js"

/**
 * Accounts and keys, on the server:
 *   account:create --name <name>     prints the account id and webhook secret
 *   key:create --account <id>        prints a new key
 *   key:revoke --prefix <prefix>     revokes a key
 *   export --account <id>            prints a new key and the webhook secret
 *                                    as env lines, for piping to a client
 */
function option(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (!value) {
    throw new Error(`Missing --${name}`)
  }
  return value
}

const db = createDb(loadConfig().databaseUrl)
try {
  switch (process.argv[2]) {
    case "account:create": {
      const account = await createAccount(db, option("name"))
      console.log(`account ${account.id}`)
      console.log(`webhook secret ${account.webhook_secret}`)
      break
    }
    case "key:create":
      console.log(await createApiKey(db, option("account")))
      break
    case "key:revoke": {
      const { numUpdatedRows } = await db
        .updateTable("api_key")
        .set({ revoked_at: new Date() })
        .where("prefix", "=", option("prefix"))
        .where("revoked_at", "is", null)
        .executeTakeFirst()
      console.log(`revoked ${numUpdatedRows}`)
      break
    }
    case "export": {
      const accountId = option("account")
      const { webhook_secret } = await db
        .selectFrom("account")
        .select("webhook_secret")
        .where("id", "=", accountId)
        .executeTakeFirstOrThrow()
      console.log(`NEXUS_API_KEY=${await createApiKey(db, accountId)}`)
      console.log(`NEXUS_WEBHOOK_SECRET=${webhook_secret}`)
      break
    }
    default:
      throw new Error(
        "Commands: account:create, key:create, key:revoke, export"
      )
  }
} finally {
  await db.destroy()
}
