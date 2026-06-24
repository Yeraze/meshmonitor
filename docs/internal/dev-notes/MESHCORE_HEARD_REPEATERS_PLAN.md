# MeshCore Channel "Heard Repeaters" (#3700)

## Problem
When you send a MeshCore **channel (broadcast)** message, nothing tells you whether
any repeater actually relayed it. DMs get an ACK (`expectedAckCrc` →
`meshcore:send-confirmed`); channel sends carry no ACK by protocol —
`sendChannelTextMessage` resolves on the device `Ok` and the native backend
returns only `{ sent: true }`.

## Feasibility — self-echo correlation
Channel messages are `PAYLOAD_TYPE_GRP_TXT` (0x05) packets. On the wire a packet
is `[header][?transportCodes][pathLen][path…][payload]`. For GRP_TXT the
`payload` is `[channel_hash 1B][ciphertext(timestamp,"name:msg")][MAC]`. The
**payload bytes are invariant** as the packet floods the mesh — only `header`
(route type) and `path` (the relay-hash chain) mutate per hop.

Every packet the device **receives over the air** is surfaced via the companion
`LogRxData` push → parsed in `meshcoreNativeBackend.wirePushEvents` → emitted as
the `ota_packet` bridge event (carries `raw_hex`, `path_hops`, `snr`,
`payload_type`). When a nearby repeater re-floods **our own** channel packet, our
device hears that re-flood as an inbound packet whose GRP_TXT payload is
byte-identical to what we sent, but whose `path` now contains the relaying
repeater's hash. **That is the signal.**

### Correlation
1. On a channel send, register a *pending channel send* `{ msgId, channelIdx,
   sentAt }` for the source. We do **not** have the outgoing payload bytes
   (the bridge does not return them), so we cannot key on the payload up front.
2. For each inbound `GRP_TXT` `ota_packet` arriving within
   `HEARD_WINDOW_MS` of a pending send, treat it as a candidate self-echo of
   that send. The packet's `path_hops` are relay hashes of repeaters that
   carried it. Reuse the `bufferedAt`-style staleness window (#3589) so we never
   attribute packets heard long after the send.
3. Dedup repeaters by relay-hash. Resolve each hash to a known repeater contact
   via `resolveContactByPrefix` (best-effort; show the raw hash when unknown).
   Track the best (max) SNR seen per repeater.
4. Persist the heard-repeater set onto the message and push an incremental
   `meshcore:channel-heard` WS event (mirrors `meshcore:send-confirmed`).

### Why best-effort
Without the outgoing payload we cannot prove a given GRP_TXT in the window is
*ours* vs. unrelated channel chatter on the same channel. We bound the risk:
only GRP_TXT, only within a short window after one of *our* sends, only on a
matching channel. This matches the issue's "best-effort; show raw hash when
unknown" guidance and the original MeshCore app's heard-repeater list.

## Per-source side table (migration 102)
`meshcore_heard_repeaters` — one row per (message, repeater hash). PER-SOURCE
(`sourceId`, scoped). Independent of the opt-in packet monitor: correlation runs
on the raw `ota_packet` data **before** the monitor's `isEnabled()` gate.

Columns: `id` PK, `sourceId`, `messageId` (FK-ish to meshcore_messages.id),
`repeaterHash` (hex relay hash), `repeaterName` (resolved contact name, nullable),
`snr` (nullable), `heardAt`, `createdAt`. Unique on (messageId, repeaterHash).

A side table (not a JSON column) keeps the variable-length list normalized,
supports cheap per-message aggregation, and avoids read-modify-write races on a
single message row as multiple echoes stream in.

## Surfacing
- `getChannelMessages` / message snapshot enrich each outgoing channel message
  with `heardBy: { hash, name?, snr? }[]`.
- WS `meshcore:channel-heard` `{ sourceId, messageId, heardBy }` updates the
  in-memory message list (same pattern as send-confirmed).
- UI: in `MeshCoreMessageStream`, outgoing channel messages show a
  count badge (`📡 N`) that expands to the repeater/path list.
