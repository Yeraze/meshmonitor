# MQTT Channel Consolidation (issue: channels split by sending slot/hash)

## Problem (confirmed in live data)

For MQTT sources, the same logical channel is stored under multiple identities, so
"LongFast" fragments across the per-source **Channels tab** and (partially) the
**Unified Messages** display.

Three independent splitters, all observed in the `Official MQTT` / `Florida MQTT`
dev data:

1. **`channels` table keyed by `packet.channel`.** `recordChannelFromEnvelope`
   (`mqttIngestion.ts`) does `upsertChannel({ id: packet.channel, name }, sourceId)`.
   On MQTT, `packet.channel` is a per-sender channel **hash** (0–255), not a stable
   0–7 slot. Result: `LongFast` rows at ids `0,1,8,40`, `LoneWolf` at `5,99`, etc.
   These are the duplicate physical entries in the Channels tab.

2. **`channel_database` duplicate name rows (ingest race).**
   `findOrCreatePassiveByNameAsync` is a non-atomic find-then-create and there is **no
   unique index** on `name`. Concurrent MQTT packets for the same channel both miss the
   SELECT and both INSERT → byte-identical pairs (`Primary` id 3 & 4, `Wong` 5 & 6,
   `JAXMesh` 7 & 8, …, created in the same millisecond). Messages then split across
   `CHANNEL_DB_OFFSET+dupId` (e.g. 103 vs 104).

3. **Raw-hash fallback for messages.** `effectiveChannel` falls back to the raw
   `packet.channel` when name resolution fails at ingest, stranding messages on numeric
   hashes (`31`, `8`, `1` in the data) that never consolidate under the named channel.

The display layer (`/api/unified/channels` groups by name; `/api/unified/messages`
unions a name's channel numbers) papers over #1 and #2 but not #3, and the per-source
Channels tab shows the raw `channels` rows directly (#1).

## Canonical identity

The single source of truth for an MQTT channel is its **`channel_database` row**,
surfaced to messages and pickers as `CHANNEL_DB_OFFSET + dbId` (offset = 100):

- Decrypted packets already carry `decoded.channelDatabaseId` (key-verified — honours
  "same channel only if the key aligns").
- Name-only packets resolve via `channelId` → `findOrCreatePassiveByNameAsync`
  (case-insensitive, existing behaviour).

The slot-keyed `channels` table stays for TCP device-synced channels (real slots 0–7);
MQTT sources stop writing to it.

## Fix

### 1. `channel_database` dedup (foundational)
- Add a **unique index on `(lower(name), psk)`** — kills race dups (identical name+psk)
  while still allowing same-name/different-key rows the decryption feature needs.
- Make `findOrCreatePassiveByNameAsync` atomic: `INSERT … ON CONFLICT DO NOTHING`
  then SELECT (dialect-correct for sqlite/pg/mysql).

### 2. Stop hash-keyed `channels` writes for MQTT
- `recordChannelFromEnvelope`: remove the slot/hash-keyed `upsertChannel`. The channel
  surfaces through (a) message rows on `CHANNEL_DB_OFFSET+dbId` and (b) the virtual-channel
  path in `/api/unified/channels`. `resolveChannelDatabaseIdForMqtt` already ensures the
  `channel_database` row exists.

### 3. Migration (scoped to MQTT/bridge sources only — never touch TCP slots 0–7)
- Merge `channel_database` rows identical in `(lower(name), psk)`: keep lowest id,
  repoint `channel_database_permissions.channel_database_id` and
  `messages.channel = CHANNEL_DB_OFFSET+dup → +canonical`, delete dups. Then add the
  unique index.
- For each `sources.type IN ('mqtt_bridge','mqtt_broker')`, for each `channels` row with
  `id < CHANNEL_DB_OFFSET` and a non-empty name: resolve name→dbId, repoint
  `messages.channel = rawId → CHANNEL_DB_OFFSET+dbId` for that source (rescues the
  stranded raw-hash messages), then delete the hash `channels` row.

### 4. Front-end (Channels tab)
- With #2/#3, the per-source MQTT Channels tab builds its list from message channel
  numbers (already canonical) + `channelDatabaseEntries` for naming. Verify one entry per
  channel; adjust `getAvailableChannels`/naming only if a gap shows in verification.

## Verification
- Unit/integration: dedup race, atomic create, ingestion no longer writes hash rows,
  migration merges + repoints (SQLite first, then pg/mysql functions).
- Live: deploy dev container, confirm `Official MQTT` Channels tab shows one `LongFast`,
  and Unified Messages shows LongFast traffic under a single channel.
