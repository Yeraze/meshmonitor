# Spec #6308: file slot-decrypted MeshCore MQTT ingest rows under a keyed index

## Maintainer decisions (2026-11-10, binding)
Q1: A — unrecoverable legacy rows keep channel-N with the unresolved sentinel fingerprint (admin-only). Q2: A — the shared gate always grants the Public channel fingerprint to signed-in users (source messages:read still required) on every MeshCore source; the Packet Monitor anonymous rule is unchanged. Q3: A — notification prefs for slot N fan out to the re-filed keyed channels plus every secret currently at slot N on a MeshCore source; originals kept; mutes merged. Release notes: numeric channel filters in automations are not rewritten (use name filters); channel_N grants on MQTT feeds no longer gate anything; the feed now key-gates channel messages. Migration: take the next free number at implementation time (228 expected).


Part of the parity epic (`docs/internal/dev-notes/MESHCORE_PARITY_EPIC.md`, #6226). Base is `origin/main` `4d23f62a3` (v4.17.3-rc4 + #6317). Paths are relative to `src/` unless they start with `docs/`. Next free migration is **228** (the last one is `227_add_meshcore_node_security_flags`, `db/migrations.ts:3659`, and no open PR claims 228).

## Binding decisions carried in
1. **One implementation for all sources.** The MQTT path must use the same keyed-filing rule as the Repeater RAW and Companion OTA paths. A MeshCore-only branch needs a stated reason.
2. **The P11 key-access gate applies unchanged** (`utils/meshcoreKeyAccess.ts`). This phase adds rows to it. It does not change how it works, except for the Public-channel rule if Q2 = A.
3. **P17 Q4** accepted the slot ambiguity for now and filed this issue. The P17 picker rule is still binding: offer channels this source has messages on, plus the keyed channels the viewer can read.

## Findings

1. **The MQTT path is the only one that writes un-keyed slot rows.**
   - `meshcoreMqttManager.ts:813-845` `decryptGroupText`:
     - A virtual key (`key.channelIdx === null`) files under `keyedChannelIndex(secret)` with a fingerprint (`:827-836`).
     - Any device key files as `channelIdx: res.key.channelIdx`, `keyFingerprint: null` (`:837-844`).
   - The row is built at `:681-702`: `fromPublicKey: channel-${plain.channelIdx}` (`:688`). The fingerprint is set only for virtual keys (`:701`). `keySourceId` and `keyChannelIdx` are never set.
   - The reaction lookup uses the same index (`:727`).
   - The key comes from `decryptGroupTextFrame` (`services/meshcoreFrameIngest.ts:209-229`). That function tries every `channels` row on every source plus the MeshCore virtual keys (`findChannelKeysByHash`, `:146-182`), and the first key that passes the MAC wins.
   - Result: slot N of every source collapses into `channel-N` on the MQTT source, with no provenance stored.
2. **The Repeater and Companion OTA paths already do the right thing. Only the MQTT path is broken.**
   - `meshcoreManager.ts:5330-5446` `storeDecryptedGroupText`, used by `ingestRepeaterGroupText` (`:5238`) and `ingestCompanionGroupText` (`:5272`), always:
     - files under `keyedChannelIndex(secret)` (`:5343`);
     - stamps `keySourceId`, `keyChannelIdx` and `keyFingerprint` (`:5364-5366`, `:5413-5415`).
   - The Companion skips frames whose hash it already holds in a slot of its own (`:5280`, `:5306-5312`). Its own slot rows correctly stay `channel-<slot>`, because they are its own channels.
   - So the fix is to make MQTT match the existing shared rule. The Repeater code does not change, apart from calling the extracted helper.
3. **Slot rows on an MQTT source are not key-gated. This is a real read leak, not just a cosmetic merge.**
   - `meshcoreKeyAccess.ts:24-25` says so directly: "Rows WITHOUT a fingerprint (… every MQTT row) are unaffected". `canSeeKeyedMessage` passes any row with no fingerprint (`:105-112`). The repo gate `withKeyAccess` does the same (`db/repositories/meshcore.ts:2386-2393`).
   - So anyone with `messages:read` on the MQTT source (including the anonymous user, if granted) reads plaintext decrypted with a key held on a Companion they cannot read.
   - Affected read paths: `/ingest/messages` (`routes/meshcoreIngestReadRoutes.ts:144-172`), the unified feed and search (`utils/messageSourceAccess.ts` `resolveReadableMeshcoreScope`), v1 API, socket `meshcore:message` (`services/socketEventGates.ts:225-245` only checks the key when a fingerprint is present), notifications (`meshcoreMessageNotifier.ts` passes `keyFingerprint: msg.keyFingerprint ?? null`), and translation.
   - The same frame in the Packet Monitor decode modal IS gated per key (`utils/meshcorePacketPlaintext.ts:1-17`). The two surfaces disagree today.
4. **Stored rows do not record which key decrypted them, but the key can be recovered exactly in most cases.**
   - Rows keep only `channel-<slot>`.
   - The raw frame is not on the message row. `meshcore_packet_log.rawHex` exists, but persisting it is opt-in (`meshcorePacketLogService.isEnabled()`, `meshcoreMqttManager.ts:509-536`) and it is pruned by retention. It is not a reliable source.
   - **The id encodes the channel hash.**
     - `channelMessageId` = `frameChannelMessageId('mqtt', sourceId, group.channelHash, plain.timestampSec, plain.text)` (`meshcoreMqttManager.ts:194-201`), which is `mqtt_<src>_` + SHA-256(`hash\0ts\0text`)[0..24] (`meshcoreFrameIngest.ts:351-363`).
     - The format has not changed since Phase 4 (`69222a98e`).
     - The channel hash is SHA-256(secret)[0], so it equals `channelKeyFingerprint(secret).slice(0,2)` (`meshcoreFrameIngest.ts:55-64`).
   - **Inputs needed to recompute the id:**
     - `ts`: one of `senderTimestamp` (`meshcoreWireSecond`, `utils/meshcoreReactionTarget.ts:27-32`), `timestamp/1000` when `timestamp % 1000 === 0` (for rows from before `senderTimestamp` existed), or `0` (a clock-less sender, whose `timestamp` is the ingest time).
     - `text`: the row's `text`, or for a reaction row, `reactionRawText`. That field equals `plain.text` when a sender name is present (`services/meshcoreReactionIngest.ts:218`, `meshcoreMqttManager.ts:722`).
   - **Recovery procedure:** for the row's slot N, test the hash of each stored secret at slot N. A match proves the frame's hash byte. If exactly one distinct secret at slot N has that hash, the row can be re-filed exactly.
   - **Rows that cannot be recovered:**
     - two different secrets with the same hash byte in slot N (about 1/256 per pair);
     - the key was deleted or moved;
     - a reaction with no sender name (`mc1ChannelBody` stripped the text).
   - The id itself never needs to change. Translations (`message_translations`, keyed by message id) and reactions (`reactionTargetId`) stay linked.
5. **The ingest Channels tab never shows a channel at all.**
   - `components/MeshCore/MeshCoreIngestView.tsx:342` renders `#${m.channelIdx}`.
   - `IngestMessage.channelIdx` (`:69`) is never set, because `getRecentMessages` returns raw rows (`db/repositories/meshcore.ts:~2035`) and the route does not derive it. The channel column is always blank.
6. **The P17 picker depends on the old behaviour.**
   - `/ingest/channels` (`meshcoreIngestReadRoutes.ts:184-218`) merges two lists:
     - un-keyed slot ids from `getChannelIndicesWithMessages` (`db/repositories/meshcore.ts:2103-2124`, `isNull(keyFingerprint)`);
     - `listKeyedChannelsForViewer` (`utils/meshcoreKeyedChannels.ts:110-123`).
   - After the fix, the slot list is empty for new traffic. Keyed entries need `messages:read` on the MQTT source plus key access.
   - `/api/channels/all` for `meshcore_mqtt` (`routes/channelRoutes.ts:~182-200`) also appends keyed entries. That endpoint feeds the UsersTab `channel_N` grant editor (`components/UsersTab.tsx:239`). Any entry with id < 1000 there would create a phantom grant row.
7. **Per-channel state keyed by index on an MQTT source:**
   - **Notification prefs:** `user_notification_preferences.enabledChannels` (JSON `number[]`) and `mutedChannels` (JSON `[{channelId, muteUntil}]`), per (user, source) (`db/repositories/notifications.ts:43,67,334-339`). They are matched by `channelId` (`utils/notificationFiltering.ts:108,529`). These must migrate.
   - **Read markers:** `conversation_read_state` (kind `meshcore_channel`, key `<idx>`). The ingest view does not write them today (only device views use `meshcoreUnreadStore`), so rows are unlikely, but cheap to carry over.
   - **Channel remap repo:** `MeshCoreChannelRemapRepository` (`db/repositories/meshcoreChannelRemap.ts:1-24`) rewrites messages, channels, read state, permissions and settings on a reorder. It does **not** touch notification prefs. That is a separate existing gap for #5379 on Companions.
   - **Automations:** global. `trigger.message` numeric `params.channel` (`services/automation/triggerContext.ts:~1022`) matched `channel-N` on MQTT. It will stop matching re-filed traffic, and it cannot be rewritten per source.
     - Name filters never worked on MQTT channel traffic. `meshNodeData.getChannelName` (`services/automation/meshNodeData.ts:90-100`) calls `channels.getChannelById(idx, mqttSource)`, which returns null, and then `virtualChannelName` returns null for MeshCore sources (`:31-41`).
     - The same bug hits Repeater keyed indices.
   - **Permissions:** `channel_N` grants scoped to an MQTT source granted slot N of every source at once. Keyed indices (≥ 1000) have no `channel_N` resource, so they need `messages:read` on the source (`routes/meshcoreRouteShared.ts:488-499`) AND key access.
   - **Reactions:** in-memory pending matching compares channel index (`meshcoreReactionIngest.ts` `rowIdx === channelIdx`). It stays consistent as long as the reaction and its target are re-filed together.
   - **Per-channel notification sounds:** `ChannelSoundPicker` stores them in localStorage only. They cannot be migrated on the server.
   - **No impact:** the auto-ack, announce and timer settings (`MESHCORE_CHANNEL_INDEX_SETTING_KEYS`) do not apply, because an MQTT source cannot transmit. The message filters (`meshcoreFilters`) are name-based.
8. **Notification channel names already work for keyed indices** through `resolveMeshCoreChannelName` (`utils/meshcoreKeyedChannels.ts:132-145`, P17 S3). Notifications are key-gated per recipient through `keyFingerprint`.

## Design (shared pieces first)

**S1. One shared filing rule (`services/meshcoreFrameIngest.ts`).**
- Add `keyedFilingFor(key: ChannelKeyCandidate): { channelIdx; keyFingerprint; keySourceId; keyChannelIdx }`. It returns `keyedChannelIndex(secret)`, `channelKeyFingerprint(secret)`, `key.sourceId` and `key.channelIdx`.
- `MeshCoreManager.storeDecryptedGroupText` uses it (replacing `:5342-5343`, `:5364-5366`). No behaviour change there.
- `MeshCoreMqttManager.decryptGroupText` returns `{...base, ...keyedFilingFor(res.key)}` for every key and deletes the slot branch.
- The row (`:681-702`) always sets `keySourceId`, `keyChannelIdx` and `keyFingerprint`. Reactions use the keyed `channelIdx`.
- The MQTT id formula is unchanged (`channelMessageId` on `group.channelHash`). New copies of a frame then dedupe against re-filed history, and ids stay stable.
- Why not merge the whole store pipeline: the MQTT and device store paths differ in block-hit dedupe, ring buffer, `afterMessageStored`, `selfOrigin`, stats and hop/route fields. Merging them is a refactor, not this fix (see Out of scope).
- Add `MESHCORE_UNRESOLVED_KEY_FINGERPRINT = 'unresolved'`. It is not hex, so it never collides with a real fingerprint, and it fits the MySQL `varchar(32)` column.
  - `resolveMeshcoreKeyAccess` never emits it, so the existing gate shows such rows to admins only. This matches the documented rule "deleting the key everywhere hides the rows from non-admins".
  - It needs no new code in any read path.

**S2. Public-channel rule in the shared gate (only if Q2 = A; `utils/meshcoreKeyAccess.ts`).**
- `resolveMeshcoreKeyAccess` always adds the fingerprint of `MESHCORE_PUBLIC_CHANNEL_SECRET` (`utils/meshcoreGroupEcho.ts:53`) for every non-null user. The per-source `messages:read` check still applies.
- This applies to every MeshCore source (Repeater, Companion OTA and MQTT), because there is one gate.
- The Packet Monitor's "anonymous never gets plaintext" rule (`meshcorePacketPlaintext.ts`) is unchanged.

**S3. Read surfaces.**
- `GET /ingest/messages` maps each row to `channelIdx` (`meshcoreChannelIndexOf`, `utils/meshcoreMessageMerge.ts:114`) and `channelName`:
  - the name from `keyedChannelNames(sourceId)`, attached only to rows that already passed the gate;
  - `legacy: true` when the fingerprint is the sentinel.
  - This fixes Finding 5.
- `GET /ingest/channels` drops the `getChannelIndicesWithMessages` branch and returns `listKeyedChannelsForViewer` only. Entries with id < `MESHCORE_KEYED_CHANNEL_BASE` are unresolved legacy slots (admins only, from the sentinel) and carry `legacy: true`.
- Delete `getChannelIndicesWithMessages` and `db/repositories/meshcore.channelIndices.multiBackend.test.ts` (dead code).
- `/api/channels/all` keyed append (`channelRoutes.ts`) skips `!isKeyedChannelIndex(k.id)`, so UsersTab never shows a phantom `channel_N` row for an MQTT source.

**S4. Automation channel names (shared, also fixes the Repeater).**
- In `meshNodeData.getChannelName`, when the source is any MeshCore type and `isKeyedChannelIndex(idx)`, return `keyedChannelNames(sourceId).get(idx) ?? null`. A helper exported from `meshcoreKeyedChannels.ts` keeps one lookup.
- Name filters then work on MQTT and Repeater keyed channels. Numeric `channel` filters are not rewritten (see the migration notes).

**S5. UI (shared components, no copies).**
- `MeshCoreIngestView` Channels tab shows `channelName`, falling back to `t('meshcore.ingest.channel_unnamed', 'Channel {{id}}')`. A legacy row gets a muted "(older, key unknown)" tag. Styling uses CSS-module tokens only.
- `NotificationsTab` labels `legacy` entries "Channel N (older messages)". Saved ids missing from the list are still kept (P17 behaviour).
- New i18n keys go in `public/locales/en.json` only.

## Migration plan: 228 `refile_meshcore_mqtt_slot_channels`

**File:** `server/migrations/228_refile_meshcore_mqtt_slot_channels.ts`.
- Pattern of migration 186: exported pure planners plus three runners (`migration.up`, `runMigration228Postgres`, `runMigration228Mysql`).
- Registered in `db/migrations.ts` with `settingsKey: 'migration_228_refile_meshcore_mqtt_slot_channels'`.
- No schema change, so there are no new tables and nothing to classify for backup.
- Self-contained: inline copies of `pskToHex` and the fingerprint/index math using `node:crypto`. A test pins them to the live functions, so later code changes cannot alter the migration.
- Raw SQL is allowed in migrations. Columns:
  - `meshcore_messages`, `channels` and `sources` are camelCase on all three backends.
  - `user_notification_preferences` and `conversation_read_state` are snake_case on SQLite (`enabled_channels`, `muted_channels`, `user_id`, `source_id`, `conversation_kind`, `conversation_key`, `last_read_at`) and camelCase on PG/MySQL.

**Steps (same on each backend):**
1. `mqtt = SELECT id FROM sources WHERE type='meshcore_mqtt'`. If empty, stop.
2. **Load keys.** `SELECT c.id, c."sourceId", c.psk, s.type FROM channels c LEFT JOIN sources s ON s.id = c."sourceId"` (all rows, like runtime `findChannelKeysByHash`). Build `bySlot: Map<slot, {fp, hash = fp[0..2], sourceId, isMeshCore}[]>` with distinct fingerprints per slot. Sort deterministically: MeshCore sources first, then by `sourceId`.
3. **Re-file, per MQTT source.** Keyset-page 1000 rows at a time: `WHERE "sourceId"=? AND "messageType"='channel' AND "keyFingerprint" IS NULL AND "fromPublicKey" LIKE 'channel-%' AND id > ? ORDER BY id` (served by `idx_meshcore_messages_source_id`).
   - For each row, run `planRefile(row, bySlot)`:
     - parse N;
     - for each distinct hash among `bySlot[N]`, each ts candidate {senderTimestamp, timestamp/1000 when whole, 0} and each text candidate {text, reactionRawText}, compare `mqtt_${src}_${sha256(h\0ts\0text)[0..24]}` with `row.id`;
     - on a match with exactly one distinct secret for that hash, the target is `{fromPublicKey: channel-${1000+parseInt(fp[0..4],16)}, keyFingerprint: fp, keySourceId, keyChannelIdx: N}`;
     - otherwise the target is `{keyFingerprint: 'unresolved'}` with `fromPublicKey` unchanged.
   - Strict slot-N matching keeps the result exact. A key that moved slot counts as unresolved: a guess could put a row behind the wrong gate.
   - Apply grouped `UPDATE … WHERE "sourceId"=? AND "keyFingerprint" IS NULL AND id IN (…)` statements, in chunks of 500, one transaction per page.
4. **Fan out prefs, derived from DB state so a crash between steps is safe.**
   - `mapping(src, N)` is the union of:
     - `SELECT DISTINCT "keyChannelIdx", "fromPublicKey" FROM meshcore_messages WHERE "sourceId"=src AND "keyFingerprint" IS NOT NULL AND "keyFingerprint" <> 'unresolved' AND "keyChannelIdx" IS NOT NULL` (keyed targets actually seen for slot N);
     - when Q3 = A, the keyed index of every secret currently at slot N on a `meshcore` source.
   - `planPrefFanOut`, for each `user_notification_preferences` row with `sourceId ∈ mqtt`:
     - `enabledChannels` becomes the old list plus `mapping(n)` for every n < 1000 in it;
     - `mutedChannels` gets `{...rule, channelId: k}` for each k, merged by `channelId` with the later `muteUntil` winning (null = indefinite), reusing 186's `mergeMuteRules` semantics;
     - original entries are kept;
     - UPDATE only when changed.
5. **Read markers.** For `conversation_read_state` rows (kind `meshcore_channel`, MQTT source, numeric key < 1000), insert `(user, source, kind, String(k), lastReadAt)` for each k if missing (select-then-insert, so it works on all backends).
6. Log the counts: re-filed, unresolved, prefs rows updated, read markers copied.

**Idempotent:**
- Step 3 only touches `keyFingerprint IS NULL` rows.
- Steps 4 and 5 are unions or insert-if-missing.
- A re-run after a crash recomputes the same mapping from stored rows plus the current `channels` table.

**What happens to existing data:**
- Recoverable rows keep their id, get a keyed index and become key-gated.
- Unrecoverable rows stay at `channel-N` but become admin-only (Q1 = A).
- Prefs gain the keyed ids and keep the old ones (they are inert apart from the admin-only legacy rows).
- `channel_N` grants on MQTT sources are left in place. They gate nothing new. Mention this in the release notes.
- Automations with numeric `channel` filters are not rewritten (they are global). Release-note it and point users to name filters (S4).
- A restore of a pre-228 backup into an install that already ran 228 leaves those legacy rows un-keyed, which is the same exposure as today. Accepted (see Out of scope).

## Mesh impact
None. This is pure RX and storage. Nothing transmits, and broker subscriptions are unchanged.

## Security and permissions
- **Closes Finding 3.** Every MQTT channel row carries a fingerprint, so `/ingest/messages`, the unified feed and search, v1, socket events, translation and notifications all apply `resolveMeshcoreKeyAccess` through the existing code. This is now the same rule as the Packet Monitor decode modal.
- **Reads of keyed indices** need `messages:read` on the MQTT source (no `channel_N` resource exists above 7) AND read access to a channel holding the secret on some source (`channel_N:read` or `messages:read` there, or a virtual-channel `canRead`).
  - Users with only `channel_N:read` on an MQTT source lose that merged view. This is intended: such a grant meant slot N of every source.
- **Unresolved legacy rows are admin-only** through the sentinel.
- **Channel names** go only to viewers who passed the gate for that entry (`listKeyedChannelsForViewer`, and per-message names only after `filterKeyedMessages`). Secrets never leave the server.
- **Anonymous:** `optionalAuth` anonymous users are evaluated against their own grants as today. With Q2 = A they still see Public traffic if granted `messages:read` on the feed. Without it they see nothing keyed.

## Work packages

**WP1: shared filing and MQTT ingest.**
- Files: `server/services/meshcoreFrameIngest.ts` (`keyedFilingFor`, sentinel constant), `server/meshcoreMqttManager.ts` (`decryptGroupText`, row fields, doc comments), `server/meshcoreManager.ts` (use the helper), `server/utils/meshcoreKeyAccess.ts` (doc fix; Public rule if Q2 = A).
- Tests:
  - `meshcoreFrameIngest.test.ts`: helper output, and `fingerprint.slice(0,2) === ChannelCrypto.calculateChannelHash`.
  - `meshcoreMqttManager.channelIngest.test.ts`:
    - a slot key gives a keyed row with all three provenance fields;
    - the same secret on two sources gives one index;
    - two secrets in the same slot on two sources give two indices;
    - the id formula is unchanged;
    - the emitted event carries `keyFingerprint`;
    - a reaction resolves inside the keyed channel.
  - `meshcoreKeyAccess` test: the sentinel is never granted; the Public rule (if A).
  - The existing Repeater tests stay green.

**WP2: read surfaces.**
- Files: `server/routes/meshcoreIngestReadRoutes.ts`, `server/routes/channelRoutes.ts`, `db/repositories/meshcore.ts` (remove `getChannelIndicesWithMessages`), `server/utils/meshcoreKeyedChannels.ts` (export a name-lookup helper).
- Tests, using the `createRouteTestApp` harness:
  - `meshcoreIngestReadRoutes.permissions.test.ts`: a viewer with `messages:read` on the MQTT source but no access to the key's Companion does NOT see the row. This is the regression test for the leak.
  - `meshcoreIngestReadRoutes.channels.test.ts`: `channelIdx`/`channelName` present; no slot branch; legacy entries admin-only.
  - `channelRoutes` test: MQTT `/api/channels/all` skips ids < 1000.
  - Delete `meshcore.channelIndices.multiBackend.test.ts`.

**WP3: automation names.**
- File: `server/services/automation/meshNodeData.ts`.
- Test: `meshNodeData.channelName.test.ts`, keyed index on MQTT and Repeater sources resolves to the key's name; a Meshtastic source is unchanged.

**WP4: migration 228.**
- Files: `server/migrations/228_refile_meshcore_mqtt_slot_channels.ts`, `db/migrations.ts`.
- Tests: `228_….test.ts` (SQLite) and `228_….pgmysql.test.ts` (private DBs via `createIsolatedPostgresDatabase` / `createIsolatedMysqlDatabase`). Cases:
  - exact re-file;
  - same-hash ambiguity gives the sentinel;
  - deleted key gives the sentinel;
  - reaction row recovered via `reactionRawText`;
  - null `senderTimestamp` with the timestamp fallback;
  - the ts = 0 case;
  - device and Repeater sources untouched;
  - re-run is a no-op;
  - prefs fan-out union and mute merge;
  - read-marker copy;
  - crash-resume (rows done, prefs not) gives the same prefs;
  - inline crypto helpers equal the live `keyedChannelIndex` / `channelKeyFingerprint` / `pskToHex`.
- Run with the PG and MySQL containers up and check `numPendingTests`.

**WP5: UI and docs.**
- Files: `components/MeshCore/MeshCoreIngestView.tsx` (+ module CSS), `components/NotificationsTab.tsx`, `public/locales/en.json`, `docs/features/meshcore-mqtt-ingest.md` ("Channel messages": per-key channels and gating), `docs/features/notifications.md` (remove the slot-number caveat), epic phase log.
- Tests: `MeshCoreIngestView.test.tsx` renders names and the legacy tag; NotificationsTab legacy label.

Order: WP1 → WP2/WP3 (parallel) → WP4 → WP5. Ship as one PR. WP1 alone would change new rows without migrating prefs.

## Open questions for the maintainer
- **Q1. Unrecoverable legacy rows** (ambiguous hash, deleted or moved key, sender-less reaction).
  - **A (recommended):** keep them at `channel-N` with the sentinel fingerprint, so only admins see them. No new read code, and this matches "key deleted everywhere hides rows from non-admins".
  - B: leave them un-keyed and readable as today (keeps the leak for old rows).
  - C: delete them.
- **Q2. MeshCore Public channel.** Its secret is published in the firmware, so gating it protects nothing. After the fix, feed-only viewers with no access to a Companion lose Public traffic.
  - **A (recommended):** the shared gate always grants the Public fingerprint, with source `messages:read` still required. This applies to every MeshCore source.
  - B: gate it like any other key.
- **Q3. Notification-pref fan-out for a saved slot N on an MQTT source.**
  - **A (recommended):** keyed channels actually re-filed from slot N, plus the keyed index of every secret now at slot N on a MeshCore source. This keeps the intent "slot N everywhere" for future traffic, and notifications stay key-gated per recipient.
  - B: re-filed targets only.
  - C: drop slot prefs and make users re-pick.

## Out of scope
- **Merging the whole MQTT and device GRP_TXT store pipeline** into one service: filter, reaction, insert and emit. Possible refactor follow-up.
- **The #5379 reorder remap does not move notification prefs.** That is an existing gap for Companions. The S1/S4 helpers make it easy to fix as a follow-up.
- **Re-decrypting ambiguous legacy rows from `meshcore_packet_log.rawHex`.** It is opt-in and retention-bound, so not worth relying on.
- **Rewriting automations** with numeric `channel` filters (global rules), and migrating localStorage per-channel sounds.
- **Re-running the re-file after a restore** of a pre-228 backup.
- **New-node alerts for feeds** and the Reticulum Notifications tab (P17 follow-ups).

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/meshcoreMqttManager.ts
- /home/yeraze/Development/meshmonitor/src/server/services/meshcoreFrameIngest.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/meshcoreIngestReadRoutes.ts
- /home/yeraze/Development/meshmonitor/src/server/utils/meshcoreKeyAccess.ts
- /home/yeraze/Development/meshmonitor/src/server/migrations/186_merge_default_row_mutes_into_source_rows.ts (pattern for the new 228)
