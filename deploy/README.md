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
   2. Checks each image's signature with `cosign`, then pulls it by digest.
   3. Fetches `deploy/compose.yml` at that commit and starts the release.
   4. Waits until every phone line is registered.
   5. Goes back to the previous release if any step fails. It keeps the last five.

## Settings and secrets

They live in GitHub, under Settings, Environments, `production`. Change one there, then re-run the Deploy workflow. Nothing secret is in this repository.

| Name                                                  | Kind     | What it is                                                                                   |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`                                      | secret   | The Gemini API key (paid tier)                                                               |
| `VOIP_LINES`                                          | secret   | One phone line per row: `<number> <password>`, the number as the provider spells the account |
| `HEALTHCHECK_URL`                                     | secret   | The health check's ping address (optional)                                                   |
| `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST` | secret   | CI's key, the server's pinned host key, its address                                          |
| `PROVIDER_HOST`                                       | variable | The provider's SIP address, `<ip>:<port>`                                                    |
| `DIAL_FORMAT`                                         | variable | `national` (`0XXXXXXXXX`) or `international` (`213XXXXXXXXX`)                                |
| `VOICE_AR`, `VOICE_FR`                                | variable | The Gemini voices for Darija and French                                                      |

The server makes its own internal passwords (`/srv/nexus/internal.env`) once and never replaces them.

## On the server

| Path                      | What it holds                                                               |
| ------------------------- | --------------------------------------------------------------------------- |
| `/srv/nexus/bin/`         | `deploy`, `deploy-gate`, `apply-secrets`, `make-lines` (from the playbook)  |
| `/srv/nexus/.env`         | Settings and keys from the latest release (root and `deploy` only)          |
| `/srv/nexus/internal.env` | Passwords the server made for itself                                        |
| `/srv/nexus/secrets/`     | The lines file (root only)                                                  |
| `/srv/nexus/asterisk/`    | Asterisk's line, password and TLS files                                     |
| `/srv/nexus/releases/`    | Each release's image digests and Compose file, `current` and `releases.log` |
| `/srv/nexus/sounds/`      | Prompts and read-outs in 8 kHz A-law                                        |

To see what's running, sign in as `ops` and run `sudo -u deploy /srv/nexus/bin/deploy status`. To go back to the previous release, run `sudo -u deploy /srv/nexus/bin/deploy rollback`.

## Line check (test call)

`benchmark/render-samples.ts` writes voice samples into `/srv/nexus/sounds/samples`. Then call a phone through one line:

```sh
docker exec nexus-asterisk-1 asterisk -rx "channel originate PJSIP/<phone number>@line01 extension s@test-call"
```

The call plays each sample and asks for a key after it. The key pressed after each sample shows in the Asterisk log as `TEST sample N key K`.
