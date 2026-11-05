# Architecture

NexusAI calls customers about their cash-on-delivery orders and tells the platform what they said, and designs store pages from a platform's own parts. Everything runs on one server, in containers started by `deploy/compose.yml`.

## The parts

| Part     | What it does                                                                                                                                                             | Code                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Caddy    | HTTPS for the API, with certificates from Let's Encrypt; the only way in from the internet                                                                               | `deploy/compose.yml` |
| API      | Takes tasks and design requests from platforms, answers questions about them, cancels tasks, keeps each account's voice settings                                         | `apps/api`           |
| Worker   | Asks the platform before each call, queues it, turns finished calls into signed results, retries their delivery, makes designs, deletes old data, pings the health check | `apps/worker`        |
| Voice    | Takes queued calls, dials them through Asterisk, holds the conversation with the active voice model, writes the result                                                   | `apps/voice`         |
| Asterisk | Signs in the ten phone lines and carries the calls                                                                                                                       | `deploy/asterisk`    |
| Postgres | Tasks, attempts, results waiting to be delivered, the lines' state, each account's voice settings, designs and their images                                              | `packages/db`        |

The shared code is in `packages`: `core` (outcomes, call hours, retries, phone numbers), `conversation` (the agent's instruction and functions), `places` (the 69 wilayas and 1,541 communes), `ai` (the voice sessions, the catalogues of voice and design models with their settings and prices, and the clients for Meta's design models) and `webhooks` (signing and delivery).

## A call, from order to result

1. **The platform sends a task** (`POST /v1/tasks`). The API saves it, due 2 minutes later inside call hours.
2. **The worker asks the platform** whether the call is still wanted. If so, it queues an attempt.
3. **The voice app dials** within its limits per line, in total and per store, on the registered line with the fewest calls. It dials nothing unless `CALLS_ENABLED` is `true`, and only the numbers in `ALLOWED_NUMBERS` (none when unset, every one with `any`).
4. **The model connects while the phone rings,** except GPT-Live, which bills from the moment it connects and so connects at the answer. When the customer answers, Asterisk sends the call's audio to the voice app over a WebSocket, matched to its call by the channel's id. The voice app waits for the customer's "allo", then the agent greets them.
5. **The agent confirms the order.** It reads it, listens, looks up a wilaya and commune it hears, and ends with one function: confirm, cancel, call later, change, wrong number, talk to the store, or voicemail. The code checks the agreement: a confirmation and a new place need the customer's yes.
6. **The voice app writes the result**: the outcome, the customer's words, a confirmed new place, when to call back, what the agent said, and the call's cost. An unanswered call gets its outcome from the network's hang-up cause.
7. **The worker sends the result** to the platform, signed, and schedules the next call when the customer wasn't reached.

## Voice models

Every call goes through `VoiceSession` (`packages/ai/src/index.ts`), so the call doesn't know which model it talks to:

| Model                   | Session                  | Billed by                                   |
| ----------------------- | ------------------------ | ------------------------------------------- |
| `gemini-3.8-live`       | `packages/ai/src/gemini` | Tokens                                      |
| `gpt-realtime-2.1`      | `packages/ai/src/openai` | Tokens, cached ones at a lower price        |
| `gpt-realtime-2.1-mini` | `packages/ai/src/openai` | Tokens, cached ones at a lower price        |
| `gpt-live-1`            | `packages/ai/src/openai` | The minute, plus its backend model's tokens |

- **Settings are per account** (`docs/api.md`, Voice settings), read for each call, so a save applies to the next one. The API knows which models can be chosen from `VOICE_PROVIDERS`, which Compose sets from whether `OPENAI_API_KEY` is set, so the API holds no OpenAI key. A row that can't be read gives the defaults, and a model whose key has gone gives way to Gemini, so calls don't stop over either. The attempt records the model that really ran.
- **GPT-Live's functions run through a backend model** (Responses delegation), since its client delegation declares none. Its voice is told to ask for a function with `<|SpawnThinking|>` and to say nothing is settled until the result comes, and the backend is told it acts and doesn't speak (`packages/ai/src/openai/live.ts`). The voice model passes the conversation along and the backend decides which function to call. GPT-Live also reports no end of a turn and no interruption, so the call's own timers end the goodbye, and audio already sent keeps playing when the customer speaks over it.
- **The instruction's protocol stays in code.** Only the greeting, the way of speaking and extra rules can change, so an edit can't break the functions the code relies on.

## Designs

A client sends the parts a design may use, as a JSON Schema, with its instructions, a brief and some photos (`docs/api.md`, Designs). The worker runs at most two at once:

1. **The photos are downloaded first** (`packages/ai/src/photos.ts`) and sent to the model inline, since Meta refuses to fetch a photo by its address. Each must be a JPEG, PNG, GIF or WebP of at most 4 MB, 16 MB together; one that can't be downloaded fails the generation.
2. **The text model** (`muse-wonder-1.0`, `packages/ai/src/meta/text.ts`) answers in JSON that matches the schema, from NexusAI's own rules, the client's instructions, the brief and the photos, at low reasoning effort. The answer is streamed, so a long one doesn't time out.
3. **The answer is checked** against the schema (`packages/ai/src/generation-schema.ts`), since the provider doesn't say which keywords it enforces, and asked for once more with its problems.
4. **The images it asked for** are made by `muse-image-1.0`, wide or tall, at most as many as the client allowed, and kept in `generation_image` until the generation is purged. An image that can't be made becomes `null` and is named in the result's problems.
5. **The cost** adds up every request at the catalogue's prices (`packages/ai/src/generation-catalog.ts`), so more models can be added as data.

A generation that fails is marked failed and not tried again; the client starts another. One still running after 15 minutes is counted as failed, unless this worker is the one running it.

NexusAI knows nothing of the client's parts beyond the schema it sends.

## Data

- **What a task holds:** the store's name, the customer's name, phone and language, the items, the total and the delivery place. Nothing else about the customer.
- **How long:** 30 days, then the task and its attempts and results are deleted. A design, with its brief, photo addresses and images, is deleted after 7 days.
- **Calls:** no audio is stored. The attempt keeps what the agent said, not the customer's side, whose transcription comes out in other languages.
- **The customer's voice goes to the active model's provider** during the call: Google for Gemini, OpenAI for the others. A design's brief and photos go to Meta.
- **Logs** hold no phone numbers and no conversation.
- **Backups:** a dump every night at 03:30 UTC, the last seven kept on the server, none elsewhere.

## Limits and costs

- Calls: inside the account's call hours (08:00 to 22:00 Algiers time unless it saved its own), the first one 2 minutes after the task unless the client asks for a longer wait, three tries per task, at most 150 seconds each from the answer unless the account's settings say otherwise (60 to 600).
- With Gemini, a call costs about 1.5 US cents for a plain yes and 3 to 5 cents with a change of place, plus the phone line's minutes. Each attempt records its own cost (`docs/telephony.md`, Usage).
- With GPT-Live, calls of 32 to 54 seconds cost 3 to 5 US cents at $0.05 a minute, its backend's tokens included, plus the phone line's minutes.
- Designs: at most two at once on the worker and three waiting or running per account. In tests with schemas of 10 to 20 KB and four images, one took 24 to 57 seconds and cost 7 to 11 US cents.
