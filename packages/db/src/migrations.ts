import { type Kysely, sql } from "kysely"
import type { Migration } from "kysely/migration"

async function initialUp(db: Kysely<unknown>) {
  await sql`
    CREATE TABLE account (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      webhook_secret text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE api_key (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES account ON DELETE CASCADE,
      prefix text NOT NULL,
      key_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );

    CREATE TABLE client_store (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES account ON DELETE CASCADE,
      external_id text NOT NULL,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, external_id)
    );

    CREATE TABLE task (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES account ON DELETE CASCADE,
      client_store_id uuid NOT NULL REFERENCES client_store ON DELETE CASCADE,
      type text NOT NULL CHECK (type IN ('order_confirmation')),
      external_id text NOT NULL,
      idempotency_key text NOT NULL,
      reference text,
      payload jsonb NOT NULL,
      language text NOT NULL CHECK (language IN ('ar', 'fr')),
      mode text NOT NULL CHECK (mode IN ('keypad', 'spoken')),
      outcome_url text NOT NULL,
      check_url text NOT NULL,
      status text NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'calling', 'done', 'cancelled')),
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL,
      outcome text,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      purge_after timestamptz NOT NULL,
      UNIQUE (account_id, idempotency_key)
    );
    CREATE INDEX task_due ON task (status, next_attempt_at);
    CREATE INDEX task_purge ON task (purge_after);

    CREATE TABLE attempt (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid NOT NULL REFERENCES task ON DELETE CASCADE,
      number integer NOT NULL,
      line text,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'dialing', 'answered', 'done')),
      queued_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      answered_at timestamptz,
      ended_at timestamptz,
      hangup_cause integer,
      amd_status text,
      digits text,
      outcome text,
      note text,
      transcript jsonb,
      cost jsonb,
      UNIQUE (task_id, number)
    );
    CREATE INDEX attempt_queue ON attempt (status, queued_at);

    CREATE TABLE webhook_delivery (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid NOT NULL REFERENCES task ON DELETE CASCADE,
      attempt_id uuid NOT NULL REFERENCES attempt ON DELETE CASCADE,
      event text NOT NULL CHECK (event IN ('task.attempted', 'task.completed')),
      body jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'failed')),
      tries integer NOT NULL DEFAULT 0,
      next_try_at timestamptz NOT NULL,
      last_error text,
      delivered_at timestamptz,
      UNIQUE (attempt_id)
    );
    CREATE INDEX webhook_delivery_due ON webhook_delivery (status, next_try_at);

    CREATE TABLE line_status (
      line text PRIMARY KEY,
      registered boolean NOT NULL,
      in_flight integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL
    );
  `.execute(db)
}

async function initialDown(db: Kysely<unknown>) {
  await sql`
    DROP TABLE line_status, webhook_delivery, attempt, task, client_store,
      api_key, account;
  `.execute(db)
}

export const migrations: Record<string, Migration> = {
  "0001_initial": { up: initialUp, down: initialDown },
}
