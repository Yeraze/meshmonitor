# MeshCore MQTT Broker

::: tip Added in 4.18 (#6197)
Run an MQTT broker inside MeshMonitor that MeshCore observers publish to directly. No external broker to stand up.
:::

## What it is

A `meshcore_mqtt_broker` source listens for MQTT connections from MeshCore observers (repeaters and Companion observers that publish in the Analyzer format). Frames they publish feed the same pipeline as a [MeshCore MQTT Ingest](/features/meshcore-mqtt-ingest) source, so you get the Packet Monitor, node discovery from adverts, channel decrypt (for keys you hold) and observer battery / uptime with no extra setup.

It is the MeshCore twin of the Meshtastic [Embedded MQTT Broker](/features/mqtt-broker).

**This source has no radio.** It never transmits on RF. Load is capped by the limits below, and the optional forwarding is MQTT only.

Use it when you want a private, local observer network. To read a public region feed instead, use [MeshCore MQTT Ingest](/features/meshcore-mqtt-ingest). To publish what your own Companion hears to a public broker, use the [Analyzer Observer](/features/meshcore-analyzer-observer).

## Setting one up

**Dashboard → Add source → MeshCore MQTT broker.**

| Field | Notes |
|---|---|
| Listener port | TCP port observers connect to. Default `1884`. Must not clash with another broker source. Expose it from the container (`-p 1884:1884`). |
| Allowed regions | Optional IATA codes. Blank accepts any well-formed code. |
| Token audience | The audience observers sign their token for. Blank turns token logins off. |
| Allowed observer public keys | One 64-hex key per line. Binds every login: a token login needs a key on this list, and a static login may only publish under keys on it. |
| Static username / password | Optional fixed login, for observers that use one. |
| Limits | Max observers (default 50), messages per second per connection (default 20), max payload (default 64 KB). |
| Upstream forwarding | Optional. Off by default. See below. |

Anonymous logins are always refused. A config with neither a token audience nor a static login cannot be saved.

WebSocket listeners are not in v1. Observers must use plain MQTT over TCP.

## Authentication

Two ways in:

1. **Observer token.** Username `v1_{PUBKEY}` (the observer's 64-hex public key), password the Ed25519 token the observer mints. MeshMonitor verifies the signature, the expiry, and that the token's audience matches the one you set. The key must be on the allowlist.
2. **Static login.** The username and password you set. Any observer that knows them can connect, but it may only publish under keys on the allowlist.

A token login may only publish under its own key: the `{PUBKEY}` in the topic must match the key it logged in with. A static login may publish under any allowlisted key; a frame under any other key is dropped and counted, and the session stays open.

## Topics

```
meshcore/{IATA}/{PUBKEY}/packets
meshcore/{IATA}/{PUBKEY}/status
```

- `{IATA}`: 2 to 8 letters or digits (`test` works). Checked against the allowed regions when you set any.
- `{PUBKEY}`: the publishing observer's 64-hex public key. The body's `origin_id` must match it.

Observers cannot subscribe. The broker refuses every SUBSCRIBE, so one observer can never read another's raw feed, and nothing is retained.

## Payload format

The broker accepts the format the MeshCore Analyzer bridge publishes. Only `raw` and `origin_id` are required for a packet; every structural field is re-derived from `raw`. `type`, when present, must be `PACKET`. (Keys and `raw` are shortened below.)

A `packets` message:

```json
{
  "origin": "Hilltop Repeater",
  "origin_id": "3F2A9C...64 hex characters...B71E",
  "timestamp": "2026-11-14T18:22:05.118Z",
  "type": "PACKET",
  "direction": "rx",
  "packet_type": "4",
  "route": "F",
  "len": "38",
  "payload_len": "32",
  "raw": "1100A1B2C3D4E5F6...",
  "SNR": "7.25",
  "RSSI": "-92",
  "hash": "9C4E1A2B3D4F5A6B"
}
```

A `status` message (observers usually publish it retained, every few minutes, plus an `offline` last will):

```json
{
  "status": "online",
  "timestamp": "2026-11-14T18:20:00.000Z",
  "origin": "Hilltop Repeater",
  "origin_id": "3F2A9C...64 hex characters...B71E",
  "model": "Heltec V3",
  "firmware_version": "1.9.1",
  "radio": "915.0,250.0,10,5",
  "client_version": "meshcoretomqtt/1.0",
  "stats": { "battery_mv": 4105, "uptime_secs": 86400, "noise_floor": -112 }
}
```

## Diagnostics

The source's page (**Overview** tab) shows a **Broker connections** card:

- each connected observer: login kind, accepted / dropped counts, **last topic**, **last reject reason**;
- recent login refusals and disconnects;
- forwarding target state (connected, sent, dropped, last error).

Reject reasons you will see:

| Reason | Meaning |
|---|---|
| Login refused (bad or missing credentials) | Wrong static password, anonymous login, or a username that is neither the static one nor `v1_{PUBKEY}`. |
| Login refused (key not on the allowlist) | Valid-looking token login from a key you have not allowed. |
| Login refused (token invalid or expired) / (audience does not match) | The token failed verification. |
| Login refused (observer limit reached) | Max observers reached. |
| Dropped (over the message rate) | More than the per-connection msg/s limit. The observer stays connected. |
| Dropped (payload too large) | Over the payload cap. A connection that announces a packet far over the cap is cut. |
| Dropped (key not on the allowlist) | A static login published under a key you have not allowed. |
| Dropped (region not allowed) | IATA segment malformed or not on the allowed list. |
| Dropped (key in topic, token and origin_id differ) | Topic key differs from the login key or from `origin_id`. |
| Dropped (raw is missing) / (type is not PACKET) / (origin_id is not 64 hex characters) / (raw is not a MeshCore frame) | Body problems. |
| Dropped (our own forwarded frame came back) | The loop guard caught a frame MeshMonitor forwarded. |

These counters live in memory and reset when the broker restarts.

Who sees what: the card needs the same per-source **Nodes: read** permission as the rest of the page. Observer IP addresses, upstream URLs and listener errors also need **Sources: read**.

## Upstream forwarding

Off by default, and opt-in per target. Each target forwards only the observers you list on it (packets and status), with an optional IATA filter. An empty observer list forwards nothing.

::: warning Observer data leaves MeshMonitor
Forwarding sends your observers' frames to the broker you name. Only add a target you trust with that data, and list only observers whose owners agreed.
:::

Each target picks an identity:

| Mode | What upstream sees | Login | Notes |
|---|---|---|---|
| **Pass-through** | The original topic and body, verbatim | The target's static username / password | Keeps per-observer attribution. Token-only brokers (LetsMesh) refuse it. |
| **Own identity** | Every frame under MeshMonitor's own observer key; `origin_id` and `origin` rewritten | A token MeshMonitor mints for the target's audience | Works with LetsMesh. All frames appear to come from one observer. |

Own identity needs a MeshMonitor observer key. Edit the saved source and use **Generate key** under forwarding. The private key is sealed with `SESSION_SECRET` (like the Analyzer Observer key) and never shown; only its public key is. Without `SESSION_SECRET` set, the key cannot be stored.

In own-identity mode, observers' `/status` heartbeats are not relayed: one observer going offline would mark the whole MeshMonitor identity offline. The target publishes MeshMonitor's own online status instead, with an offline last will.

Forwarding never loops: forward clients only publish (they never subscribe), MeshMonitor's own key cannot log in to its own broker, a target cannot point at the broker's own port, and a frame MeshMonitor forwarded in the last two minutes is dropped if it comes back in.

Forwarding carries only frames that passed the broker's limits, so it is capped by them too. A target that rejects the login five times in a row stops reconnecting until you save or reconnect the source.

## Security notes

- Upstream passwords and the static password are stored in the source config and returned to admins only; editors see them masked, viewers never see them. Changing a target's URL as an editor drops its stored password.
- The own-identity private key lives in the sealed observer key store, is included in system backups as a secret, and is removed when the source is deleted.
- On MySQL, a source config is limited to 4096 bytes. A very long allowlist is refused on save rather than truncated.
