---
name: nodedb-warmstore-pr10705
description: Firmware PR #10705 (2.8/develop) 3-tier NodeDB + snr_q4 + protected-node cap; which parts are on-disk only vs over-the-air for a TCP observer like MeshMonitor
metadata:
  type: reference
---

Firmware PR meshtastic/firmware#10705 "Pr1 nodedb warmstore" (NomDeTom), labeled **2.8**, target **develop** only (not in any release as of 2026-06). Approved by thebentern. MeshMonitor tracking issue: Yeraze/meshmonitor#3548. Known breakage: #10746 (RP2350/W5500 hard reboot on full-DB save).

**THE LOAD-BEARING DISTINCTION (for MeshMonitor planning):** Almost everything in this PR is **on-disk `deviceonly.proto` / internal storage only**. The **over-the-air `mesh.proto` is unchanged**. A TCP-connected observer (MeshMonitor consumes `FromRadio` via PhoneAPI) sees *no* protobuf wire change to `NodeInfo`/`User`/`Data`/`MeshPacket`. MeshMonitor does NOT read the device's raw nodes.proto flash, so the on-disk restructure is invisible to it.

## 1. 3-tier store
- **Hot store**: full `NodeInfoLite`, cap `MAX_NUM_NODES`. In-RAM + persisted to nodes.proto.
- **Satellite maps** (position/telemetry/environment/status): separate maps, cap `MAX_SATELLITE_NODES` (freshest only); trimmed by `enforceSatelliteCaps`/`evictSatelliteOverCap` (these `.erase()` directly; node stays in header).
- **Warm tier** (`WarmNodeStore`, `src/mesh/WarmNodeStore.{h,cpp}`): 40-byte `WarmNodeEntry{ NodeNum num; uint32_t last_heard; uint8_t public_key[32]; }` (`static_assert sizeof==40`). Holds evicted-node identity so PKI DMs keep encrypting/decrypting. LRU by last_heard, keyed > keyless.
- Eviction chokepoint = `eraseNodeSatellites(NodeNum)`. `getOrCreateMeshNode` eviction + `demoteOldestHotNodesToWarm` (over-cap boot migration) call `warmStore.absorb()` before node leaves header; `warmStore.take()` rehydrates on re-admission; `copyPublicKey()` falls back hot->warm for PKI send/decrypt.
- Persistence: nRF52840 = raw-flash record-ring at 0xEA000 (3x4KB below LittleFS, magic "WRNG"); everywhere else `/prefs/warm.dat` (16B `WarmStoreHeader` magic "WRM1" + packed entries + crc32).

## 2. MAX_NUM_NODES (mesh-pb-constants.h) — INTERNAL CAP ONLY
- nRF52840: **150 -> 120** (confirmed). Constant name `MAX_NUM_NODES`.
- STM32WL: 10. ESP32-S3: `get_max_num_nodes()` runtime (PSRAM tiers). PORTDUINO: 250. else (generic ESP32 / nRF52840 default branch): 120.
- `WARM_NODE_COUNT`: STM32WL 0 (disabled), NRF52840_XXAA 200, ESP32-S3 2000, else 320. `MAX_SATELLITE_NODES`: ESP32-S3/portduino 250, else 40.
- These only bound the device's own DB size; not visible over the air.

## 3. snr_q4 — ON-DISK deviceonly.proto ONLY, NOT over the air
- New field `sint32 snr_q4 = 19;` in `NodeInfoLite` (deviceonly.proto, **develop branch** of protobufs). Master proto does NOT have it yet.
- Encoding: Q4 = dB * 4 (NOT *16 despite "Q4" naming — sint32 zigzag, matches RouteDiscovery). Encode `snr_q4=(int32_t)(snr*4.0f)`; decode `snr=snr_q4/4.0f`. The `float snr=4` field is KEPT in-memory but **zeroed on disk** (snr_q4 carries persisted value).
- **Over-the-air `mesh.proto` `NodeInfo` still has `float snr = 4`; `snr_q4` is absent from mesh.proto.** MeshMonitor's TCP-delivered NodeInfo is unaffected — keep reading `snr` as float.
- CAVEAT: PR left the protobufs **submodule pointer at upstream**; only the generated `.pb.h` was hand-edited. The deviceonly.proto change must still land in protobufs before merge. (NodeInfoLite also flattens UserLite into tags 14-18, moves position/device_metrics to NodeDatabase, packs via_mqtt/is_favorite/is_ignored into `uint32 bitfield=13` — all on-disk only. NodeInfoLite 105->112B; backup 2432->2468B.)

## 4. set_favorite() bool + protected-node cap
- `NodeDB::set_favorite` now returns **bool**. Returns false if node absent OR if `setProtectedFlag` refused at cap. On refusal logs `PROTECTED_CAP_WARN_FMT = "Can't %s 0x%08x: protected-node limit (%d) reached"`.
- `setProtectedFlag(node,mask,on)`: off always succeeds; on refused once `numProtectedNodes() >= MAX_NUM_NODES-2` (favorite+ignored+verified counted), keeping >=2 evictable slots. Already-protected node adding another flag always allowed.
- Admin handler `meshtastic_AdminMessage_set_favorite_node_tag` (AdminModule.cpp ~line 474): on cap refusal, **only** emits feedback when `mp.from == 0` (local/phone request) via `sendWarning(...)`. **There is NO routing ACK/NAK** distinguishing success from cap-refusal — the admin handler does not send `want_response` routing replies for the success path either; it just saves+breaks.
- `sendWarning` (AdminModule.cpp ~1709) allocates a `meshtastic_ClientNotification{level=WARNING}` and calls `service->sendClientNotification()` -> queued -> drained by `PhoneAPI::getFromRadio` as `FromRadio.clientNotification` (field 16, mesh.proto). **So a TCP client CAN observe the refusal — as a ClientNotification FromRadio message, NOT as an admin/routing ACK.**
- **CRITICAL caveat for MeshMonitor:** the warning is gated on `mp.from == 0`. A *remote* admin DM (from != 0) gets NO warning at all. Whether MeshMonitor's admin packets arrive with from==0 depends on how it injects them (local ToRadio admin vs addressed mesh packet). If MeshMonitor sends admin via ToRadio addressed to the local node, from is typically 0/local and it would receive the ClientNotification; if it routes as a normal mesh DM it would not. Verify before relying on it.

## 5. Blocked/ignored persistence
- `set_ignored_node` admin handler now uses `getOrCreateMeshNode` (creates entry for never-heard node so a block by bare ID sticks with no NodeInfo/key). Sets ignored via `setProtectedFlag` (subject to cap; warns to phone if from==0 and refused). On success erases satellites.
- Ignored nodes protected from: eviction (`getOrCreateMeshNode` oldest-eviction skips protected), `cleanupMeshDB` (keeps node even without user info if `nodeInfoLiteIsIgnored`), and warm-tier demotion migration.
- **Over-the-air NodeInfo broadcast behavior for blocked nodes is NOT changed by this PR.** Blocking already suppresses rebroadcast/relay of that node's traffic in existing firmware; this PR only changes *internal persistence* of the block flag. No new wire behavior for a TCP observer.
