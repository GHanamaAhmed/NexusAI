import { Kysely, PostgresDialect } from "kysely"
import { Migrator } from "kysely/migration"
import pg from "pg"
import { migrations } from "./migrations.js"
import type { Database } from "./schema.js"

export type Db = Kysely<Database>

export function createDb(connectionString: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 10 }),
    }),
  })
}

/** Applies every migration not yet applied; throws on the first failure. */
export async function migrateToLatest(db: Db): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  })
  const { error } = await migrator.migrateToLatest()
  if (error) {
    throw error
  }
}
