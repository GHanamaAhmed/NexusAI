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

| Name                                                           | Kind     | What it is                                                                                   |
| -------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`                                               | secret   | The Gemini API key (paid tier)                                                               |
| `VOIP_LINES`                                                   | secret   | One phone line per row: `<number> <password>`, the number as the provider spells the account |
| `HEALTHCHECK_URL`                                              | secret   | The health check's ping address (optional)                                                   |
| `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`          | secret   | CI's key, the server's pinned host key, its address                                          |
| `PROVIDER_HOST`                                                | variable | The provider's SIP address, `<ip>:<port>`                                                    |
| `PROVIDER_ROUTE_NAME`                                          | variable | The host name in the provider's routing headers, pinned to `PROVIDER_HOST`'s address         |
| `DIAL_FORMAT`                                                  | variable | `national` (`0XXXXXXXXX`) or `international` (`213XXXXXXXXX`)                                |
| `VOICE_AR`, `VOICE_FR`                                         | variable | The Gemini voices for Darija and French                                                      |
| `PUBLIC_HOST`                                                  | variable | The API's public host name; Caddy gets its certificate for it                                |
| `CALLS_ENABLED`                                                | variable | `true` lets the voice app dial; anything else, or unset, dials nothing                       |
| `CALL_WINDOW`                                                  | variable | Call hours in Algiers time, `09:00-20:00` when unset                                         |
| `MAX_CALLS_PER_LINE`, `MAX_CALLS_TOTAL`, `MAX_CALLS_PER_STORE` | variable | Calls at once: per line (1), in all (10), per store (3) when unset                           |

The server makes its own internal passwords (`/srv/nexus/internal.env`: ARI's and the database's) once and never replaces them.

### Turning calls on or off

Set `CALLS_ENABLED` to `true` (or `false`) in the `production` environment, then re-run the Deploy workflow. With calls off, the voice app still runs and reports the lines, but takes nothing from the queue: tasks wait in it, and the worker keeps asking the platforms about them.

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

## Test call

`apps/voice/src/demo.ts` calls one phone through one line with a made-up order and prints the conversation, the outcome and the tokens. Run it only with the owner's agreement, from a copy of the repository on the server:

```sh
sudo docker run --rm --network host --env-file /srv/nexus/.env --env-file /srv/nexus/internal.env \
  -v <copy>:/work -w /work/apps/voice node:24-slim ./node_modules/.bin/tsx src/demo.ts +213XXXXXXXXX line01 ar
```
