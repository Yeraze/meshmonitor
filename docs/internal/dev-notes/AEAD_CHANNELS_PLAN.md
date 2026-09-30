# AEAD (AES-CCM) PSK Channels — Implementation Plan (#5248)

Status: **plan**, 2026-09-30. Protobufs submodule bumped to master `2542e06` in the PR that adds this file.

## Upstream status (verified 2026-09-30)

| Piece | Where | State |
|---|---|---|
| `ChannelSettings.use_aead = 8` | protobufs #868, `e4fbafb` | Merged to `master` 09-09. No tag (latest `v2.8.0`). In our submodule after this bump. |
| AES-CCM PSK channels | firmware #9749, `d05fbec` | Merged to `develop` (the integration branch) 09-14. Not reverted. |
| First firmware to ship it | `develop` `version.properties` = **2.8.1** | No 2.8.1 tag or prerelease yet. Newest build is `v2.8.0.47db0e3` (09-01), which predates it. |
| Upstream testing | #9749 checklist | "End-to-end AEAD path test" and "Hardware test on ESP32/nRF52" **unchecked**. |
| Open upstream PRs touching the path | firmware #9951 (big-endian nonce order), #9600 (constant-time compare), #11979 (key cache) | Watch #9951: it could change nonce bytes on big-endian hosts. |

## Wire format (firmware `develop`, `src/mesh/CryptoEngine.cpp`, `aes-ccm.cpp`, `Channels.cpp`)

- **Cipher:** RFC 3610 AES-CCM, M=12 (tag), L=2. Key = the expanded channel PSK (`AQ==` expands to the default key). 16 bytes → AES-128, 32 → AES-256.
- **Nonce (13 bytes):** `LE32(packet.id) ‖ 0x00000000 ‖ LE32(from) ‖ 0x00`. This is the CTR nonce truncated to 13 bytes.
- **AAD (8 bytes):** `LE32(from) ‖ LE32(to)`. Hop fields are excluded.
- **Payload:** `ciphertext ‖ 12-byte tag`. Every packet grows by 12 bytes; firmware rejects sends where payload + 16 + 12 > 255 (`TOO_LARGE`).
- **Channel hash:** `xorHash(name) ^ xorHash(expandedPsk) ^ 0xAE` when `use_aead` is set. The XOR is applied to the finished hash.
- **Mode choice:** hash match first, then the receiver's *own* channel flag picks CCM or CTR. Nothing else on the wire marks AEAD. **No CTR fallback**: AEAD and legacy nodes on the same name and PSK cannot talk.
- **Empty PSK:** firmware silently clears `use_aead` (`Channels.cpp:83-86`).
- **`set_channel` replaces the whole channel** (`Channels::setChannel`). A client that omits `use_aead` turns AEAD off.
- **MQTT:** no AEAD branch in `MQTT::onSend`. With MQTT encryption on, the envelope carries the on-air ciphertext and tag unchanged, `packet.channel` = the AEAD hash. With it off, the envelope carries plaintext as before.
- **Unchanged:** PKI DMs. `setDefaultPresetCryptoForHash` does not apply `0xAE`, so an AEAD LongFast is not auto-matched by the default-preset path.

## The risk to fix first

`createSetChannelMessage` (`src/server/protobufService.ts:1340`) builds `ChannelSettings` from the fields it knows. The `channels` table (`src/db/schema/channels.ts`) and the save in `meshtasticManager.ts:~6210` don't store `use_aead`. Once a node runs 2.8.1 with AEAD on, **any channel edit from MeshMonitor turns AEAD off**, and channel URL export (`channelUrlService.ts:122,200`) drops it too. Phase 1 closes this.

## Phase 1 — store and keep the flag (build now)

No firmware needed to build or test; a synthetic `ChannelSettings` with `useAead: true` exercises every path.

1. **Migration (next free number, 183 at time of writing):** `useAead` boolean, not null, default false, on `channels` (per-source). All three backends via `addColumnIfMissing*`. Update the schema's three table definitions and `DbChannel`.
2. **Read from the device:** `meshtasticManager.ts:~6133` and `~6210` store `channel.settings.useAead ?? false`.
3. **Write to the device (read-modify-write):** `createSetChannelMessage` accepts `useAead`. Every caller fills it from the stored channel row when the request omits it:
   - `adminRoutes.ts:1334` (bulk channel save / import)
   - `adminRoutes.ts:1779` (single channel edit)
   - `deviceAdminService.ts:142` (remote admin). For remote nodes MeshMonitor may have no stored row; read the channel from the node first (existing get-channel flow) rather than defaulting to `false`.
4. **Channel URLs:** `channelUrlService.ts` decodes and encodes `useAead` in the `ChannelSet`.
5. **Config export/import and device backup/restore** (`ExportConfigModal`, `ImportConfigModal`, the #4926 device-config restore): carry the field.
6. **UI, read-only:** an "AEAD" badge on the channel in `ChannelsConfigSection.tsx` and `ChannelsTab.tsx`, with a tooltip: "This channel uses AES-CCM authenticated encryption. Only nodes with the same setting can read it."
7. **Tests:** round-trip `useAead` through save → edit → `createSetChannelMessage` bytes (the edit must keep `true`); URL encode/decode; migration tests on SQLite + PG/MySQL containers.

Mesh impact: none new. One admin packet per edit, as today.

## Phase 2 — decrypt and edit (after a 2.8.1 build ships AEAD)

1. **Migration:** `useAead` on `channel_database` (global table, per CLAUDE.md exception). Backfill nothing; default false.
2. **Hash:** `computeChannelHash(name, psk, useAead)` in `channelDecryptionService.ts:73` applies `^ 0xAE`. Extend the hash lookup at `:156-167`, and add AEAD hashes to the stored-hash backfill (migration 104 pattern).
3. **Decrypt:** a CCM branch in `tryDecryptWithKey` (`:252`) using Node's `aes-128-ccm` / `aes-256-ccm`, `authTagLength: 12`, the 13-byte nonce and 8-byte AAD above. Pattern: `pkiDecryptionService.ts:123`. The tag check confirms the key, so no plausibility heuristics are needed; a tag failure is a clean miss.
4. **MQTT hint:** debug-level log only, when an encrypted packet's hash equals a known non-AEAD row's hash `^ 0xAE` ("channel X looks AEAD-enabled upstream; enable AEAD on it to decrypt"). Nothing at warn level: an AEAD packet is otherwise indistinguishable from a wrong key.
5. **Editable checkbox** in `ChannelsConfigSection.tsx` and `ChannelDatabaseSection.tsx`, labelled **Experimental**, gated on firmware ≥ 2.8.1 for the device channel, disabled when the PSK is empty. Confirm dialog on enable. Proposed warning (for maintainer sign-off):
   > **AEAD cuts this channel off from nodes that don't use it.** Nodes on older firmware, or with AEAD off, can no longer read or send on this channel, even with the same name and key. Turn it on for every node on the channel at the same time.
6. **Compose limit:** reduce the per-message byte limit by 12 on AEAD channels (confirm the exact figure against firmware `TOO_LARGE` at implementation).
7. **Tests:** known-answer vectors generated from the firmware's own test suite (or a 2.8.1 node capture), hash `^0xAE`, tag failure = miss, MQTT hint.
8. **Hardware validation:** two 2.8.1 nodes on an AEAD channel, MeshMonitor on TCP + MQTT ingest, before release.

## Decisions (maintainer, 2026-09-30)

- Bump protobufs to untagged master: **yes** (done in this PR).
- Phase 1 read-only now; Phase 2 editable, marked Experimental: **yes**.
- MQTT hint at debug level only: **yes**.
- Warning text above: **pending sign-off**.
