# Architecture

NexusAI calls customers about their cash-on-delivery orders and tells the platform what they said. Everything runs on one server, in containers started by `deploy/compose.yml`.

## The parts

| Part     | What it does                                                                                                                                               | Code                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Caddy    | HTTPS for the API, with certificates from Let's Encrypt; the only way in from the internet                                                                 | `deploy/compose.yml` |
| API      | Takes tasks from platforms, answers questions about them, cancels them                                                                                     | `apps/api`           |
| Worker   | Asks the platform before each call, queues it, turns finished calls into signed results, retries their delivery, deletes old tasks, pings the health check | `apps/worker`        |
| Voice    | Takes queued calls, dials them through Asterisk, holds the conversation with Gemini, writes the result                                                     | `apps/voice`         |
| Asterisk | Signs in the ten phone lines and carries the calls                                                                                                         | `deploy/asterisk`    |
| Postgres | Tasks, attempts, results waiting to be delivered, the lines' state                                                                                         | `packages/db`        |

The shared code is in `packages`: `core` (outcomes, call hours, retries, phone numbers), `conversation` (the agent's instruction and functions), `places` (the 69 wilayas and 1,541 communes), `ai` (the Gemini Live session) and `webhooks` (signing and delivery).

## A call, from order to result

1. **The platform sends a task** (`POST /v1/tasks`). The API saves it, due 2 minutes later inside call hours.
2. **The worker asks the platform** whether the call is still wanted. If so, it queues an attempt.
3. **The voice app dials** within its limits per line, in total and per store, on the registered line with the fewest calls. It dials nothing unless `CALLS_ENABLED` is `true`, and only the numbers in `ALLOWED_NUMBERS` (none when unset, every one with `any`).
4. **Gemini connects while the phone rings.** When the customer answers, Asterisk sends the call's audio to the voice app over a WebSocket, matched to its call by the channel's id. The voice app waits for the customer's "allo", then the agent greets them.
5. **The agent confirms the order.** It reads it, listens, looks up a wilaya and commune it hears, and ends with one function: confirm, cancel, call later, change, wrong number, talk to the store, or voicemail. The code checks the agreement: a confirmation and a new place need the customer's yes.
6. **The voice app writes the result**: the outcome, the customer's words, a confirmed new place, when to call back, what the agent said, and the call's cost. An unanswered call gets its outcome from the network's hang-up cause.
7. **The worker sends the result** to the platform, signed, and schedules the next call when the customer wasn't reached.

## Data

- **What a task holds:** the store's name, the customer's name, phone and language, the items, the total and the delivery place. Nothing else about the customer.
- **How long:** 30 days, then the task and its attempts and results are deleted.
- **Calls:** no audio is stored. The attempt keeps what the agent said, not the customer's side, whose transcription comes out in other languages.
- **The customer's voice goes to Google** (Gemini Live) during the call.
- **Logs** hold no phone numbers and no conversation.
- **Backups:** a dump every night at 03:30 UTC, the last seven kept on the server, none elsewhere.

## Limits and costs

- Calls: 09:00 to 20:00 Algiers time, at most 150 seconds each, three tries per task.
- A call costs about 1.5 US cents of Gemini for a plain yes and 3 to 5 cents with a change of place, plus the phone line's minutes. Each attempt records its own cost (`docs/telephony.md`, Usage).
