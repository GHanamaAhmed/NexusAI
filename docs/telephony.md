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

Other destinations and networks are not tested yet.
