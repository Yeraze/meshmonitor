# MeshCore Reactions Epic (#5759)

Sub-issues: #5760 (A), #5761 (B), #5762 (C), #5763 (D), #5764 (E).

## Goal

Read and send MeshCore emoji reactions so they interoperate with the MeshCore
One (MC1) iOS app, and read the meshcore-open client's reactions.

## What the issues got wrong

The issues assume MeshCore messages sit in `messages` with `emoji` / `replyId`.
They do not. The plan below replaces "normalize to `emoji=1` + `replyId`".

- MeshCore messages live in `meshcore_messages`: string ids, no `emoji`, no
  `replyId`. Reactions get their own columns there and their own chips in
  `MeshCoreMessageStream`.
- The hash needs the sender's wire timestamp. We keep it only for our own
  channel sends. Received rows lose it when the sender's clock is implausible;
  our own DMs do not store it.
- One message is one row per source (merged at read time), so a reaction and
  its target resolve per source.
- Most `emoji` readers in #5763 never see a MeshCore message. The real leaks: a
  channel reaction to our message fires a false "mentioned you" alert, and a
  reaction passes through auto-ack, auto-responder, forwarding and automations
  as plain text.

## Wire formats

### MC1 (read and send)

Verified against `Avi0n/MeshCoreOne` at `8b141a48` (v1.5.2) and its
`docs/Reactions.md`. **MC1 is GPL-3.0 and MeshMonitor is BSD-3-Clause: do not
copy or translate its code. Implement from the format described here.**

- Channel, current: `@[{targetSender}]{emoji}\n{hash}`
- Channel, legacy (MC1 < 1.4.1), read only: `{emoji}@[{targetSender}]\n{hash}`
- DM: `{emoji}\n{hash}`
- `hash` = Crockford Base32 of `SHA256(utf8(text) || u32le(timestamp))[0:5]`:
  8 chars, **lowercase**, alphabet `0123456789abcdefghjkmnpqrstvwxyz`, 40 bits
  MSB first.
  - `text` for a channel message is the body **without** the `Sender: ` prefix:
    everything after the first `:`, spaces and tabs trimmed at both ends.
  - `timestamp` is the sender's packet timestamp in seconds.
- Hash read rules: exactly 8 chars; both cases; `O`/`o` → `0`; `I`/`i`/`L`/`l`
  → `1`; `U`, hyphen and non-ASCII are invalid; normalize to lowercase.
- Parse, channel: split at the **last** `\n` (no trimming anywhere); the tail
  must be a valid hash; find the **first** `@[` in the head. If nothing comes
  before it: sender runs to the **first** `]`, the rest is the emoji. Otherwise
  (legacy): the text before `@[` is the emoji, the rest must **end** with `]`
  and the sender is what lies between. The emoji must be a reaction emoji and
  the sender non-empty.
- Parse, DM: reject any text containing `@[`; split at the last `\n`; valid
  hash; the head must be a reaction emoji.
- Reaction emoji: exactly one extended grapheme cluster, whose first scalar has
  the Unicode `Emoji` property, and either that scalar is above U+238C or the
  cluster has more than one scalar. Skin tones, ZWJ sequences, flags, VS16 and
  keycaps pass; a bare `1`, `#`, `©` fails.
- Published vector: text `Hello`, timestamp `1704067200` → `b45pc4ek`.
  Others (same algorithm): `Hello world`/1704067200 → `7a6r3xy1`;
  `Hello`/1704067201 → `3wh8x8z5`; `World`/1704067200 → `vp1vxnf4`;
  `Message 0`/0 → `7mt5pe1m`; `café 👍 ok`/1760000000 → `8b5qzwf6`;
  empty/4294967295 → `npah66y0`.
- MC1 behaviour worth matching: target lookup is exact, case-sensitive on
  sender name, newest match wins; a reaction with no target is held and
  resolved when the target arrives; dedupe on (target, reactor name, emoji); no
  un-react; several emojis per message allowed; **no reactions in rooms**.

### meshcore-open (read only)

`zjs81/meshcore-open` is MIT. Take the format and the emoji table from **its**
source, with attribution, not from MC1's copy.

- v3: `r:{4 hex}:{2 hex emoji index}` (9 chars). Hash = Dart `String.hashCode`
  over the UTF-16 of `"{timestamp}" + senderName (channel only) + first 5
  UTF-16 units of the text`, masked to 16 bits. Emoji index into a 184-entry
  table.
- v1 (before Jan 2026): `r:{millis}_{senderNameHash}_{textHash}:{emoji}`.
- The Phase 1 architect must confirm both against the meshcore-open source.

## Decisions (user interview, 2026-10-12)

| Topic | Decision |
|---|---|
| Unmatched reaction | Store as a reaction with no target; show one dim line ("Alice reacted 👍 to a message not seen here"); becomes a chip if the target arrives later |
| meshcore-open format | Read it too; never send it |
| Send limits | Existing HTTP message limiter; one send per (message, emoji) from us; never auto-retry or resend a reaction; automations keep their own limits |
| Reaction to my message | No alert; stop the false mention alert |
| `meshcoreReactionsAckOnReceive` | Build it: global, default **off**, warning beside the toggle. Off = Auto-Acknowledge never answers a reaction |
| Auto-Responder, Forwarding | Always skip reactions |
| Outbound off for a source | Hide the picker; the API refuses; automations record a skip |
| Rooms | No reactions |
| Rig tests | Allowed on `gauntlet` only, between MC-Sandbox and MC-BLESandbox. The user checks against a real MC1 device |

## Mesh impact

- Airtime: one reaction = one channel or DM text packet, flooded like any chat
  message. No timer, no per-node fan-out.
- Spam: capped by `messageLimiter`, the per-(message, emoji) dedupe, and no
  retry. Inbound reactions fire no notification, no auto-responder and no
  forward. Auto-ack of reactions is off unless the operator turns it on.
- Timers: none added.

## Phases

- [x] **Phase 1 — codec** (#5760, version constant from #5764). Pure,
  browser-safe module in `src/utils/`: MC1 hash, build, parse (both channel
  orders), reaction-emoji test, meshcore-open v3/v1 parse and hash,
  `MC_REACTION_FORMAT_VERSION`. Unit tests with the vectors above. No wiring.
  *Exit:* tests green; nothing imports it at runtime.
- [x] **Phase 2 — inbound** (#5761, inbound + ack settings from #5764).
  Migration 203: wire `senderTimestamp` kept on every new row, reaction columns
  on `meshcore_messages`. Ingest detection and target lookup on every ingest
  path (companion, repeater, MQTT); late-target resolution; reaction rows kept
  out of mention alerts, auto-responder, forwarding and (by default) auto-ack;
  chips and the unmatched-reaction line in the MeshCore channel and DM views;
  `meshcoreReactionsInboundEnabled` (per source) and
  `meshcoreReactionsAckOnReceive` (global) with their toggles.
  *Exit:* an MC1-format channel and DM reaction shows as a chip; no raw
  reaction text in chat; inbound off stores raw text.
- [x] **Phase 3 — outbound** (#5762, outbound setting from #5764). Send route,
  emoji picker in the MeshCore stream, optimistic local row, dedupe, no retry,
  `meshcoreReactionsOutboundEnabled` (per source), automation tapback on
  MeshCore, wire second stored for our own DMs.
  *Exit:* a reaction sent from MeshMonitor is read back as a reaction by a
  second source; rig test on `gauntlet`.
- [x] **Phase 4 — downstream** (#5763). Unified Messages chips, CSV export,
  automation trigger `isTapback` and reply target for MeshCore, docs.
  *Exit:* the audit table in #5763 is answered row by row, with a test or a
  stated "MeshCore never reaches this".

## Log

- 2026-10-12: plan written; Phase 1 started.
- 2026-10-12: Phase 1 done. Codec in `src/utils/meshcoreReactions.ts`, table in
  `src/utils/meshcoreOpenEmojiTable.ts`. Checked against meshcore-open at
  `3bee159c`; its source corrects the summary above:
  - The hash is the app's own `stableStringHash` (Jenkins one-at-a-time over
    UTF-16 units, 30-bit mask, 0 → 1), which upstream tests pin to the Dart VM
    value. Web builds before `25f197c` (2026-10-11) used another hash and will
    never match a target.
  - The table has 184 entries, 178 distinct. Every index is valid.
  - v1 has two shapes: channel `r:{ms}_{nameHash}_{textHash}:{emoji}` and 1:1
    `r:{ms}_{8 hex of sender key}:{emoji}`. Ship v1 as parse + best-effort match.
  - meshcore-open splits a channel body differently from MC1: it strips one
    space after the colon and does not trim.
  - **For Phase 2:** our stored channel bodies are `.trim()`ed, wider than MC1's
    space-and-tab trim. Decide whether to keep the raw wire body for hashing.
    `@[Alice]👍\nreceived` parses as a reaction (hash `rece1ved`), as in MC1, so
    expect some unmatched reactions that are really chat.
- 2026-10-13: Phase 2 done. Migration 203 (seven nullable columns, index on
  `(sourceId, mc1Hash)`, no backfill). Rules in
  `src/utils/meshcoreReactionTarget.ts`, one resolver for all three ingest
  paths in `src/server/services/meshcoreReactionIngest.ts`, UI in
  `meshcoreReactionGroups.ts` and `MeshCoreReactionChips.tsx`. Decisions made
  on the way:
  - We keep the raw wire body out of the row. `mc1Hash` is computed at ingest
    from the wire text and stored, so the lossy `.trim()` no longer matters for
    new rows. Old rows are matched by a hash rebuilt from the trimmed body.
  - Bounds: an `mc1Hash` index hit takes the newest 10; old-row and
    meshcore-open scans read the newest 200 rows inside 7 days; 500 unmatched
    reactions wait per source.
  - New event `meshcore:reaction:resolved`, gated like `meshcore:message`, so a
    viewer with only `channel_N:read` still gets a late chip.
  - A reaction row skips automations, Auto-Responder, Forwarding and mention
    alerts. The mention alert is skipped even with inbound off. Auto-Ack runs
    only when `meshcoreReactionsAckOnReceive` is on, and then sees the raw text.
  - A reaction from an ignored sender shows nowhere. Deleting a message deletes
    its reactions.
  - Until Phase 4: search leaves reactions out; Unified Messages and CSV show
    an emoji-only line.
  - Own DMs now store `senderTimestamp` and `mc1Hash` (planned for Phase 3).
  - **Known limits:** resolution is per source; the meshcore-open v3 hash is 16
    bits, so a wrong match is possible inside 200 rows; a missed resolve event
    leaves the dim line until reload; a chip whose target sits on an older page
    is hidden until that page loads.
  - **For Phase 3:** the send route, the optimistic row, and a "mine" look for
    our own chip. `groupMeshCoreReactions` already labels our reaction "You".
- 2026-10-13: Phase 3 done. One send function, `MeshCoreManager.sendReaction`,
  behind `POST /api/sources/:id/meshcore/messages/:messageId/reaction` and the
  automation tapback action. Planning is pure, in
  `src/server/services/meshcoreReactionSend.ts`; target rules shared with the
  client in `reactionTargetBlocker`. Decisions made on the way:
  - `meshcoreReactionsOutboundEnabled` is per source, default **on** (maintainer).
    The default lives in `MESHCORE_REACTIONS_OUTBOUND_DEFAULT`. A settings read
    error means off. The client reads the resolved value from the status object.
  - The row is stored when the radio accepts the packet, so a failed send leaves
    nothing behind. The chip shown at once is a client-side optimistic row.
  - No retry of any kind: no echo-miss retry, no DM ack-timeout retry, and
    Resend refuses a reaction row.
  - Dedupe is one send per (target, folded emoji) from us, checked inside the
    serialized send queue against the database and the in-memory pool.
  - A message whose text is itself reaction-shaped cannot be reacted to, even
    with inbound off, so two tapback automations cannot answer each other.
  - The route needs `messages:write` on the source, as a normal send does.
  - Automation tapback on MeshCore reacts only to the triggering message, on
    the source that received it. Every refusal is a recorded skip.
  - **Known limits:** a reaction to a row stored before migration 203 uses a
    rebuilt hash and may not match on other devices; if the insert fails after
    the radio accepted the packet, a restart could allow one repeat send.
  - **For Phase 4:** Unified Messages chips, CSV columns, `isTapback` triggers.
- 2026-10-13: Phase 4 done; epic complete. Decisions made on the way:
  - **#5763's premise did not hold.** It assumed MeshCore reactions would be
    stored in the Meshtastic `emoji=1` / `replyId` shape. They use their own
    columns on `meshcore_messages` (no packet id to put in `replyId`; a target
    can be unknown and resolve later; two wire formats). So most of its audit
    rows are "MeshCore never reaches this code": per-message notifications,
    translation, the v1 message API, Meshtastic threading and MQTT publish all
    read the Meshtastic table only. The doc comments #5763 asked for at each
    `emoji`-reading site were not added, because they would be false.
  - At the edges MeshCore uses the Meshtastic vocabulary: automation fields
    `isTapback`, `emoji = 1`, `replyContext`; CSV columns `reaction` and
    `reply_to_id`; a chip in Unified Messages.
  - **Unified Messages**: the server sends page-independent refs
    (`meshcoreRowRefs`, `reactionTargetRefs`) built only from rows the viewer
    may read; the client resolves them across loaded pages. One reaction heard
    on several sources is one entry. Chips are read-only. No cross-source
    target matching. `reactionTargetHash` joined the logical identity of
    reaction rows only, so plain-row dedup keys did not change.
  - **CSV**: reactions follow the existing "Include emoji reactions" box
    (default off); `reaction` and `reply_to_id` appended; MeshCore
    `message_id` is now the row id (maintainer approved).
  - **Automation trigger**: opt-in per rule with `includeMeshCoreReactions`;
    absent means today's behaviour. No built-in cooldown (maintainer chose a
    warning only). Own reactions are dropped by key, `'local'`, `selfOrigin`,
    or own node name on a channel. A tapback action on a reaction trigger is a
    recorded skip, so reaction-for-reaction loops are closed; a
    message-for-reaction loop with a foreign auto-reactor is not, hence the
    warning.
  - **Left open:** resolution is per source; the 16-bit meshcore-open hash can
    mismatch; no un-react; no sending from Unified; the MT-MC bridge template
    does not relay MeshCore reactions; rooms take no reactions; rows from
    before migration 203 use a rebuilt hash. Separate gap found, not fixed
    here: a plain channel message from one of our own sources, heard by
    another on the companion path, is not flagged `selfOrigin`.
