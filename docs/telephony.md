# Telephony: what the line check measured

Facts about the provider's lines, from test calls to an Algerian mobile on 2026-10-30.

## What works

| Item                   | Measured                                            |
| ---------------------- | --------------------------------------------------- |
| Registration           | TLS, all lines at once, number and password         |
| Dial format            | National, `0XXXXXXXXX` (`DIAL_FORMAT=national`)     |
| Codec                  | G.711 A-law, 20 ms, both directions                 |
| Audio from the callee  | Continuous at 50 packets a second, silence included |
| Packet loss and jitter | None seen on a short call; jitter about 1 ms        |

## What has to be set up

- **Inbound audio needs the cloud firewall rule.** The provider's media comes from addresses other than its SIP server, and they change between calls. The cloud security group must allow UDP 10000-10199 from the provider's network. Replies alone aren't enough.
- **The routing name must be pinned.** The provider's `Record-Route` names a host that public DNS resolves to another machine. Unpinned, the `ACK` goes there, the provider resends `200 OK` for 32 seconds, then stops the audio. `PROVIDER_ROUTE_NAME` pins it to `PROVIDER_HOST`'s address, and `resolver_unbound.conf` makes Asterisk read `/etc/hosts`.

## Keypad: does not work on this route

Pressing keys on the mobile reaches nothing. On a healthy 72-second call:

- the provider's SDP answer has only `PCMA`; it drops the `telephone-event` we offer;
- no SIP `INFO` arrives;
- the audio holds no DTMF tones.

Two Algerian mobile networks behaved the same way, so the limit is in the provider's service. Landlines are not tested. Enabling `telephone-event` is a question for the provider.

## Voices

Chosen by listening on real calls: `Callirrhoe` for Darija, `Kore` for French (`VOICE_AR`, `VOICE_FR`). Totals are said in words, spelled by the code ("ستة آلاف وخمسمية دينار"), never left to the model.

On phone calls the model's pitch drifts, more than in a text-only test. `Aoede` sits near 170 Hz, so its dips below 160 Hz sounded like a man. `Callirrhoe` sits near 200 Hz and stayed between 194 and 218 Hz on a full call. `apps/voice/src/voice-test.ts` measures how steady each voice is.

## Spoken calls: what works and what doesn't

Tested on 2026-11-01 with `gemini-3.8-live`, on Mobilis:

- **Works:**
  - the greeting by name;
  - reading the order;
  - yes ("oui", "إيه") and no, with a second check before cancelling;
  - "call me later";
  - asking again when unsure;
  - falling back to "the shop will call you" without guessing.
- **Audio:**
  - It stays up through long silences, because silence is sent while the model is quiet. Without it, the provider stopped the audio of some calls after about 30 seconds.
  - If the customer's phone sends no audio for 30 seconds, Asterisk ends the call (`rtp_timeout`), with no answer.
- **Places: the wilaya and the commune only.**
  - The agent never asks for the street, and never offers pick-up at an office.
  - It looks up what it heard with `find_place` (`@nexus/places`: the 69 wilayas and 1,541 communes), says the match back, and passes a place only after the customer says yes.
  - On the phone, Aoulef and Reggane (Adrar) and Béchar were found and confirmed. A commune that isn't in the wilaya ended, after two tries, with "the shop will call you" and no place.
  - A TV beside the phone was enough for the agent to miss "Béchar" entirely.
  - The instruction names no place but the order's. With "أولف" as an example, the agent passed Aoulef when it didn't catch the commune.
  - A "no" alone isn't a cancel: "لا لا" followed by a commune was taken for one. The agent now asks what's wrong.
- **What the code checks, because the instruction alone didn't hold:**
  - A confirmation, and a new place, carry the customer's words of agreement. They must hold a yes ("إيه", "صحا", "بعثوها", "oui"...) and no "لا". Otherwise the agent is told so and the call goes on. The agent once took a name said again for a yes, and in the dialogue test it called `confirm_order` before saying a word, with its own greeting as the answer (4 conversations in 24).
  - A new place must be one a lookup offered.
  - No confirmation once a lookup has offered another place: the agent confirmed an order, on a reply it misheard, while the customer was changing the place.
  - A lookup of the order's own place says so instead of offering it back. Said back, it sounded like a question about the order.
  - The first outcome stands; a later one is ignored.
- **Timing:**
  - Gemini connects while the phone rings.
  - Most people say "allo" first. Greeting at a fixed moment, 1.4 to 2.3 seconds after the answer, collided with it in 3 calls out of 7: the model stopped, and the customer waited 6 to 9 seconds in silence.
  - The greeting now waits until the customer has been quiet for 400 ms after speaking, or 2 seconds if they say nothing, and 3 at most. The model hears the customer only from the greeting on. The first words come about 3 seconds after the answer, and the greeting plays whole.
- **Hang-up:** the call waits a second after the goodbye is sent. The phone plays it later, and hanging up at once cut its end off.
- **Not usable as a record: the transcript of what the customer said.** It comes out in other languages and scripts even when the model understood. Gemini sends it even though the call doesn't ask for it, so it's only printed in the log.
- **Usage:** Gemini reports after each turn, for that turn alone, and each turn's prompt is the whole conversation so far (2,349, then 2,466, then 2,664 tokens). A call's total is the sum: 20,000 to 32,000 prompt tokens for a call of 40 to 50 seconds. A turn with a function call counts about twice, because the model runs again after the answer.
- **Once, the model's reasoning came out as speech.** In 1 dialogue-test conversation out of 12, the agent's transcript started with English reasoning ("Analyze the user's input..."). It wasn't seen on the phone calls.
- **`gemini-3.8-live-extended-thinking` did worse.** It confirmed an order while the customer was changing the wilaya, and it cost about twice as much.
