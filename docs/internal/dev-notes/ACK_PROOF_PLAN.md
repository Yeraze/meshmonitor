# Ack Proof ("Proven receipt") — Implementation Plan (#5279)

Status: **plan**, 2026-09-30. Protobufs submodule bumped to master `2542e06` in the PR that adds this file.

## Upstream status (verified 2026-09-30)

| Piece | Where | State |
|---|---|---|
| `Routing.ack_proof = 4` (8-byte HMAC) | protobufs #1094 `072c607`; firmware #11877 `6f3f0bd` | Merged (`master` / `develop`), 09-16 / 09-17. |
| Verify against the node we addressed | firmware #11932 `57bdedf` | Merged to `develop` 09-24. |
| `MeshPacket.ack_proof_status = 23`, enum `AckProofStatus` | protobufs #1109 `8f97d66`; firmware #11965 `2028484` | Merged 09-21 / 09-25. |
| Doc note: multi-hop acks often read ABSENT | protobufs #1114 `ad0bf31` | Merged; comments only. |
| First firmware to ship it | `develop` = **2.8.1** | No 2.8.1 tag yet. Newest build `v2.8.0.47db0e3` (09-01) predates all of it. |
| Upstream testing | #11877 "native suite only"; #11932/#11965 device-regression boxes unchecked | Hardware-unverified upstream. |

None of these PRs has been reverted. Firmware `develop` pins protobufs at `8f97d66` (includes #1109).

## What the firmware does (`develop`)

- **Proof:** `HMAC-SHA256(SHA256(X25519(priv, peerPub)), "ack" ‖ LE32(ackFrom) ‖ LE32(ackTo) ‖ LE32(request_id) ‖ Routing-without-field-4)[0..8)` (`CryptoEngine.cpp:360-392`).
- **Which acks carry it:** any unicast ROUTING_APP ack or nak with a `request_id`, when the acking node holds an authoritative key for the requester. This covers **channel-encrypted DMs too, not only PKI DMs**. Implicit acks and relay echoes carry none.
- **`ack_proof_status`:** set **only** on the phone-bound (FromRadio) copy of the ack that settles a unicast *this node* sent. Cleared on every inbound packet (LoRa, MQTT, UDP) and on client sends. Never on MQTT uplink.
  - `VALID`: proof checks out against the addressed node's key.
  - `INVALID`: a proof was carried and failed.
  - `NO_KEY`: a proof was carried but the node has no key to check it.
  - `ABSENT`: everything else, including naks from relays and acks that arrive after the relay echo already settled the packet. **On multi-hop paths a genuine receipt often reads ABSENT** (#1114).
- **Advisory only:** `ACK_PROOF_ENFORCE = false`. INVALID logs a warning; the ack still stops retransmission.

Consequences for MeshMonitor:
- We never compute or verify anything; we record what the radio tells us.
- The status is meaningful **only** on packets from our own TCP radio. MQTT-ingested acks never carry it, and MeshMonitor cannot verify `ack_proof` itself (it would need the node's private key).
- ABSENT and NO_KEY mean "not proven", never "failed".

## Implementation (build now; the field decodes after this bump)

1. **Migration (next free number):** `ackProofStatus` smallint, nullable, on `messages`. All three backends. `NULL` = no status reported (older firmware, MQTT, channel broadcast). Pattern: `xeddsaSigned` (migrations 125, 140; `src/db/schema/messages.ts:31/80/123`).
2. **Capture:** in `processRoutingErrorMessage` (`meshtasticManager.ts:9195`), in the target-node confirmed branch (`~:9272`), pass `meshPacket.ackProofStatus` into the `updateMessageDeliveryState(..., 'confirmed', ..., {...})` metadata. Also record it on a target-node nak (failed branch, `~:9455`), since naks carry proofs too. Only for DMs; ignore the field on anything that isn't the settling ack.
3. **Types and API:** `DbMessage`, `transformDbMessage.ts`, `src/types/message.ts` gain `ackProofStatus`. Map the enum by number, not by name (protobufjs `toJSON` emits names; see the enum-names gotcha).
4. **Delivery Details** (`src/utils/deliveryDiagnostics/meshtasticDelivery.ts:~195`, next to the XEdDSA row):
   - `VALID` → "Proven receipt: the recipient's key signed this ack."
   - `INVALID` → warning styling: "Ack proof failed: this ack may be forged." UI only, no notification (decided).
   - `ABSENT` / `NO_KEY` → muted: "Receipt not proven" with a tooltip explaining multi-hop echoes and missing keys. Never shown as a failure.
   - `NULL` → row hidden.
5. **Packet Monitor:** show the decoded `ackProofStatus` on the ROUTING_APP row from the packet's own decode. No `packet_log` column (decided).
6. **Locale keys** for all of the above in `public/locales/en.json`.
7. **Tests:** capture on confirmed and nak branches; not stored for non-target acks or channel messages; Delivery Details rendering per value; migration tests incl. PG/MySQL containers.
8. **Hardware validation (after 2.8.1 ships):** DM a 1-hop and a 3-hop node from a 2.8.1 radio; expect VALID on the 1-hop and often ABSENT on the 3-hop.

Mesh impact: none. Display only; no packets, notifications or timers.

## Decisions (maintainer, 2026-09-30)

- Bump protobufs to untagged master: **yes** (done in this PR).
- INVALID: UI warning only, no notification: **yes**.
- Store on `messages` only, no `packet_log` column: **yes**.
