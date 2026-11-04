# API

A platform sends NexusAI an order to confirm. NexusAI calls the customer, talks with them in Algerian Darija or French, and sends back what they said. The platform stays the record of the order: NexusAI keeps a task for 30 days, then deletes it.

## Keys

Each platform has an account with API keys and a webhook secret, made on the server with the CLI (`deploy/README.md`). Every request carries a key:

```
Authorization: Bearer nx_<prefix>_<secret>
```

A missing, wrong or revoked key gets `401 {"code": "unauthorized"}`. Each key may make 120 requests a minute.

## Create a task

`POST /v1/tasks`, with an `Idempotency-Key` header (1 to 200 characters). The same key again returns the task already made, with `200`, instead of making a second one.

```json
{
  "type": "order_confirmation",
  "external_store_id": "store-42",
  "external_id": "order-1001",
  "reference": "1001",
  "store": { "name": "Boutique Yasmine" },
  "customer": { "name": "Sara", "phone": "+213551234567", "language": "ar" },
  "order": {
    "items": [{ "title": "Chemise", "quantity": 2 }],
    "total": 6500,
    "currency": "DZD",
    "delivery": { "type": "home", "wilaya_code": 16, "commune": "باب الزوار" }
  },
  "callbacks": {
    "outcome_url": "https://platform.example.com/hooks/nexus/outcome",
    "check_url": "https://platform.example.com/hooks/nexus/check"
  }
}
```

| Field               | Rule                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `external_store_id` | The store in the platform, 1 to 100 characters                                                         |
| `external_id`       | The order in the platform, 1 to 100 characters                                                         |
| `reference`         | Optional: the order number the customer knows, up to 40 characters                                     |
| `customer.phone`    | An Algerian mobile, `+213` then 5, 6 or 7 and eight digits; NexusAI dials nothing else                 |
| `customer.language` | `ar` (Darija) or `fr`; the agent follows the customer if they speak the other one                      |
| `order.items`       | 1 to 30, each a title (up to 120 characters) and a quantity (1 to 99)                                  |
| `order.total`       | Whole dinars, said in words on the call                                                                |
| `order.delivery`    | `home` or `stop_desk`; the wilaya by code (1 to 69); the commune's name in Arabic or French, or `null` |
| `callbacks`         | HTTPS addresses for results and for the check before each call                                         |

Answers: `201 {"id", "status"}` for a new task; `400 {"code": "idempotency_key_required"}`; `400 {"code": "invalid_task", "problems": [{"path", "message"}]}`.

## Read or cancel a task

- `GET /v1/tasks/:id`: the task (`status`, `attempts`, `next_attempt_at`, `outcome`, `created_at`, `completed_at`) and `attempts_detail`, each with `number`, `status`, `outcome`, `note`, `change`, `callback_at` and `hangup_cause`. The phone number isn't returned.
- `DELETE /v1/tasks/:id`: cancels a task that is waiting for its next call. A task being called answers `409 {"code": "not_cancellable", "status"}`; the check before the call is the way to stop it.
- `GET /health`: `{"ok": true}` when the database answers.

## When calls happen

- The first call comes 2 minutes after the task, between 09:00 and 20:00 Algiers time; outside those hours it waits for the next morning.
- Up to three calls: the second an hour after the first, the third the next day at 10:00. Only an unanswered call is tried again (see Outcomes).
- **Before each call** NexusAI asks the platform whether it's still wanted, so a call never follows a confirmation made meanwhile.

## The check before each call

`POST` to `check_url`, signed (below), within 5 seconds:

```json
{ "external_store_id": "store-42", "external_id": "order-1001" }
```

The answer must be `{"call": true}` or `{"call": false}`. `false` cancels the task. An error or no answer asks again 5 minutes later.

## Results

After every call, `POST` to `outcome_url`, signed, with an `x-nexus-delivery` header (the delivery's id, the same on every retry):

```json
{
  "event": "task.completed",
  "task_id": "…",
  "attempt_id": "…",
  "external_store_id": "store-42",
  "external_id": "order-1001",
  "reference": "1001",
  "attempt": 1,
  "max_attempts": 3,
  "outcome": "request_change",
  "note": "حاب يبدل لرقان",
  "callback_at": null,
  "change": { "wilaya_code": 1, "commune_ar": "رقان", "commune_fr": "Reggane" },
  "ended_at": "2026-11-02T10:04:31.000Z",
  "usage": { "model": "gemini-3.8-live", "answered_seconds": 48, "usd": 0.018 }
}
```

- `event` is `task.completed` when the task is over (a final outcome, or the third call), and `task.attempted` when another call will follow.
- `note` holds the customer's words the agent passed: what to change, why they cancelled, why they want the store. It's in their language, often Arabic letters.
- `callback_at` is set with `call_later` when they gave a time; otherwise their words are in `note`.
- `change` is set with `request_change` only when the customer confirmed a new wilaya and commune on the call. Otherwise the change is in `note`, and the store should call them.
- `usage` is what the call used: the voice model, the seconds it was answered for (0 when nobody answered), and the model's estimated cost in US dollars, without the phone line. `model` is null and `usd` is 0 when no model spoke.

Any `2xx` answer counts as delivered. Anything else, or no answer within 10 seconds, is retried after 1, 5, 15 and 60 minutes, then every hour, 24 tries in all. Use `attempt_id` to ignore a result already recorded.

## Outcomes

| Outcome          | Meaning                                                   | Final |
| ---------------- | --------------------------------------------------------- | ----- |
| `confirmed`      | The customer said yes to the order as it stands           | yes   |
| `cancelled`      | They said they don't want it, twice                       | yes   |
| `call_later`     | They asked to be called another time                      | yes   |
| `talk_to_store`  | They want a person, or the agent couldn't understand them | yes   |
| `request_change` | They want something changed: see `note` and `change`      | yes   |
| `wrong_number`   | This isn't the customer, or they didn't order             | yes   |
| `invalid_number` | The number doesn't exist                                  | yes   |
| `no_answer`      | It rang out, or the network gave no reason                | no    |
| `busy`           | Busy, or the customer declined the call                   | no    |
| `unreachable`    | Phone off or out of coverage                              | no    |
| `machine`        | Voicemail answered; the agent said nothing                | no    |
| `no_input`       | Answered, but no answer was reached                       | no    |

## Voice settings

Which voice model an account's calls use, and how they sound. Each account reads and changes only its own, with its own key. Until it saves anything, calls use the defaults: `gemini-3.8-live`, the voices `Callirrhoe` and `Kore`, the standard wording and a longest call of 150 seconds. A save applies from the next call.

| Request                  | What it does                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/voice/models`   | The models NexusAI can run: their voices, the settings each takes with their ranges, their prices, and `available` when its API key is set |
| `GET /v1/voice/settings` | The settings with every model filled in, their `version` (0 until the first save), and the default wording as `defaults`                   |
| `PUT /v1/voice/settings` | Saves `{ "settings": ..., "version": <the version you read> }` whole, and returns the new `version`                                        |
| `POST /v1/voice/preview` | Takes `{ "language": "ar" }`, with an optional `style`, and returns the `instruction` a sample order would get. It saves nothing           |

```json
{
  "active_model": "gpt-realtime-2.1",
  "models": {
    "gpt-realtime-2.1": {
      "voices": { "ar": "marin", "fr": "cedar" },
      "vad": "server_vad",
      "silence_ms": 700,
      "threshold": 0.5,
      "prefix_padding_ms": 300,
      "reasoning": "low",
      "speed": 1,
      "noise_reduction": "off",
      "prices": {
        "kind": "tokens",
        "text_in": 4,
        "cached_text_in": 0.4,
        "audio_in": 32,
        "cached_audio_in": 0.4,
        "text_out": 24,
        "audio_out": 64
      }
    }
  },
  "style": {
    "ar": { "greeting": null, "speaking": null, "extra_rules": null },
    "fr": {
      "greeting": "Bonjour {name}, ici la boutique",
      "speaking": null,
      "extra_rules": null
    }
  },
  "max_call_seconds": 150
}
```

- **A model's settings** may name only what the catalogue says it takes, within its ranges. What's left out keeps its default.
- **`style`** holds the parts of the instruction an admin may change, per language; `null` is the default text. The greeting must contain `{name}` once and no other placeholder. The call's steps and functions can't be changed.
- **`max_call_seconds`** runs from the answer, from 60 to 600. At the limit the model says goodbye and the call ends.
- **`prices`** are in US dollars: per million tokens, or for GPT-Live per minute and per million tokens of its backend model. Each attempt's cost uses the prices saved when the call started.

| Answer | Code                | When                                                  |
| ------ | ------------------- | ----------------------------------------------------- |
| `400`  | `invalid_settings`  | The settings don't fit; `problems` says which and why |
| `400`  | `model_unavailable` | The active model's API key isn't set                  |
| `400`  | `invalid_preview`   | The language or the style doesn't fit                 |
| `409`  | `version_conflict`  | Someone saved since you read; read again              |

## Signatures

Both the check and the results carry `x-nexus-signature: t=<unix seconds>,v1=<hex>`, where the hex is the HMAC-SHA256 of `<t>.<raw body>` with the account's webhook secret. To verify:

1. Read `t` and `v1` from the header.
2. Refuse it if `t` is more than 300 seconds from now.
3. Compute the HMAC of `t`, a dot and the raw body (not re-serialized JSON), and compare it with `v1` in constant time.
