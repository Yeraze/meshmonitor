# Coverage Report Epic (#5277): Phase 3 Implementation Spec

**Phase:** P3: MeshCore receptions.
**Status:** Approved. User decisions U1–U4 folded into §5 (2026-09-24).
**Branch:** `feature/coverage-p3-meshcore` (from origin/main 51e25a7e, which holds P1 #5334 and P2 #5336).
**Inputs:** `COVERAGE_REPORT_EPIC.md`, `COVERAGE_P1_SPEC.md`, `COVERAGE_P2_SPEC.md`, the P1/P2 code, the MeshCore firmware source (meshcore-dev/MeshCore `main` @ `e9412598`: `Dispatcher.cpp`, `examples/companion_radio/MyMesh.cpp`, `examples/simple_repeater/MyMesh.cpp`, `src/helpers/BaseChatMesh.cpp`) and the MeshCore CLI docs (docs.meshcore.io/cli_commands).

**No schema change and no migration.** P1 built `coverage_receptions` for this phase: `protocol = 'meshcore'`, 64-hex pubkeys fit `receiverId`/`senderId` VARCHAR(80), `packetKey` holds the 16-hex packet hash, `pathKey` VARCHAR(80) holds the short MeshCore path key, and `senderNodeNum`/`receiverNodeNum`/`packetId`/`relayNode`/`hopStart`/`hopLimit`/`rxTime` stay NULL. The repository needs no change either (§2.4). **No new npm dependency** (§1, signature check).

---

## 0. Mesh impact checklist (copy into the PR body)

1. **Airtime from MeshMonitor: zero.** P3 sends nothing: no adverts, no telemetry or path requests, no config. It reads the `LogRxData` (0x88) frames the companion already pushes for every packet it hears, and the ADVERT frames an observer feed already carries. P3 adds no call to `sendAdvert()` and no scheduler.
2. **Spam: none.** No messages, notifications or automation triggers. Receptions are not emitted on `dataEventEmitter`. One DB insert per (advert, path, receiver). Nothing is sent, so there is no feedback loop and no retry.
3. **Timers: none new.** The P1 hourly retention sweep covers MeshCore rows. The replay guard (§2.2) is an in-memory LRU filter, not a timer; a restart clears it, which can at worst admit one shared advert. No save can fire anything or reset a cooldown. The observer opt-in reuses P2's `coverage_mqtt_enabled` cache and save-time invalidation unchanged.
4. **The survey itself costs airtime, and the operator pays it.** Numbers in §0.3. The guidance says zero-hop only, one advert per 60 s or slower, and never flood for a survey (U2).
5. **Risk flagged, not changed in P3:** MeshMonitor's own "Send advert" button **floods** (§0.4).

### 0.1 Which MeshCore packets carry a position

| Packet | Position? | Used in P3 |
|---|---|---|
| ADVERT (payload type 0x04) | Optional lat/lon (flag bit 0x10, int32 × 1e-6 deg), signed with the sender's key | **Yes, the only source** |
| Telemetry response (Cayenne LPP GPS) | Yes, but only as a reply to a request MeshMonitor or someone sends | No: not passive |
| Text messages with app-level "location" text | App convention, not protocol | No |
| TRACE, PATH, ACK, GRP_TXT, TXT_MSG, CONTROL | No | No |

**Caveat the UI must show (U2):** an advert carries the node's **stored advert position**, not a GPS fix taken when the packet left. A companion sends the lat/lon its phone app last pushed (`CMD_SET_ADVERT_LATLON`), and only when its advert location policy is not "none" (`companion_radio/MyMesh.cpp:1252-1256`). A repeater sends `set lat/lon` or its GPS (`gps advert share|prefs`). A stale phone location puts the dot in the wrong place.

### 0.2 How often MeshCore nodes advert by default

| Node | Zero-hop (local) advert | Flood advert | Manual |
|---|---|---|---|
| Companion (phone app) | No timer in `companion_radio` firmware; manual only | Manual only | `CMD_SEND_SELF_ADVERT` (§0.4) |
| Repeater / room server | `advert.interval` in minutes, range 60–240, docs default 0 (off). Source constant `advert_interval = 1` (×2 min); **verify on real firmware before quoting** | `flood.advert.interval` in hours: docs say 12 (repeater), current source says 47; range 3–168 | CLI `advert` (flood), `advert.zerohop` |

Repeaters forward flood adverts only up to `flood_max_advert = 8` hops (source), below the general `flood.max` (default 64).

So a **mobile survey node sends adverts only when the operator triggers one**. No MeshCore timer runs faster than 60 minutes. MeshCore coverage data will come mostly from (a) fixed repeaters' periodic adverts heard by our companion or observers, and (b) manual survey adverts. The guidance says this plainly.

### 0.3 Airtime per advert

Advert size: header 1 + path_len 1 + pubkey 32 + timestamp 4 + signature 64 + flags 1 + lat/lon 8 + name (≈0–32) ≈ **111–135 bytes**. Computed with the Semtech formula, explicit header, CRC on, preamble 16:

| Preset | 111 B | 123 B | 135 B |
|---|---|---|---|
| US/Canada 910.525 MHz, SF7 BW62.5 CR5 | 396 ms | 426 ms | 467 ms |
| EU/UK narrow, SF8 BW62.5 CR8 | 1.07 s | 1.16 s | 1.26 s |
| Legacy EU, SF11 BW250 CR5 | 1.09 s | 1.17 s | 1.26 s |

- **Zero-hop:** 1 transmission. Repeaters hear it but do not forward it.
- **Flood:** 1 + every repeater within 8 hops that hears it (each forwards once, `hasSeen` dedupe). With 20 repeaters in reach: 21 transmissions, ≈ 9 s of channel time on the US preset, ≈ 25 s on EU narrow, per advert.
- **Survey at one zero-hop advert per 60 s (U2):** 0.43 s / 60 s ≈ **0.7 %** of the local channel (US); ≈ **1.9 %** (EU narrow).
- **Flood adverts every 60 s, 20 repeaters:** ≈ 15 % (US) to 40 % (EU) of the channel. The guidance forbids it.

### 0.4 How to send a zero-hop advert (firmware-verified)

**Protocol:** `CMD_SEND_SELF_ADVERT` = 7 (`companion_radio/MyMesh.cpp:12`). The handler (`MyMesh.cpp:1250-1266`) reads an optional second byte: `if (len >= 2 && cmd_frame[1] == 1)` → `sendFloodScoped(...)` (`:1258-1262`), else `sendZeroHop(pkt)` (`:1263-1264`). The firmware comment reads `// optional param (1 = flood, 0 = zero hop)`. **Zero-hop is the firmware default when the byte is absent.** meshcore.js mirrors it: `SelfAdvertTypes = { ZeroHop: 0, Flood: 1 }` (`@liamcottle/meshcore.js/src/constants.js:129-132`), `sendZeroHopAdvert()` / `sendFloodAdvert()` (`connection.js:847-853`).

**Guidance text for the operator:**
- Companion + phone app: use the app's advert action and pick the **zero-hop** option, not flood. Tools built on meshcore.js: `sendZeroHopAdvert()`.
- Repeater as survey node: CLI `advert.zerohop` (not `advert`, which floods).
- Set the advert location to share a fresh fix before each advert.
- **Do not use MeshMonitor's "Send advert" button for a survey** (below).

**Risk (flag to the user, do not change in P3): MeshMonitor's own advert button floods.**
- UI: `MeshCoreStatusBar.tsx:58` and `MeshCoreSettingsView.tsx:376` call `actions.sendAdvert()` → `POST /api/sources/:id/meshcore/advert` (`meshcoreDeviceRoutes.ts:273-275`) → `MeshCoreManager.sendAdvert()` (`meshcoreManager.ts:4024`, comment "Adverts flood") → bridge `send_advert` → `c.sendAdvert(K.SelfAdvertTypes.Flood)` (`meshcoreNativeBackend.ts:1990-1991`). For repeater sources it runs CLI `advert` (`meshcoreManager.ts:4032`), which also floods.
- The same primitive backs the auto-announce advert burst (`meshcoreManager.ts:7515-7533`) and the automation/auto-responder `advert` action (`meshcoreManager.ts:7674-7675`, `services/automation/meshActionDeps.ts:223`).
- Cost: one flood advert with 20 repeaters in reach ≈ 9–25 s of channel time. A user who clicks it repeatedly "to test coverage" floods the mesh, and the adverts come from the fixed receiver, so they measure nothing (P3 skips our own advert anyway).
- Possible follow-ups for the user to decide: a zero-hop option on the button, a confirm stating the flood cost, or a cooldown. Out of P3 scope.

---

## 1. Reuse inventory

| Need | Reuse / extend | Why |
|---|---|---|
| Raw RX feed with SNR/RSSI | `LogRxData` handler in `meshcoreNativeBackend.ts:588-676` → bridge event `ota_packet` `{payload_type, route_type, path_len_raw, hop_count, path_hops, snr, rssi, raw_hex}` | Already parsed per packet; SNR is `int8/4` dB, RSSI int8 dBm. Firmware calls `logRxRaw` in `Dispatcher.cpp` **before** the `hasSeen` dedupe, so each relayed copy arrives separately. |
| Hook point (local) | `MeshCoreManager` `ota_packet` branch, `meshcoreManager.ts:2162-2178`, next to `void this.handleOtaPacket(data)` | Runs for every OTA packet, independent of the packet-log setting. Repeater/serial sources never emit `ota_packet` (`meshcoreManager.ts:1488`), so no type check is needed. |
| Hook point (observer) | `MeshCoreMqttManager.handleMessage`, `meshcoreMqttManager.ts:303-356`, after the origin-id cross-check, next to `void this.ingestAdvert(decoded)` | `decoded.event` is the same bridge shape; `decoded.originId` is the observer. |
| Frame + advert decode | `decodeMeshCorePacket(raw_hex)` (`src/utils/meshcorePacketDecode.ts:274`): `header.routeType`, `path.{hashSize, hopCount, hops}`, `payload.advert.{publicKey, timestamp, latitude, longitude, signature, appDataHex}` | Already used by the manager (`:2420`) and the MQTT advert ingest (`:436`). Do not re-parse. |
| Packet hash (packetKey) | `calculateMeshCorePacketHash(rawHex)` (`src/server/services/meshcoreObserverPacket.ts:281`) | Firmware `Packet::calculatePacketHash`: SHA-256 over payload type + payload, **path excluded**, 16 upper-hex. Every relayed copy of one advert shares it; the next advert (new timestamp) gets a new one. Not `djb2Hash` (`loraFrequency.ts`). Returns `'0000000000000000'` on failure: treat as skip. |
| Signature check (U3) | `Ed25519SignatureVerifier.verifyAdvertisementSignature(publicKeyHex, signatureHex, timestamp, appDataHex): Promise<boolean>`, exported from `@michaelhart/meshcore-decoder` (`dist/index.d.ts:9`) | **Already a dependency** (`package.json:46`, `^0.3.0`, already imported by `meshcoreMqttManager.ts` for `ChannelCrypto`). It uses `@noble/ed25519` internally. MeshMonitor has **no wrapper** of its own; `DecodedAdvert.appDataHex` exists for exactly this call (`meshcorePacketDecode.ts:112-124`). **No new dependency.** |
| Bogus position | `shouldDiscardPosition(lat, lon, undefined, getDiscardInvalidPositions())` (`src/utils/nullIsland.ts:144`, `src/utils/positionIngestConfig.ts`) | Same rule `meshcore.upsertNode` uses (`meshcore.ts:408`). |
| Own-key checks | `isOwnPublicKey(pubkey)` (`src/server/utils/ownNodes.ts:79`), lowercased, typed `isMeshCoreManager` inside | Self-advert skip; own-observer skip (D5). |
| Receiver position (observer) | `CoverageReceiverPositionCache` (`coverageReceiverPositionCache.ts`) with a new optional loader | TTL, failure TTL, LRU, single-flight all apply unchanged. |
| Receiver position (local) | `this.localNode.latitude/longitude` (self info, `meshcoreManager.ts:3118-3131`) | In memory, refreshed on connect; the local row is also persisted (`isLocalNode`, #3884). |
| Node rows / names | `databaseService.meshcore.getNodesBySource(sourceId)`, `getNodeByPublicKeyAndSource` (`src/db/repositories/meshcore.ts:325,357`) | Per-source, pubkey-keyed. |
| Position permission | `hasPermission(user, 'nodes', 'viewOnMap', sourceId)` (`authMiddleware.ts:586`), as `maskContactPositionsForViewOnMap` does (`meshcoreRouteShared.ts:274`) | The MeshCore map gate (#4559). MeshCore has no `hideFromMap` / private-position columns. |
| Insert + dedupe | `databaseService.coverageReceptions.recordReception` | Unchanged. First write wins per unique key. |
| Bounded cache | `LruCache` (`src/server/utils/lruCache.ts`) | Replay guard state. |
| Observer opt-in (U1) | P2's `coverage_mqtt_enabled`: `isCoverageMqttEnabled` (`coverageMqttSettings.ts`), `loadMqttSourceStatuses` (`coverageRoutes.ts:159`), `CoverageMqttRecordingSection`, `isMeshCoreMqttManager` (`sourceManagerTypes.ts:60`) | Same per-source toggle, cache, status row and confirm-on-enable. |
| Receiver filter wire format | `src/utils/coverageReceiverFilter.ts` | `RECEIVER_ID_RE` already fits 64-hex. Needs a length cap (§2.5). |
| Tests | `meshcoreManager.otaPacket.test.ts` (mock shape), `meshcoreMqttManager.advert.test.ts`, `coverageMqtt.test.ts`, `mqttIngestion.coverage*.test.ts`, `coverageRoutes.test.ts` (harness), `meshcoreViewOnMap.permissions.test.ts`, `CoverageMqttRecordingSection.test.tsx` | Copy or extend. |

**New things, and why:**
- `src/server/utils/coverageMeshCore.ts`: pure evaluator + replay guard + the async record function, shared by the companion and observer hooks. Mirrors `coverageMqtt.ts`.
- Helpers in `src/utils/coverage.ts` (WP0).
- `buildMeshCorePositionFilter` in `positionVisibility.ts`: the MeshCore twin of `buildPositionFilter`.

---

## 2. File-by-file changes

### 2.1 WP0: shared helpers in `src/utils/coverage.ts` (+ `coverage.test.ts`)

See §4 WP0 for the exact code the orchestrator commits.

- **Why last hop + hop count, not the full path:** the SNR is the last link's, the same idea as Meshtastic's `relayNode`. A full path can pass 80 chars (64 hops × 3-byte hashes). Two routes that end on the same repeater at the same depth collapse to one row, which is the same physical link.
- `isCoverageMqttSourceType` is a named helper, like P2's `isMqttOnlySourceType`. Do **not** widen `isMqttOnlySourceType`, which drives transport filters.

### 2.2 Recording: `src/server/utils/coverageMeshCore.ts` (new)

**Pure evaluator:**
```ts
export type MeshCoreCoverageSkip =
  | 'not-advert' | 'no-receiver' | 'decode-failed' | 'no-position' | 'bogus-position'
  | 'own-advert' | 'own-observer' | 'no-signal' | 'no-hash' | 'stale' | 'replay';
// 'bad-signature' is added by the async record function (the check is async).

export function evaluateMeshCoreCoverageReception(input: {
  sourceId: string;
  receiverKind: 'local' | 'mqtt_gateway';
  receiverPubKey: string | null;          // lowercased by the caller
  event: { payload_type?: number; route_type?: number; snr?: number | null; rssi?: number | null; raw_hex?: string | null };
  observerTimestampMs?: number | null;    // observer feed only (D4)
  nowMs: number;
  isOwnPublicKey: (k: string) => boolean;
  discardNullIsland: boolean;
}): { skip: MeshCoreCoverageSkip } | { skip: null; advert: DecodedAdvert; row: MeshCoreCoverageRow }
```

Skip rules, in order (each tested):
1. `event.payload_type !== MESHCORE_PAYLOAD_ADVERT` → `not-advert`. **Sync, before any decode.** Every non-advert packet costs one integer compare.
2. `receiverPubKey` empty or `!isMeshCorePubKeyId` (e.g. the repeater placeholder `'repeater'`) → `no-receiver`.
3. `decodeMeshCorePacket(raw_hex)` null or no `payload.advert` → `decode-failed`.
4. Advert has no latitude/longitude → `no-position`.
5. `shouldDiscardPosition(lat, lon, undefined, discardNullIsland)` → `bogus-position`.
6. `sender = advert.publicKey.toLowerCase()`. `sender === receiverPubKey` → `own-advert` (our own advert relayed back).
7. Observer only: `isOwnPublicKey(receiverPubKey)` → `own-observer` (D5).
8. `snr == null && rssi == null` → `no-signal`.
9. `packetKey = calculateMeshCorePacketHash(raw_hex)`; the sentinel `'0000000000000000'` → `no-hash`.
10. Observer only: `observerTimestampMs` present and `nowMs - observerTimestampMs > COVERAGE_MAX_RX_AGE_SEC * 1000` → `stale` (D4).

The replay guard is **not** in the pure evaluator: it has state and must run only after the signature passes, so a forged advert can never poison the guard (see the record order below).

Row values:
- `protocol: 'meshcore'`, `receiverKind` from input, `receiverId: receiverPubKey`, `receiverNodeNum: null`.
- `senderId: sender`, `senderNodeNum: null`, `packetKey`, `packetId: null`.
- `hopsAway = computeMeshCoreHopsAway(header.routeType, path.hopCount)`; `pathKey = meshcorePathKey(hopsAway, path.hops.at(-1) ?? null)`. For a flood copy the last entry is the last relay's hash.
- `snr`, `rssi` as given (0 is real).
- `hopStart`, `hopLimit`, `relayNode`, `transportMechanism`, `channel`, `rxTime`: null. Do **not** put the advert timestamp in `rxTime`: that column is the receiver's clock, and advert timestamps are the sender's (and often wrong: the dev DB holds MeshCore `lastHeard` values from 1994 to 2103).
- `precisionBits: null`, `altitude: null`.

**Replay guard (D3):**
```ts
export class MeshCoreReplayGuard {
  constructor(opts?: { maxEntries?: number /* 10_000 */; pathWindowMs?: number /* 60_000 */; ttlMs?: number /* 3_600_000 */ });
  check(key: string /* `${sourceId}|${receiverId}|${senderId}` */, advertTs: number, packetKey: string, nowMs: number): boolean;
}
```
- State per key: `{ maxTs, packetKey, firstSeenMs, updatedMs }` in an `LruCache`.
- No entry, or entry older than `ttlMs` → accept, store.
- `advertTs > maxTs` → accept, store the new advert.
- `advertTs === maxTs && packetKey === entry.packetKey && nowMs - firstSeenMs <= pathWindowMs` → accept (another relayed copy of the same advert).
- Else → reject. This catches a **shared contact**: `shareContactZeroHop` re-sends the stored advert bytes zero-hop from a third node (`BaseChatMesh.cpp`), which looks like a direct reception from the original sender with the sharer's SNR. Same rule as firmware's `timestamp <= last_advert_timestamp` → "possible replay".
- The TTL lets a node whose clock jumped back (reboot without time sync) recover within an hour.
- Residual: a share of an advert this receiver has not heard in the last hour records as a zero-hop reception. Document it next to the guard.

**Async record function:**
```ts
export async function maybeRecordMeshCoreCoverageReception(input: {
  sourceId: string; receiverKind: 'local' | 'mqtt_gateway'; receiverPubKey: string | null;
  receiverPosition: () => Promise<ReceiverPos>;   // local: localNode lat/lon; observer: shared cache
  event: MeshCoreBridgeOtaPacketLike; observerTimestampMs?: number | null;
}): Promise<void>
```
- `try/catch`-wrapped; never throws; logs at debug.
- Order: payload-type check (sync) → evaluator → **signature (U3)**: `await Ed25519SignatureVerifier.verifyAdvertisementSignature(advert.publicKey, advert.signature, advert.timestamp, advert.appDataHex ?? '')`; false or throw → skip `bad-signature` → replay guard → `receiverPosition()` → `recordReception({ ...row, receiverLatitude, receiverLongitude, latitude, longitude, receivedAt: Date.now() })`.
- Import `Ed25519SignatureVerifier` from `@michaelhart/meshcore-decoder` (a named export, like `ChannelCrypto` in `meshcoreMqttManager.ts`). **Golden-test with a real advert fixture first:** the library's `.d.ts` comments disagree on whether the pubkey is part of the signed message (firmware `Mesh.cpp` signs pubkey + timestamp + appData). If the fixture fails, stop and report; do not hand-roll a verifier.
- Module-level `MeshCoreReplayGuard` and module-level observer position cache; `__resetCoverageMeshCoreForTest()`.
- Receiver position also passes through `shouldDiscardPosition`; a 0,0 self-info position becomes null.
- **No `dataEventEmitter` emit.**

### 2.3 Hooks

**`src/server/meshcoreManager.ts`**, `ota_packet` branch (`:2162`), after `void this.handleOtaPacket(data)`:
```ts
if (data?.payload_type === MESHCORE_PAYLOAD_ADVERT) {
  void maybeRecordMeshCoreCoverageReception({
    sourceId: this.sourceId, receiverKind: 'local',
    receiverPubKey: this.localNode?.publicKey?.toLowerCase() ?? null,
    receiverPosition: async () => ({ lat: this.localNode?.latitude ?? null, lon: this.localNode?.longitude ?? null }),
    event: data,
  });
}
```
- Always on (epic: radio sources record always). Fits MeshCore: only signed, positioned adverts reach the table.
- Independent of `meshcore_packet_log_enabled`. Receive-only mode does not matter.
- Not reached for repeater/serial sources (no `ota_packet`). Say so in a comment; add no type check.

**`src/server/meshcoreMqttManager.ts`**, in `handleMessage` after `void this.ingestAdvert(decoded)`:
```ts
if (decoded.event.payload_type === MESHCORE_PAYLOAD_ADVERT) void this.recordCoverage(decoded);
```
- `recordCoverage`: `if (!(await isCoverageMqttEnabled(this.sourceId))) return;` then `maybeRecordMeshCoreCoverageReception({ receiverKind: 'mqtt_gateway', receiverPubKey: decoded.originId.toLowerCase(), receiverPosition: () => observerPosCache.get(this.sourceId, originIdLower), observerTimestampMs: Date.parse(decoded.timestamp ?? '') || null, event: decoded.event })`.
- Opt-in, default off (U1). The advert check runs before the flag read, so the flag cache sees only adverts.
- The observer's position comes from this source's `meshcore_nodes` row for its pubkey (written by `ingestAdvert` when the feed carries the observer's own advert). Observers without one get no marker, like P2 gateways lacking a NodeInfo.

**`src/server/utils/coverageReceiverPositionCache.ts`**: add an optional constructor `loader?: (sourceId: string, key: string) => Promise<ReceiverPos>` and widen `get(sourceId, key: number | string)`. The default loader keeps today's `nodes.getNode(Number(key), sourceId)` path. The MeshCore loader: `meshcore.getNodeByPublicKeyAndSource(key, sourceId)` → `{lat, lon}` through `shouldDiscardPosition`. Existing tests stay green unchanged.

### 2.4 Repository

No change. `getReceptions`, `getReceivers`, `getSenderSummary`, `purgeOlderThan`, `deleteForSource` are protocol-blind and key on `(sourceId, receiverId, senderId, packetKey, pathKey)`. `receiverNodeNum` null groups correctly in `getReceivers`. Add one multiBackend case that round-trips a 64-hex MeshCore row on PG/MySQL.

### 2.5 Routes and privacy: `coverageRoutes.ts`, `positionVisibility.ts`, `coverageReceiverFilter.ts`

**Why this is mandatory:** today `/senders` and `/receptions` keep any row with `senderNodeNum == null` ("can't be gated, always kept", `coverageRoutes.ts:307-313, 447`). Every MeshCore row has a null `senderNodeNum`, so without WP2, MeshCore rows would bypass `viewOnMap`. WP1 and WP2 land in the same PR (one PR per phase).

`src/server/utils/positionVisibility.ts`, add:
```ts
export async function loadMeshCoreNodesBySource(sourceIds: string[]): Promise<Map<string, DbMeshCoreNode[]>>
export interface MeshCoreVisibilityRow { sourceId: string; publicKey: string }
export async function buildMeshCorePositionFilter(user: any, sourceIds: string[], mcNodesBySource?: Map<string, DbMeshCoreNode[]>): Promise<(row: MeshCoreVisibilityRow) => boolean>
```
- **Presence (display gate, everyone, admins too):** `(sourceId, publicKey)` must have a `meshcore_nodes` row (lowercase compare). Mirrors the #4163 orphan rule.
- **Permission (non-admins):** `hasPermission(user, 'nodes', 'viewOnMap', sourceId)`, computed once per source. Anonymous (`user` null) → false, like `maskContactPositionsForViewOnMap`.
- MeshCore has no `hideFromMap` or private-position columns. If those land later, add them here.

`coverageRoutes.ts`:
- One helper `isVisible(row)` branching on the **row's** `protocol` via `isMeshCoreReceptionRow` (WP0; row data, not a source-type string gate): MeshCore → MeshCore filter on `senderId` / `receiverId`; else the P1 filter on node numbers. The "null nodeNum is always kept" carve-out stays for Meshtastic rows only.
- Load MeshCore nodes only for sources that have MeshCore rows in the result.
- `/receptions`: drop MeshCore rows whose sender fails; null receiver coordinates when the receiver fails.
- `/receivers`: MeshCore rows take `longName = meshcore_nodes.name`, `shortName = null`, position = node row lat/lon else the snapshot; null both when the gate fails.
- `/senders`: MeshCore names from `meshcore_nodes`; drop failed senders before the merge.
- `parseSenderParam`: also accept a 64-hex pubkey, lowercased. Update the `INVALID_SENDER` message.
- Hops: widen validation from 0–7 to 0–63. Meshtastic rows never exceed 7.
- `loadMqttSourceStatuses`: discover with `m => isMqttConnectionStatusManager(m) || isMeshCoreMqttManager(m)`, and add `protocol: CoverageProtocol` to each status (`'meshcore'` for the MeshCore MQTT manager) so the UI can word it. Typed predicates only.

`src/types/coverage.ts` (WP2 owns): `CoverageMqttSourceStatusDto` gains `protocol: CoverageProtocol`.

`src/utils/coverageReceiverFilter.ts`:
- `buildReceiverQuery`: fall back to `clientSideFilter: true` also when the **encoded** string passes 6,000 chars. 1000 pubkeys would be ~66 KB, far past Node's 16 KB header limit. `parseReceiverFilter` keeps its 1000-id cap.

### 2.6 Report UI (WP3)

- **`CoverageReceiverFilter.tsx`**: a **MeshCore** badge when `protocol === 'meshcore'`; `mqtt_gateway` + meshcore shows the kind **Observer** (not Gateway). Show `formatCoverageNodeId(receiverId)`; search also matches a pubkey prefix. The MQTT status block labels MeshCore MQTT sources "Observer recording".
- **`CoverageMap.tsx`**:
  - MeshCore popup line: "Direct" when `hopsAway === 0`, else "N hops via A1B2" from `parseMeshCorePathKey` (upper-case, width kept). Never call `relayHex` on MeshCore rows.
  - Sender header uses `formatCoverageNodeId`.
  - Observer markers use the gateway style (dashed, hover tooltip), tooltip label "Observer".
- **`CoverageReport.tsx`**:
  - `HOPS_OPTIONS` 0–8 (8 = MeshCore's advert flood limit).
  - Sender option label: `formatCoverageNodeId`.
  - Setup guidance: a **MeshCore** block after the Meshtastic table:
    - "Send **zero-hop** adverts only, one every 60 seconds or slower. **Never flood adverts for a survey**: every repeater within 8 hops repeats each flood advert."
    - How to send one (§0.4): the app's zero-hop advert option; repeater CLI `advert.zerohop`.
    - "MeshMonitor's own Send advert button floods. Don't use it for surveys."
    - "An advert carries the node's stored advert position, not a live GPS fix. Update the node's location before each advert."
    - The §0.3 airtime table (US and EU rows) and the 0.7 % / 1.9 % per-60 s figures.
    - "Repeaters' own adverts are recorded automatically. MeshMonitor never sends adverts for you."
  - Empty-state hint: MeshCore companions record signed adverts that carry a position.
- **Colour bands:** shared `snrToColor` / `rssiToColor` (U4).
- **`public/locales/en.json`** (WP3 owns): `analysis.coverage.kind_observer`, `analysis.coverage.protocol_meshcore`, `analysis.coverage.via_meshcore_path`, `analysis.coverage.direct`, `analysis.coverage.observer_recording`, `analysis.coverage.meshcore_guidance_*`.

### 2.7 Observer toggle UI (WP4)

- `SettingsTab.tsx`: show `CoverageMqttRecordingSection` when `isCoverageMqttSourceType(sourceType)` (replaces `isMqttOnlySourceType` at that one call).
- `configSections.ts`: filter the `settings-coverage-mqtt` nav item with the same helper; add keywords `observer`, `meshcore`.
- `CoverageMqttRecordingSection.tsx`: take `sourceType`. For `meshcore_mqtt`:
  - Label: "Record MeshCore observer receptions for the Coverage Report".
  - Warning next to the input, always visible: "Each observer that hears a MeshCore advert with a position adds one row, and many observers can hear one advert over several paths. We have not measured how many rows a MeshCore region feed produces; watch your database size after turning this on. Rows are kept for the Coverage retention period, a global setting under Settings → Coverage Report." **Do not quote the Meshtastic numbers.**
  - Confirm on enable with the same text; no confirm on disable.
  - Under it: "Only adverts that carry a position and a valid signature are recorded. Rows start from when you turn this on."
  - Meshtastic MQTT sources keep the P2 text unchanged.
- `settings.coverage_observer_*` locale keys, added after WP3 merges.

---

## 3. Test plan (standard Vitest suite)

**Pure helpers**
- `src/utils/coverage.test.ts` (WP0): every branch of `computeMeshCoreHopsAway`; path key round trip for 1/2/3-byte hashes and nulls; id helpers; `isCoverageMqttSourceType`; `isMeshCoreReceptionRow`.
- `src/server/utils/coverageMeshCore.test.ts`, fixtures from real advert hex (copy from `meshcorePacketDecode.test.ts`):
  - One case per skip rule in §2.2 order.
  - Non-advert: `decodeMeshCorePacket` is never called (spy).
  - Zero-hop advert (DIRECT, path_len 0) → hopsAway 0, `pathKey 'h0:-'`.
  - Flood advert with 2 hops of 2-byte hashes → hopsAway 2, `pathKey 'h2:<last 4 hex>'`.
  - Uppercase pubkeys and observer ids lowercased.
  - `packetKey` equals `calculateMeshCorePacketHash` and matches across two copies with different paths.
  - Replay guard: newer ts accepted; same advert via a second path within 60 s accepted; same bytes after 60 s rejected (share); older ts rejected; entry past TTL accepted; LRU bound.
  - **Signature (U3):** a real advert verifies (golden); a flipped lat byte fails → `bad-signature`, not recorded, and the guard state is untouched (a genuine copy that follows still records).
  - Observer stale: 11 min old → skip; absent timestamp → kept.
- `coverageReceiverPositionCache.test.ts`: custom string-key loader; default loader unchanged.

**Recording**
- `src/server/meshcoreManager.coverageReception.test.ts` (mock shape from `meshcoreManager.otaPacket.test.ts`):
  - An ADVERT `ota_packet` with position → one `recordReception` call, `protocol 'meshcore'`, `receiverKind 'local'`, receiver = local pubkey, snapshot = localNode lat/lon.
  - Recorded with the packet log **off**.
  - A non-advert packet → no call. Our own advert relayed back → no call. localNode null → no call.
  - A repo throw does not stop `handleOtaPacket` or the `ota_packet` re-emit.
  - No coverage emit on `dataEventEmitter`.
- `src/server/meshcoreManager.coverageReception.perSource.test.ts`: two managers record under their own `sourceId`; one advert heard by both gives two rows.
- `src/server/meshcoreMqttManager.coverage.test.ts`: flag off (default) → none; on → one row per observer with its SNR/RSSI; own-observer skipped; the observer position comes from that source's `meshcore_nodes` only; a non-advert never reads the flag; a flag flip applies after `invalidateCoverageMqttEnabled`.
- `src/server/meshcoreMqttManager.coverage.perSource.test.ts`: sources A (on) and B (off) ingest the same message; only A records.

**Routes** (`coverageRoutes.test.ts`, `createRouteTestApp`; seed `meshcore_nodes` through the repository):
- Admin sees MeshCore receptions, senders and receivers with names from `meshcore_nodes`.
- **Leak regression:** a limited user with `nodes:read` but no `nodes:viewOnMap` → MeshCore sender rows dropped from `/receptions` and `/senders`; MeshCore receiver coordinates null in `/receivers`.
- The same user with `viewOnMap` sees them.
- A sender with no `meshcore_nodes` row is dropped, for admins too.
- **Per-source isolation:** `nodes:read` + `viewOnMap` on A only never sees B's MeshCore rows.
- Meshtastic cases unchanged.
- `sender=<64-hex>` filters; uppercase is lowercased; 63-hex → 400.
- `hops=8` accepted; `hops=64` → 400.
- `mqttSources` lists a fake `meshcore_mqtt` manager with `protocol 'meshcore'`; a device-backed `meshcore` source never appears; a bare global `coverage_mqtt_enabled` row turns nothing on.
- `coverageReceiverFilter.test.ts`: 200 pubkeys partly selected → `clientSideFilter` from length, not count.
- `coverageReceptions.multiBackend.test.ts`: one MeshCore row round trip.

**Frontend**
- `CoverageMap.test.tsx`: "Direct" / "2 hops via A1B2"; no `0x` relay text on MeshCore rows; Observer marker label.
- `CoverageReceiverFilter.test.tsx`: MeshCore and Observer badges; abbreviated id; pubkey-prefix search; "Observer recording" status label.
- `CoverageReport.test.tsx`: hops options include 8; the MeshCore guidance renders the zero-hop, never-flood, MeshMonitor-button and stored-position warnings and the airtime figures.
- `CoverageMqttRecordingSection.test.tsx`: for `meshcore_mqtt` the warning says volume is unmeasured and contains **none** of the Meshtastic figures (12,000 / 14,000 / 1 million); confirm on enable; per-source POST.
- `configSections.test.ts`: the section appears for `meshcore_mqtt`, not for `meshcore`.

**Exit gate**
- Full suite with PG (5433) and MySQL (3307) up; check `success` and `numPendingTests`.
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v .claude/worktrees` empty. Relative imports carry `.js`.
- `grep -n "type ===\|sourceType ===" src/server/routes/coverageRoutes.ts src/server/utils/coverageMeshCore.ts` empty.
- Browser validation with a live MeshCore companion: send a zero-hop advert with a position from a second node; a MeshCore dot appears with the receiver listed; light/dark; phone width; screenshot for the PR. The dev DB has `meshcore_packet_log_enabled = 'true'`, but `isEnabled()` checks `'1'`, so the packet monitor is off there; P3 does not depend on it.

---

## 4. Work packages

**Order:**
1. **WP0 (orchestrator, one small commit on the branch before forking any worktree).**
2. **WP1, WP2, WP3 run in parallel** in separate worktrees from WP0. They share no edited file.
3. **WP4** after WP3 merges (both edit `en.json`) and after WP2 (it reads the `protocol` field on `mqttSources`).
4. All land in one PR. WP1 never ships without WP2 (§2.5).

| File | WP1 | WP2 | WP3 | WP4 |
|---|---|---|---|---|
| `src/utils/coverage.ts` (+test) | import | import | import | import |
| `src/server/utils/coverageMeshCore.ts` (+tests) | **owns** (new) | — | — | — |
| `src/server/utils/coverageReceiverPositionCache.ts` (+test) | **owns** | — | — | — |
| `src/server/meshcoreManager.ts`, `meshcoreMqttManager.ts` (+ new tests) | **owns** | — | — | — |
| `src/server/utils/positionVisibility.ts` | — | **owns** | — | — |
| `src/server/routes/coverageRoutes.ts` (+test) | — | **owns** | — | — |
| `src/types/coverage.ts` | — | **owns** | import | import |
| `src/utils/coverageReceiverFilter.ts` (+test) | — | **owns** | import | — |
| `src/db/repositories/coverageReceptions.multiBackend.test.ts` | — | **owns** | — | — |
| `src/components/Analysis/Coverage*` (+tests, CSS) | — | — | **owns** | — |
| `src/components/Settings/CoverageMqttRecordingSection.tsx` (+test, CSS), `SettingsTab.tsx`, `search/configSections.ts` (+test) | — | — | — | **owns** |
| `public/locales/en.json` | — | — | **owns** | edits after WP3 |

WP3 reads `mqttSources[].protocol`, which WP2 adds. WP3 codes against the WP2 type in §2.5 and treats a missing field as `'meshtastic'`; the orchestrator re-runs WP3's tests after merging WP2.

### WP0: shared helpers (orchestrator commits this)

Append to `src/utils/coverage.ts`:
```ts
// ---------------------------------------------------------------------------
// MeshCore (#5277 P3)
// ---------------------------------------------------------------------------

/** MeshCore payload type for ADVERT frames (the only positioned packet P3 records). */
export const MESHCORE_PAYLOAD_ADVERT = 0x04;

/** MeshCore header route types (low 2 bits). */
export const MESHCORE_ROUTE_TRANSPORT_FLOOD = 0;
export const MESHCORE_ROUTE_FLOOD = 1;
export const MESHCORE_ROUTE_DIRECT = 2;
export const MESHCORE_ROUTE_TRANSPORT_DIRECT = 3;

/**
 * Hops for a received MeshCore advert. Adverts are zero-hop (DIRECT with an
 * empty path) or flood (path = relays so far). Anything else is unknown.
 */
export function computeMeshCoreHopsAway(
  routeType: number | null | undefined,
  hopCount: number | null | undefined,
): number | null {
  if (hopCount == null || !Number.isInteger(hopCount) || hopCount < 0) return null;
  if (routeType === MESHCORE_ROUTE_FLOOD || routeType === MESHCORE_ROUTE_TRANSPORT_FLOOD) return hopCount;
  if ((routeType === MESHCORE_ROUTE_DIRECT || routeType === MESHCORE_ROUTE_TRANSPORT_DIRECT) && hopCount === 0) return 0;
  return null;
}

/** `h<hops|->:<lastHopHex|->`, lowercase hex, hash width kept. Never empty; ≤ 12 chars. */
export function meshcorePathKey(hopsAway: number | null, lastHopHex: string | null): string {
  const hop = lastHopHex && /^[0-9a-fA-F]{2,6}$/.test(lastHopHex) ? lastHopHex.toLowerCase() : '-';
  return `h${hopsAway ?? '-'}:${hop}`;
}

/** Inverse of `meshcorePathKey`; null when the string is not a MeshCore path key. */
export function parseMeshCorePathKey(pathKey: string): { hops: number | null; lastHop: string | null } | null {
  const m = /^h(\d+|-):([0-9a-f]{2,6}|-)$/.exec(pathKey);
  if (!m) return null;
  return { hops: m[1] === '-' ? null : Number(m[1]), lastHop: m[2] === '-' ? null : m[2] };
}

/** A MeshCore public key as stored in coverage rows: 64 hex chars. */
export function isMeshCorePubKeyId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^[0-9a-fA-F]{64}$/.test(id);
}

/** Short display label: Meshtastic `!xxxxxxxx` unchanged; a pubkey → first 8 hex + '…'. */
export function formatCoverageNodeId(id: string): string {
  return isMeshCorePubKeyId(id) ? `${id.slice(0, 8).toLowerCase()}…` : id;
}

/** True for a MeshCore coverage row (row data, not a source-type gate). */
export function isMeshCoreReceptionRow(row: { protocol: string }): boolean {
  return row.protocol === 'meshcore';
}

/** Source types whose Coverage recording is the per-source `coverage_mqtt_enabled` opt-in (P2 + P3 observers). */
export function isCoverageMqttSourceType(sourceType: string | null | undefined): boolean {
  return sourceType === 'mqtt_bridge' || sourceType === 'mqtt_broker' || sourceType === 'meshcore_mqtt';
}
```
Plus `coverage.test.ts` cases:
- `computeMeshCoreHopsAway`: (1,0)→0, (1,3)→3, (0,2)→2, (2,0)→0, (3,0)→0, (2,1)→null, (5,0)→null, (1,null)→null, (1,-1)→null, (1,1.5)→null.
- `meshcorePathKey`: (0,null)→`h0:-`; (2,'A1B2')→`h2:a1b2`; (null,'zz')→`h-:-`; 6-hex kept.
- `parseMeshCorePathKey`: round trips the above; `r0:h0` → null.
- `isMeshCorePubKeyId`: 64 hex true (either case), 63 false, `!abcd1234` false.
- `formatCoverageNodeId`: pubkey → 8 hex + `…`; `!abcd1234` unchanged.
- `isMeshCoreReceptionRow`; `isCoverageMqttSourceType` (three true; `meshcore`, `meshtastic_tcp`, null false).

### WP1: Recording (server)
- `coverageMeshCore.ts`: evaluator, replay guard, signature check, record function.
- Position cache loader option.
- Companion hook and observer hook (flag-gated).
- Tests from §3 "Recording" and the helper/guard/signature cases.
- **Accept when:** non-adverts cost one compare; nothing is ever sent; a forged or corrupt advert never records and never touches the guard; a repo failure never breaks the OTA or MQTT stream; no events; the packet-log setting has no effect; observers record only with the flag on; the dev container shows `protocol='meshcore'` rows within a minute of a zero-hop advert.

### WP2: Privacy + API (server)
- `buildMeshCorePositionFilter`, `loadMeshCoreNodesBySource`.
- Route changes (§2.5), `protocol` on `mqttSources`, receiver-filter length cap, multiBackend case.
- **Accept when:** the leak regression passes; per-source isolation holds; Meshtastic cases unchanged; no source-type string gate; `ok`/`fail` with SCREAMING_SNAKE codes.

### WP3: Report UI
- §2.6 changes and locale keys; tests.
- **Accept when:** the guidance carries all four U2 warnings; MeshCore rows read well at phone width; no emoji; CSS modules with `var(--color-*)` and no fallback; lint:ci clean.

### WP4: Observer toggle UI
- §2.7; tests.
- **Accept when:** the section appears for `meshcore_mqtt` writers only; the warning says volume is unmeasured and quotes no Meshtastic numbers; confirm on enable; per-source POST; the SettingsTab draft/save partition is untouched; lint:ci clean.

---

## 5. Decisions (final)

### User decisions (2026-09-24)

- **U1 = yes: MeshCore Observer (`meshcore_mqtt`) sources record as receivers.** Opt-in per source, off by default, reusing `coverage_mqtt_enabled`, P2's cache/invalidation, the `mqttSources` status row and the toggle UI. Receiver kind `'mqtt_gateway'`, labelled **Observer**. Volume is unmeasured (the dev container has no `meshcore_mqtt` source), so the toggle warning says so and quotes no Meshtastic numbers (§2.7). Recording and the privacy filter land in the same PR.
- **U2 = 60 s, zero-hop only.** The guidance warns never to flood adverts for a survey, tells the operator exactly how to send a zero-hop advert (§0.4), warns that MeshMonitor's own button floods, and warns that an advert carries the node's stored advert position, not a live GPS fix.
- **U3 = verify the Ed25519 advert signature before recording.** Use `Ed25519SignatureVerifier.verifyAdvertisementSignature` from `@michaelhart/meshcore-decoder` (already in `package.json:46`; `@noble/ed25519` inside). MeshMonitor has no verify helper of its own. No new dependency. The guard runs after the signature, so forged adverts cannot poison it.
- **U4 = shared SNR/RSSI colour bands.** An SF-aware link-margin metric is a P4 follow-up (recorded in `COVERAGE_REPORT_EPIC.md`).

### Flagged for the user (not changed in P3)

- **MeshMonitor's "Send advert" button, the auto-announce advert burst and the automation `advert` action all flood** (§0.4: `meshcoreNativeBackend.ts:1991` sends `SelfAdvertTypes.Flood`; repeater sources run CLI `advert`). Firmware defaults to zero-hop when the type byte is absent (`companion_radio/MyMesh.cpp:1258-1264`). Consider a zero-hop option, a cost confirm, or a cooldown in a separate issue.

### Architect decisions

- **D1: ADVERT is the only positioned packet P3 records.** Telemetry GPS replies need a request; text "locations" are an app convention.
- **D2: packetKey = `calculateMeshCorePacketHash`** (firmware packet hash, path excluded). Relayed copies of one advert share it; each new advert differs. Not djb2.
- **D3: Clock-free replay guard** (§2.2), not an advert-age rule. Advert timestamps are the sender's clock and are often badly wrong. The guard mirrors firmware's replay rule and catches shared-contact re-sends.
- **D4: Observer staleness uses the P2 600 s rule on the observer's capture timestamp.** It only decides skip-or-keep, never `receivedAt`. Absent → kept.
- **D5: Skip observers that are our own companions** (`isOwnPublicKey`). MeshMonitor's Observer publisher (#4457) sends our companion's hearings to analyzer brokers; the companion source already records them first-hand.
- **D6: Receiver kinds.** Companion = `'local'`; observer = `'mqtt_gateway'` shown as "Observer". No DTO union change.
- **D7: pathKey = hop count + last-hop hash** (`h2:a1b2`): the SNR belongs to the last link, it fits in 12 chars, and it matches Meshtastic's relay-byte meaning.
- **D8: Local companions record always,** per the epic.
- **D9: Repeater serial CLI sources are out.** They have no raw RX feed.
- **D10: MeshCore privacy = presence in `meshcore_nodes` + per-source `nodes:viewOnMap`,** branching on the row's `protocol` column, never on `source.type`.
- **D11: No schema, repository or migration change; no new dependency.**

### Open questions for the implementers (no user input needed)

- Confirm on hardware that a zero-hop advert arrives as route type DIRECT with `path_len` 0. If it arrives as FLOOD with 0 hops, `computeMeshCoreHopsAway` still returns 0.
- Confirm the repeater `advert.interval` default on current firmware (docs: 0; source constant: 2 min) before quoting it in the guidance.
- Golden-test the signature verifier against a real advert before wiring it (§2.2).

### Deferred

- Resolving last-hop hashes to repeater names in the popup (1-byte hashes collide) — P4.
- SF-aware link-margin colour metric — P4 (U4).
- MeshCore coverage from telemetry GPS replies — out of scope (not passive).
