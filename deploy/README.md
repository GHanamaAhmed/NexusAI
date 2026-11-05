# Releasing NexusAI

Every push to `main` is checked, built, signed and released to the server by `.github/workflows/deploy.yml`. The server itself is set up by the playbook in [`infra/ansible`](../infra/ansible/README.md).

## How a release works

1. **CI** (`ci.yml`): type check, tests, formatting, shellcheck, actionlint, the playbook's syntax and the Compose file.
2. **Build** (`build.yml`): builds the images, pushes them to `ghcr.io/ghanamaahmed/nexus-*:<commit sha>`, fails on a fixable critical vulnerability, and signs each image without a key. The signature names this repository's `build.yml` on `main`.
3. **Release** (the `production` environment):
   - Connects as `deploy`, whose key can only run `/srv/nexus/bin/deploy-gate`.
   - Sends on stdin a registry token for this run, then the environment's settings and secrets.
   - Runs `deploy <sha>`.
4. **On the server,** `deploy`:
   1. Hands the settings and secrets to `apply-secrets` (the only thing `deploy` may run as root). It writes `/srv/nexus/.env` and `secrets/lines.txt`, and Asterisk's line files when they changed.
   2. Checks each image's signature with `cosign` (Asterisk, the API, the worker and the voice app), then pulls it by digest.
   3. Fetches `deploy/compose.yml` at that commit, starts Postgres and applies the database migrations, then starts the rest.
   4. Waits until every phone line is registered and the API answers its health check.
   5. Goes back to the previous release if any step fails. It keeps the last five.
   6. Reports whether `https://<PUBLIC_HOST>/health` answers. A DNS record or certificate still on its way doesn't fail the release.

## Settings and secrets

They live in GitHub, under Settings, Environments, `production`. Change one there, then re-run the Deploy workflow. Nothing secret is in this repository.

| Name                                                           | Kind     | What it is                                                                                                              |
| -------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`                                               | secret   | The Gemini API key (paid tier)                                                                                          |
| `OPENAI_API_KEY`                                               | secret   | Optional. OpenAI's API key; without it, OpenAI's voice models can't be chosen                                           |
| `META_API_KEY`                                                 | secret   | Optional. Meta's Model API key; without it, designs can't be made                                                       |
| `VOIP_LINES`                                                   | secret   | One phone line per row: `<number> <password>`, the number as the provider spells the account                            |
| `HEALTHCHECK_URL`                                              | secret   | The health check's ping address (optional)                                                                              |
| `ALLOWED_NUMBERS`                                              | secret   | The only numbers called, separated by commas (`0XXXXXXXXX`), or `any`; unset calls none                                 |
| `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`          | secret   | CI's key, the server's pinned host key, its address                                                                     |
| `PROVIDER_HOST`                                                | variable | The provider's SIP address, `<ip>:<port>`                                                                               |
| `PROVIDER_ROUTE_NAME`                                          | variable | The host name in the provider's routing headers, pinned to `PROVIDER_HOST`'s address                                    |
| `DIAL_FORMAT`                                                  | variable | `national` (`0XXXXXXXXX`) or `international` (`213XXXXXXXXX`)                                                           |
| `PUBLIC_HOST`                                                  | variable | The API's public host name; Caddy gets its certificate for it                                                           |
| `CALLS_ENABLED`                                                | variable | `true` lets the voice app dial; anything else, or unset, dials nothing                                                  |
| `CALL_WINDOW`                                                  | variable | The platform's call hours in Algiers time, `08:00-22:00` when unset; an account's own hours (voice settings) come first |
| `MAX_CALLS_PER_LINE`, `MAX_CALLS_TOTAL`, `MAX_CALLS_PER_STORE` | variable | Calls at once: per line (1), in all (10), per store (3) when unset                                                      |

The server makes its own internal passwords (`/srv/nexus/internal.env`: ARI's and the database's) once and never replaces them.

### Turning calls on or off

Set `CALLS_ENABLED` to `true` (or `false`) in the `production` environment, then re-run the Deploy workflow. With calls off, the voice app still runs and reports the lines, but takes nothing from the queue: tasks wait in it, and the worker keeps asking the platforms about them.

With calls on, the voice app dials only the numbers in `ALLOWED_NUMBERS`. Any other task ends without a call and without a result, as if the platform no longer wanted it, and the voice log says "not dialed: its number isn't allowed". `any` lifts the limit; unset, it calls nobody. `demo.ts` keeps to the same list.

## On the server

| Path                      | What it holds                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `/srv/nexus/bin/`         | `deploy`, `deploy-gate`, `apply-secrets`, `make-lines`, `backup` (from the playbook) |
| `/srv/nexus/.env`         | Settings and keys from the latest release (root and `deploy` only)                   |
| `/srv/nexus/internal.env` | Passwords the server made for itself                                                 |
| `/srv/nexus/secrets/`     | The lines file (root only)                                                           |
| `/srv/nexus/asterisk/`    | Asterisk's line, password and TLS files                                              |
| `/srv/nexus/releases/`    | Each release's image digests and Compose file, `current` and `releases.log`          |
| `/srv/nexus/postgres/`    | The database                                                                         |
| `/srv/nexus/caddy/`       | Caddy's certificates                                                                 |
| `/srv/nexus/backups/`     | The nightly database dumps, the last seven                                           |
| `/srv/nexus/sounds/`      | Voice samples from the first line check                                              |

To see what's running, sign in as `ops` and run `sudo -u deploy /srv/nexus/bin/deploy status`. To go back to the previous release, run `sudo -u deploy /srv/nexus/bin/deploy rollback`.

## Client accounts

On the server as `ops`. `account:create` prints the account's id and its webhook secret; `export` prints a new key and the secret as `NEXUS_API_KEY=` and `NEXUS_WEBHOOK_SECRET=` lines, meant to be piped straight into the platform's settings file, never shown:

```sh
sudo docker exec nexus-api-1 node --import tsx src/cli.ts account:create --name "Platform production" | grep '^account '
sudo docker exec nexus-api-1 node --import tsx src/cli.ts export --account <id> | ssh <platform server> 'cat > <settings file>'
sudo docker exec nexus-api-1 node --import tsx src/cli.ts key:revoke --prefix <prefix>
```

## Backups and restoring

Root's cron runs `/srv/nexus/bin/backup` at 03:30 UTC: a gzip'd `pg_dump` in `/srv/nexus/backups/nexus-<date>.sql.gz`, the last seven kept. There's no copy off the server: tasks live 30 days and the orders stay in the platforms' systems. To restore one, as `ops`:

```sh
sudo docker compose -p nexus stop api worker voice
sudo docker exec nexus-postgres-1 psql -U nexus -d postgres -c "DROP DATABASE nexus" -c "CREATE DATABASE nexus OWNER nexus"
gunzip -c /srv/nexus/backups/nexus-<date>.sql.gz | sudo docker exec -i nexus-postgres-1 psql -U nexus -d nexus
sudo docker compose -p nexus start api worker voice
```

A new setting needs one step before its release. `apply-secrets` refuses any setting it doesn't know, and the server runs its own installed copy, which only the playbook updates (`infra/ansible`, `--tags nexus`). So run the playbook first, then push; a release that fails this way has changed nothing, and its failed job can be re-run after the playbook. The same goes for any other change to `deploy/bin/deploy`, `deploy/bin/apply-secrets` or `deploy/bin/backup`.

`LIVE_MODEL`, `VOICE_AR` and `VOICE_FR` are gone: the model and voices are in each account's voice settings (`docs/api.md`, Voice settings), and their defaults are the values these held. Once a release that reads the defaults is live, `VOICE_AR` and `VOICE_FR` can be deleted from the environment's variables.

## Test call

`apps/voice/src/demo.ts` calls one phone through one line with a made-up order and prints the conversation, the outcome, the tokens and the cost. It refuses a number that isn't in `ALLOWED_NUMBERS` (read from `/srv/nexus/.env`). Test calls run next to the voice app, with their own Asterisk app (`nexus-test`) and audio port (8788, `nexus_media_test` in `websocket_client.conf`), so nothing is stopped and the health check stays green. Use a line the voice app isn't calling on. Run it only with the owner's agreement, from a copy of the repository on the server:

```sh
sudo docker run --rm --network host --env-file /srv/nexus/.env --env-file /srv/nexus/internal.env \
  -v <copy>:/work -w /work/apps/voice node:24-slim ./node_modules/.bin/tsx src/demo.ts +213XXXXXXXXX line01 ar --model gpt-realtime-2.1
```

`--model` tries another voice model: `gemini-3.8-live`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` or `gpt-live-1`, with each model's default voices and settings. OpenAI's need `OPENAI_API_KEY` in `/srv/nexus/.env`. It also prints what the call cost at that model's default prices. `dialogue-test.ts` and `voice-test.ts` take `--model` too, except for GPT-Live, which takes no typed customer. On `volunteer-calls.ts`, `--model` keeps each model's results in their own file, `<label>.<model>.results.json`, so their scores can be compared.

## Test design

`apps/worker/src/generation-test.ts` runs one design with the real keys, outside the queue, and prints how long it took, what it cost, the problems and the shape of the design. Its input is what a client sends to `POST /v1/generations` (`docs/api.md`, Designs), as a JSON file. Run it in the worker's container, with the input on stdin, so no file has to be copied onto the server:

```sh
ssh -o IdentitiesOnly=yes -i ~/.ssh/nexus_ops ops@<server> \
  'sudo docker exec -i nexus-worker-1 node --import tsx src/generation-test.ts /dev/stdin /tmp/design-test' < input.json
```

A third argument sets the reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh` or `max`; `low` by default, and higher was no better in tests). The design and its images are written to the folder given, inside the container: read them with `sudo docker exec nexus-worker-1 cat /tmp/design-test/design.json`, then delete the folder. Each run is billed by Meta, at the prices in `packages/ai/src/generation-catalog.ts`.

## Volunteer calls

The volunteer test measures how well the calls understand people answering in their own words. Each volunteer gets a card of scenarios, and `apps/voice/src/volunteer-calls.ts` calls them once per scenario, in the card's order, with a made-up order each time. A call is right when its outcome is one the scenario expects.

1. Copy `apps/voice/volunteer-card.example.json` to `/srv/nexus/volunteers/<label>.json` (root only) and fill in the volunteer's number, the name the call greets and the language. The hints in `say` are for the volunteer, who reads the card before the calls; the call never sees them.
2. The volunteer's number must be in `ALLOWED_NUMBERS`, and only the owner adds it.
3. Call them. A call comes about a minute after the last one ends (`PAUSE_SECONDS`). What was said stays off the screen unless `SHOW_WORDS=1`:

   ```sh
   sudo docker run --rm --network host --env-file /srv/nexus/.env --env-file /srv/nexus/internal.env \
     -v <copy>:/work -v /srv/nexus/volunteers:/volunteers -w /work/apps/voice node:24-slim \
     ./node_modules/.bin/tsx src/volunteer-calls.ts /volunteers/V1.json line09
   ```

4. Each result goes into `/srv/nexus/volunteers/<label>.results.json` as soon as the call ends. A scenario nobody answered is called again by number (`... V1.json line09 3,7`); only the first answered call of each scenario counts, so a second try never hides a wrong answer.
5. Score everyone together against the pass mark (at least 90% right, and a yes taken for a no, or the reverse, in at most 1% of calls):

   ```sh
   sudo docker run --rm -v <copy>:/work -v /srv/nexus/volunteers:/volunteers -w /work/apps/voice node:24-slim \
     sh -c './node_modules/.bin/tsx src/volunteer-score.ts /volunteers/*.results.json'
   ```

   It prints a table of numbers only, with no names or phone numbers, ready to keep with the test's notes. Delete the cards and results 30 days after scoring, or sooner if a volunteer asks.
