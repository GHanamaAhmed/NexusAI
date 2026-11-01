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
- **Audio:** it stays up through long silences, because silence is sent while the model is quiet. Without it, the provider stopped the audio of some calls after about 30 seconds.
- **Weak: place names.**
  - The wilaya is often understood once the list of the 69 wilayas is in the instruction.
  - Communes and street addresses usually aren't.
  - Because of this, an address is passed to the client only after the customer confirms it, otherwise the shop is asked to call back.
- **Not usable as a record: the transcript of what the customer said.** It comes out in other languages and scripts even when the model understood.
- **`gemini-3.8-live-extended-thinking` did worse.** It confirmed an order while the customer was changing the wilaya, and it cost about twice as much.
