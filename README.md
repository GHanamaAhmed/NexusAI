<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="NexusAI" width="360">
  </picture>
</p>

<p align="center">
  <strong>AI services for platforms: phone agents that confirm orders, and builders that design stores.</strong>
</p>

<p align="center">
  <a href="https://github.com/GHanamaAhmed/NexusAI/actions/workflows/deploy.yml"><img src="https://github.com/GHanamaAhmed/NexusAI/actions/workflows/deploy.yml/badge.svg?branch=main" alt="Deploy"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-006233" alt="Node.js 22 or later">
</p>

<p align="center">
  <a href="docs/api.md">API</a> &middot;
  <a href="docs/architecture.md">Architecture</a> &middot;
  <a href="docs/telephony.md">Telephony</a> &middot;
  <a href="deploy/README.md">Releases</a>
</p>

---

NexusAI is a service that platforms call over HTTPS to hand work to AI. Each platform has its own account, keys and webhook secret, and its own settings for how calls sound. NexusAI keeps only what the work needs, for as long as it needs it.

## Features

- **Order confirmation calls.** An AI agent phones the customer, talks through their order, and sends the platform what they decided: confirmed, cancelled, a new delivery place, call me later, and more.
- **Checks the code enforces.** A confirmation or a change of place needs the customer's own yes, and a new place must be one the agent looked up and said back.
- **Four voice models behind one interface,** chosen per account: Gemini 3.8 Live, GPT Realtime 2.1 and its mini, and GPT-Live. Each call records its model, its answered seconds and its cost.
- **Store designs.** A platform sends the parts a page may use as a JSON Schema, with a brief and photos, and gets back a design that matches it, with generated banners. In tests a design took 25 to 60 seconds and cost under 11 US cents.
- **Built to be trusted with calls.** Nothing is dialed unless calls are switched on, and only numbers on an allow list; every result is signed; tasks are deleted after 30 days and no audio is kept.
- **Released safely.** Every push is tested, scanned, signed and released with health checks and an automatic rollback.

## Built with

| Layer         | Technology                                                                           |
| ------------- | ------------------------------------------------------------------------------------ |
| Language      | TypeScript on Node.js 24, in a pnpm workspace                                        |
| API           | Fastify 5, with Zod for validation                                                   |
| Data          | PostgreSQL 17, through Kysely                                                        |
| Telephony     | Asterisk 22 on SIP lines over TLS, audio to the voice app over WebSocket             |
| Voice models  | Google Gemini Live and OpenAI Realtime and GPT-Live                                  |
| Design models | Meta's Muse Wonder (text) and Muse Image (images)                                    |
| Delivery      | Docker Compose behind Caddy; images signed with Sigstore cosign and scanned by Trivy |
| Server and CI | Ansible for the server, GitHub Actions for checks, builds and releases               |

## Contents

- [How it works](#how-it-works)
- [Current coverage](#current-coverage)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [API at a glance](#api-at-a-glance)
- [Security and privacy](#security-and-privacy)
- [Operations](#operations)
- [Documentation](#documentation)
- [Contributing](#contributing)

## How it works

```mermaid
flowchart TB
  platform[Commerce platform]
  voiceModels[Voice models]

  subgraph nexus [NexusAI]
    voice[Voice app]
    api[API]
    worker[Worker]
    asterisk[Asterisk]
    db[(Postgres)]
  end

  designModels[Design models]
  phone[Customer's phone]

  platform ~~~ worker
  platform -- tasks and designs --> api
  worker -- checks and signed results --> platform
  voice -- live audio --> voiceModels
  voice -- dials --> asterisk
  voice --> db
  api --> db
  worker --> db
  worker -- brief and photos --> designModels
  asterisk -- SIP lines --> phone

  classDef part fill:#FFFFFF,stroke:#006233,color:#0E1A14
  classDef outside fill:#006233,stroke:#006233,color:#FFFFFF
  class api,worker,voice,db,asterisk part
  class platform,phone,voiceModels,designModels outside
  style nexus fill:transparent,stroke:#1B8A57,stroke-width:2px,color:#1B8A57
```

### A confirmation call

1. The platform sends a task (`POST /v1/tasks`). It is due two minutes later, inside call hours.
2. Before each call, the worker asks the platform whether the call is still wanted, so a call never follows a confirmation made meanwhile.
3. The voice app dials through Asterisk on the least busy registered line. It dials nothing unless calls are switched on, and only numbers on an allow list.
4. The voice model holds the conversation. It reads the order, listens, looks up any delivery place it hears, and ends with one outcome. The code checks the agreement: a confirmation or a new place needs the customer's own yes.
5. The worker sends the result to the platform, signed, and schedules another try when nobody answered (three tries at most).

Four voice models are supported behind one interface, chosen per account: `gemini-3.8-live` (the default), `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` and `gpt-live-1`. Each attempt records its model, how long it was answered and what it cost.

### A store design

1. The platform sends the schema, its instructions, a brief, up to 8 photos and the language (`POST /v1/generations`).
2. The worker downloads the photos and asks the text model (`muse-wonder-1.0`) for JSON that matches the schema. The answer is checked against the schema and asked for once more if it doesn't match.
3. Images the design asks for are made by the image model (`muse-image-1.0`), wide or tall, up to the number the platform allowed.
4. The platform reads the result (`GET /v1/generations/:id`) and each image's bytes. A design typically takes 25 to 60 seconds and costs 7 to 11 US cents.

NexusAI knows nothing about a platform's page sections beyond the schema it receives, so any platform can use it.

## Current coverage

Phone calls currently run in Algeria: Algerian mobile numbers and phone lines, Darija and French, the country's wilayas and communes, totals in dinars, and call hours in Algiers time. Designs are written in Arabic or French. Accounts, keys, signed results, the task queue and the model catalogues aren't tied to a country; another country needs its own lines, number rules, places and languages.

## Repository layout

| Path                    | What it holds                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/api`              | The HTTP API (Fastify): tasks, voice settings, designs, accounts and keys (`src/cli.ts`)             |
| `apps/worker`           | Checks before calls, result delivery, design generation, clean-up and the health ping                |
| `apps/voice`            | Dials queued calls through Asterisk and runs the conversation; also the test scripts for real calls  |
| `packages/ai`           | Voice sessions per model, the model catalogues with prices, and the design clients for Meta's models |
| `packages/conversation` | The agent's instruction and its functions                                                            |
| `packages/core`         | Outcomes, call hours, retries and phone numbers                                                      |
| `packages/db`           | The database schema and migrations (Kysely)                                                          |
| `packages/places`       | The delivery places the agent can look up, with fuzzy matching                                       |
| `packages/webhooks`     | Signing and delivering results                                                                       |
| `deploy`                | The production Compose file, Asterisk's configuration and the release scripts                        |
| `infra/ansible`         | The playbook that prepares the server                                                                |
| `docs`                  | The API, the architecture and what the phone lines showed in tests                                   |

## Getting started

### Requirements

- Node.js 22 or later (the images run Node 24)
- pnpm 10 (`corepack enable`)
- Docker, for the local database

### Install and test

```sh
pnpm install
pnpm db:up          # Postgres on 127.0.0.1:5434, for development and tests
pnpm typecheck
pnpm test           # each package's tests, against a separate test database
pnpm format:check
```

Tests create and migrate their own database (`nexus_test`) on the local server. Set `TEST_DATABASE_SERVER` to use another one.

### Run the API and the worker locally

```sh
export DATABASE_URL=postgres://nexus:nexus@127.0.0.1:5434/nexus
(cd apps/api && node --import tsx src/migrate.ts)
pnpm --filter @nexus/api dev
pnpm --filter @nexus/worker dev
```

Create an account and a key for a local client:

```sh
cd apps/api
node --import tsx src/cli.ts account:create --name "Local platform"
node --import tsx src/cli.ts export --account <id>
```

Outside production, the API accepts plain `http` callback addresses so a client on the same machine can receive results. Real calls need the phone lines and Asterisk, so they run only on the server (see [Operations](#operations)).

## Configuration

Each app reads its settings from the environment. The essentials:

| Setting                                                        | Used by     | What it does                                                             |
| -------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                                                 | all         | The Postgres connection (required)                                       |
| `GEMINI_API_KEY`                                               | voice       | Google's key for the default voice model                                 |
| `OPENAI_API_KEY`                                               | voice       | Optional; enables OpenAI's voice models                                  |
| `META_API_KEY`                                                 | worker      | Optional; enables store designs                                          |
| `VOICE_PROVIDERS`, `TEXT_PROVIDERS`                            | API         | Which optional providers are set up, so the API holds none of their keys |
| `CALLS_ENABLED`                                                | voice       | `true` lets the voice app dial; anything else dials nothing              |
| `ALLOWED_NUMBERS`                                              | voice       | The only numbers it calls, or `any`; unset calls none                    |
| `CALL_WINDOW`                                                  | API, worker | Call hours in Algiers time, `09:00-20:00` by default                     |
| `MAX_CALLS_PER_LINE`, `MAX_CALLS_TOTAL`, `MAX_CALLS_PER_STORE` | voice       | How many calls run at once                                               |
| `HEALTHCHECK_URL`                                              | worker      | Optional health-check ping                                               |

The full list, with the phone line and provider settings, is in [`deploy/README.md`](deploy/README.md#settings-and-secrets). In production every setting and secret lives in the GitHub environment `production`; none is in this repository.

## API at a glance

Every request carries `Authorization: Bearer nx_<prefix>_<secret>`. Each key may make 120 requests a minute.

| Request                                     | Purpose                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| `POST /v1/tasks`                            | Ask for an order to be confirmed by phone (idempotent)      |
| `GET /v1/tasks/:id`, `DELETE /v1/tasks/:id` | Read a task and its attempts, or cancel a waiting one       |
| `GET /v1/voice/models`                      | The voice models, their voices, settings and prices         |
| `GET /v1/voice/settings`, `PUT ...`         | The account's voice model, voices, wording and longest call |
| `POST /v1/voice/preview`                    | What the agent would be told for a sample order             |
| `POST /v1/generations`                      | Ask for a store design (idempotent)                         |
| `GET /v1/generations/:id`                   | Its state, the design, and what it cost                     |
| `GET /v1/generations/:id/images/:slot`      | An image the design asked for                               |
| `GET /health`                               | Whether the API and its database answer                     |

NexusAI calls the platform back twice per call: a check before dialing (`check_url`) and the result afterwards (`outcome_url`). Both are signed with HMAC-SHA256 over the raw body and a timestamp, and results are retried for up to a day. The request and answer shapes, outcomes and signature check are in [`docs/api.md`](docs/api.md).

## Security and privacy

- **Keys:** stored hashed, per account, and revocable from the CLI. Webhook payloads are signed with each account's own secret.
- **Calls:** off unless `CALLS_ENABLED` is `true`, and limited to `ALLOWED_NUMBERS`.
- **Data kept:** a task holds the store's name, the customer's name, phone and language, the items, the total and the delivery place. Tasks are deleted after 30 days, designs and their images after 7. No call audio is stored, and logs hold no phone numbers or conversation.
- **Providers:** during a call the customer's voice goes to the active model's provider (Google or OpenAI). Design briefs and photos go to Meta.
- **Releases:** images are scanned, signed in CI without a key and verified on the server before they run. The server accepts SSH keys only, behind a firewall and fail2ban.

## Operations

- **Releases:** every push to `main` is checked, built, signed and released by `.github/workflows/deploy.yml`, with an automatic return to the previous release if a step fails. See [`deploy/README.md`](deploy/README.md).
- **The server:** prepared and kept up to date by the playbook in [`infra/ansible`](infra/ansible/README.md). A new setting needs the playbook run before the release that uses it.
- **Backups:** a nightly database dump at 03:30 UTC, the last seven kept on the server.
- **Test tools:** scripts in `apps/voice/src` place real test calls, and `apps/worker/src/generation-test.ts` runs a real design, both on the server (see [`deploy/README.md`](deploy/README.md)).

## Documentation

| Document                                             | Read it for                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| [`docs/api.md`](docs/api.md)                         | Integrating a platform: every request, answer, outcome and signature  |
| [`docs/architecture.md`](docs/architecture.md)       | How the parts fit together, the voice models, designs, data and costs |
| [`docs/telephony.md`](docs/telephony.md)             | What tests on the phone lines and with each voice model showed        |
| [`deploy/README.md`](deploy/README.md)               | Releases, settings and secrets, accounts, backups and test calls      |
| [`infra/ansible/README.md`](infra/ansible/README.md) | Preparing the server                                                  |

## Contributing

- Run `pnpm typecheck`, `pnpm test` and `pnpm format:check` before pushing; CI runs the same checks, plus shellcheck, actionlint and the playbook's syntax.
- A pushed commit on `main` is released to production, so keep `main` releasable.
- Database changes go in `packages/db/src/migrations.ts` and must work with the release before them, since a rollback changes the images and never the database.
- Never commit a key, password or phone number. Test calls only go to numbers on the allow list.
