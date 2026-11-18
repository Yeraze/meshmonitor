# Unified Messages Send — Epic (#3045, dup #4824)

**Goal:** send channel messages, replies and tapbacks from the Unified Messages page
(`src/pages/UnifiedMessagesPage.tsx`) through one chosen source per send, with the
existing per-source permissions, a rate limit and an audit trail.

## Decisions (user, 2026-11-18 — final)

| Topic | Decision |
|-------|----------|
| Fan-out | **One source per send.** The composer always names exactly one sending node. No multi-source send, no confirm dialog. |
| Rate limit | Add `messageLimiter` (`RATE_LIMIT_MESSAGES`, 30/min prod) to Meshtastic `POST /api/messages/send`. This also caps the existing Meshtastic Channels/DM tabs; say so in the PR. |
| Audit | Every send writes an audit row: user, time, source, channel (or DM target), reply/tapback flag. **No message text** (matches `auditMeshcoreEvent`). Read through the existing audit log. |
| Default node per channel | Per browser (localStorage), like `unifiedChannelPreference.ts` (#5792). |
| Roles table in #3045 | Maps onto existing per-source permissions: Meshtastic channel send = `channel_N:write` on that source; MeshCore = `messages:write`; MQTT native = `messages:write` + channel-database `canRead`. Never `anySource` for a send. |
| Out of scope | Sending on the **All Channels** view (needs one explicit channel); **DMs** from Unified; **Reticulum** (no channels). |

## Architecture

No new server send path. The Unified composer calls the existing per-source routes and always passes the source id:

| Source type | Route | Channel argument |
|-------------|-------|------------------|
| Meshtastic TCP | `POST /api/messages/send` `{sourceId, text, channel, replyId?, emoji?}` | physical slot 0–7 only |
| MQTT native | `POST /api/sources/:id/mqtt/native/send` | virtual channel (`>= CHANNEL_DB_OFFSET`) only; native send must be enabled |
| MeshCore | `POST /api/sources/:id/meshcore/messages/send` `{text, channelIdx}` | physical MeshCore channel idx |

Hazards found in orientation:
1. `/api/unified/channels` lists every virtual channel (`100 + id`) under **every** source. Meshtastic `/send` clamps a channel above 7 to 0 (sends on Primary); MeshCore accepts 0–255 (sends on another slot). A source ref is a valid sender only for a real slot of its type, or (MQTT native) a virtual channel with native send on.
2. Sender eligibility must be computed server-side per source ref (permission + connected + TX enabled / not receive-only / MQTT native on). `/api/unified/sources-status` has no permission filter and no TX state.
3. Meshtastic `replyId` / tapback is the wire packet id, so it works from any Meshtastic source. MeshCore reactions look the parent row up in the sending source, so only a source whose `mc:<sourceId>:<rowId>` is in the item's `meshcoreRowRefs` can react. A MeshCore reply is a plain `@[Name]: ` text prefix and works from any MeshCore source.

## Mesh impact

- Airtime: one send = one transmission from one node (× hops). No timers, no fan-out.
- Spam: covered by `messageLimiter` (now on every channel-send route used here); no automation trigger added.
- Timers: none.

## Phases

- [x] **P1 — Server.** `messageLimiter` on `/api/messages/send`; send audit rows (Meshtastic, MQTT native, MeshCore; no text); a permission-filtered per-source-ref sender list (`canSend` + reason) for Unified, with route-harness tests.
  *Exit:* routes tested with `createRouteTestApp`; virtual/physical slot rules enforced in the sender list; CI green; merged.
- [ ] **P2 — Composer.** `MessageComposeInput` on Unified for one explicit channel; node picker limited to eligible senders; per-browser default node per channel; byte limit per source type; hidden/disabled on All Channels. Docs + screenshot.
  *Exit:* live-validated on the dev container (no transmit unless the user OKs reconnecting radios; `gauntlet` only); merged.
- [ ] **P3 — Replies, tapbacks, status.** Reply and tapback from Unified rows (rules in hazard 3); delivery status where the sent row already tracks it. Docs + screenshot.
  *Exit:* live-validated; merged.

## Phase 1 result (server)

- `messageLimiter` on `POST /api/messages/send`; its 429 now carries `code: 'RATE_LIMITED'` and `retryAfterSeconds`. The bucket is per IP and shared with the MeshCore, MQTT-native and v1 send routes. The existing Meshtastic tabs show their generic send error on a 429 until P2 handles it.
- Audit rows (no text, no length), successful sends only: `message_sent` (Meshtastic), `mqtt_native_message_sent`, `meshcore_message_sent`, `meshcore_room_post_sent`. MeshCore sent-as / resend / reaction keep their existing rows.
- `GET /api/unified/senders` → `{ success, data: { channels: [{ name, sources: [{ sourceId, sourceName, channelNumber, canSend, sendKind, sendBlockedReason }] }] } }`. Anonymous viewers get `[]`. Built from `buildUnifiedChannelGroups` (`src/server/services/unifiedChannelGroups.ts`, shared with `/channels`) and `resolveUnifiedSenders` (`src/server/services/unifiedSendEligibility.ts`). Check order: visibility gate → source kind → slot rule → per-source permission → live state. `sendKind` is non-null only once permission passed.
- `prepareMqttNativeSend` is the one MQTT-native precondition for both the send path and the list; `unifiedSendEligibility.ts` is on the `mqttNativeSendService` guard allowlist (it never transmits).
- Deviation: `loadEnabledVirtualChannels()` returns Meshtastic-protocol channel-database rows only, so MeshCore-protocol rows never appear in the sender list.
- Found, not fixed (follow-ups): `/api/unified/channels` lists each virtual channel under every source with no read check on that source (source names visible to a channel-database-only reader); `POST /api/v1/messages` writes no audit row; `/api/messages/send` still clamps channel > 7 to 0; it uses `optionalAuth`, so an anonymous account granted write can send; `parseDestinationNum` runs before the permission check.

## Log

- 2026-11-18: interview done; plan approved.
- 2026-11-18: P1 implemented (WP1 rate limit + audit, WP2 sender list).
- 2026-11-18: P2 implemented (send composer, sender picker, per-channel drafts, error handling; no retry).
