import { sql } from "kysely"
import pg from "pg"
import { createDb, type Db, migrateToLatest } from "./client.js"

const SERVER =
  process.env.TEST_DATABASE_SERVER ?? "postgres://nexus:nexus@127.0.0.1:5434"
const NAME = "nexus_test"

/** A migrated test database, separate from the development one. */
export async function createTestDb(): Promise<Db> {
  const admin = new pg.Client({ connectionString: `${SERVER}/postgres` })
  await admin.connect()
  const { rowCount } = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [NAME]
  )
  if (!rowCount) {
    await admin.query(`CREATE DATABASE ${NAME}`)
  }
  await admin.end()

  const db = createDb(`${SERVER}/${NAME}`)
  await migrateToLatest(db)
  return db
}

export async function resetTestDb(db: Db): Promise<void> {
  await sql`TRUNCATE account, line_status CASCADE`.execute(db)
}
