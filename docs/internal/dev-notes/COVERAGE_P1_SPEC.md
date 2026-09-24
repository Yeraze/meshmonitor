# Coverage Report Epic (#5277): Phase 1 Implementation Spec

**Phase:** P1: Meshtastic RF receptions + Reports → Coverage card.
**Status:** Approved (orchestrator amendments folded in; see §5 Decisions).
**Branch:** `feature/coverage-p1-rf-receptions` (from origin/main 7a9057f9).
**Authoritative inputs:** `COVERAGE_REPORT_EPIC.md`, plan comment on #5277.

**Next free migration number: 172.** The registry ends at 171 (`reclassify_record_holder_transport`). The one open PR (#5328) adds no migration.

---

## 0. Mesh impact checklist (copy into the PR body)

1. **Airtime: zero.** P1 adds no sends, requests, traceroutes or config pushes. It only records packets the node already received. The only airtime cost is the operator's survey-node setup. The report advises hop_limit 0, smart position on and an interval of 30 s or more, and MeshMonitor never pushes config.
   - Estimate shown in the UI: a position packet takes about 0.5–0.6 s on LongFast.
   - hop_limit 0: 1 tx per fix. A 1 h drive at one fix per 30 s is about 120 tx, roughly 2% of the channel.
   - hop_limit 1 (needed when receivers run firmware older than 2.7.20; see §2.11): 1 origin tx plus one rebroadcast per neighbour that hears it, about 2–4 tx per fix, so about 240–480 tx per hour, roughly 4–8%. These numbers are rough estimates and scale with neighbour count.
   - hop_limit 3 on a busy mesh: about 4–8 tx per fix, so about 500–1000 tx per hour, roughly 8–16%.
   - Smart position uses the configured hop_limit, and honours hop_limit 0 (it does not replace it with 3).
2. **Spam: none.** No messages, notifications or automation triggers. Receptions are **not** emitted on `dataEventEmitter`. The recording hook only does a DB insert. Nothing is sent, so there is no feedback loop and no retry.
3. **Timers: only the hourly retention purge.** It computes `cutoff = now − retentionDays` on each run and keeps no last-fire state. A restart or settings save cannot cause a burst or clear a cooldown. Lowering retention deletes more rows on the next sweep, which cannot be undone, so the settings input warns about it.

---

## 1. Reuse inventory

| Need | Reuse / extend | Justification |
|---|---|---|
| Table/repo/migration shape | Copy `meshtastic_heard_repeaters`: `src/db/schema/meshtasticHeardRepeaters.ts`, `src/db/repositories/meshtasticHeardRepeaters.ts`, `src/server/migrations/152_create_meshtastic_heard_repeaters.ts` (+ `.test.ts` / `.pgmysql.test.ts`) | Closest analog: a per-source side table written from the Meshtastic RX path, whose writes never break RX. |
| Insert-or-ignore dedupe on 3 DBs | `BaseRepository.insertIgnore()` (`src/db/repositories/base.ts:219`) | Already exists. Every unique-key column must be **NOT NULL**, because all three DBs treat NULLs as distinct in UNIQUE indexes (see `autoTraceroute.ts:77`). |
| Source scoping | `withSourceScope` / `sourceId` guards in `base.ts` | Mandatory per CLAUDE.md. |
| Wiring a new table | `src/db/schema/index.ts`, `src/db/activeSchema.ts` (type + 3 maps), `src/db/repositories/index.ts`, `src/services/database.ts` (repo field, getter, construct ~1103) | Same four touchpoints as heard-repeaters. |
| MQTT / non-RF skip | `isViaMqtt`, `resolveRadioPacketTransport` (`src/server/constants/meshtastic.ts:245/271`), `isRfTransport` (`src/server/services/packetLogDedup.ts:96`) | `isRfTransport` already defines "LoRa or LoRa ALT1–3, null counts as LoRa". MQTT, UDP, API and INTERNAL are excluded. |
| Replay rejection | `MIN_PLAUSIBLE_UNIX_SEC` (`src/server/utils/replayGuard.ts`); `ProcessingContext.viaStoreForward` | FW 2.8 PhoneAPI replays cached positions with the same packet id, SNR and hops, with transport forced to LORA. `rx_time` is the only honest field. Do **not** reuse the 6 h `STALE_REPLAY_THRESHOLD_SEC`, which missed a 4h45m replay (#5034). |
| Hop semantics | Same rule as `meshtasticManager.ts:6462-6472` (`hopStart > 0 && hopStart >= hopLimit`), plus the firmware's own zero-hop rule (0/0 with `Data.bitfield` present, per `NodeDB.cpp getHopsAway`; §2.4) | Keeps one definition of hops, aligned with firmware. |
| Bitfield presence check | `typeof decoded.bitfield === 'number'` (`src/server/utils/okToMqtt.ts:76`) | Existing presence test for `optional uint32 bitfield`. |
| Privacy/visibility gate | `buildPositionFilter` (`src/server/routes/analysisRoutes.ts:309`): hideFromMap, orphan, `positionOverrideIsPrivate` vs `nodes_private:read`, channel `viewOnMap`, channel-DB viewOnMap | The epic requires the same checks as `/api/analysis/positions`. **Extract, don't copy** (§2.6). |
| Permitted sources | `resolvePermittedSourceIds(req)` + `parseSourcesParam` (`src/server/utils/permittedSources.ts`), resource `'nodes'` | Same gate as `/api/analysis/positions`. |
| Envelope | `ok()` / `fail()` (`src/server/utils/apiResponse.ts`) | Required. The frontend must unwrap `body.data` itself (as `NodeInfoEnrichmentReport` does); ApiService doesn't. |
| Separate router mounted before `/analysis` | `apiRouter.use('/analysis/mesh-issues', …)` in `src/server/server.ts:878` | `analysisRoutes.ts` is already over 1000 lines. |
| Retention service | `src/server/services/meshcorePositionHistoryService.ts` (hourly sweep, global retention setting) | Same shape. P1 clamps 1–90 and starts explicitly. |
| Source-delete / purge cascade | `databaseService.purgeAllNodesAsync(sourceId?)` (`src/services/database.ts:3643`), called by `sourceRoutes.ts:1566` (source delete), `purgeRoutes.ts:17` and `deviceRoutes.ts:116` | One existing cascade point covers source deletion and "purge all nodes". |
| Global-only setting | `VALID_SETTINGS_KEYS` + `GLOBAL_ONLY_SETTINGS_KEYS` (`src/server/constants/settings.ts:668`); SettingsTab "Category C" pattern (like `packetLogMaxAgeHours`); `GLOBAL_SETTINGS_SECTIONS` + nav item in `src/components/search/configSections.ts` | GLOBAL_ONLY stops a per-source POST from writing a row nobody reads (#5080 bare-key trap). |
| Map shell | `BaseMap` (`src/components/map/BaseMap.tsx`) + fit-bounds controller pattern from `src/components/Analysis/RouterClusterMap.tsx` | CLAUDE.md requires new maps to compose BaseMap. RouterClusterMap is already an embedded BaseMap inside Reports. |
| SNR colours | `snrToColor(value, scale)` + `SnrColorScale` (`src/utils/mapHelpers.tsx:173-192`), palette `overlayColors.snrColors` from `useSettings()` | Exported and theme-aware, with the same 4 bands as `SnrOverlayLayer`'s private `colorForSnr` (not reused). |
| RSSI colours | **New** `rssiToColor(rssi, scale)` beside `snrToColor`, same palette | No RSSI scale exists. The shared palette keeps the legends consistent. |
| Distance | `calculateDistance` + `formatDistance` (`src/utils/distance.ts`); `distanceUnit` from SettingsContext | Shared and unit-aware. |
| Frontend fetch | `api` (`src/services/api.ts`) via new fetchers in `src/services/analysisApi.ts`; TanStack `useQuery` | No raw fetch. `useAggregatedPaginated` is private, tied to `lookbackHours` and has no page cap, so use a small `useQuery` with a capped page loop. |
| Report card | `src/components/Analysis/AnalysisTab.tsx`; UiIcon `radioSignal` | Existing pattern. `ReportsPage` already wraps `SettingsProvider`. |
| Tests | `createRouteTestApp` (template `sourceRoutes.permissions.test.ts`); `createIsolatedPostgresDatabase/Mysql` and `create*Backend({isolationKey})` (`src/db/repositories/test-utils.ts`); `meshtasticManager.heardReflood.test.ts`; `meshcorePacketLog.retention.test.ts`; `meshtasticHeardRepeaters.perSource.test.ts` | All exist. |

**New things, and why:**
- **`coverage_receptions` table.** An epic decision: telemetry rows cannot hold per-path identity.
- **`src/utils/coverage.ts`.** Pure helpers shared by server and frontend. `src/utils/**` is in `tsconfig.server.json`, so relative imports need `.js`.
- **`src/types/coverage.ts`.** The API contract, so WP3 and WP4 can run in parallel.
- **`coverageRetentionService.ts`.** The purge. No existing sweeper covers this table.
- **`coverageRoutes.ts`.** The API.
- **`CoverageReport` / `CoverageMap`.** The UI.

---

## 2. File-by-file changes

### 2.1 Schema: `src/db/schema/coverageReceptions.ts` (new)

Table `coverage_receptions`, three Drizzle definitions (`coverageReceptionsSqlite/Postgres/Mysql`) plus inferred types. Header comment: #5277, per-source, one row per packet per path, P2/P3 reuse, no events.

| Column | SQLite | PG | MySQL | Null | Meaning |
|---|---|---|---|---|---|
| id | INTEGER PK AI | SERIAL | INT AI PK | no | |
| sourceId | TEXT | TEXT | VARCHAR(64) | no | owning source |
| protocol | TEXT | TEXT | VARCHAR(16) | no | `'meshtastic'` (P1/P2), `'meshcore'` (P3) |
| receiverKind | TEXT | TEXT | VARCHAR(16) | no | `'local'` (P1/P3), `'mqtt_gateway'` (P2) |
| receiverId | TEXT | TEXT | VARCHAR(80) | no | canonical id: Meshtastic `!xxxxxxxx`, MeshCore pubkey hex |
| receiverNodeNum | INTEGER | BIGINT(number) | BIGINT | yes | Meshtastic only |
| receiverLatitude / receiverLongitude | REAL | DOUBLE PRECISION | DOUBLE | yes | receiver position **snapshot at receive time** |
| senderId | TEXT | TEXT | VARCHAR(80) | no | `!xxxxxxxx` or MeshCore pubkey hex |
| senderNodeNum | INTEGER | BIGINT | BIGINT | yes | Meshtastic only (privacy gate key) |
| packetKey | TEXT | TEXT | VARCHAR(80) | no | Meshtastic `String(packetId)`; MeshCore packet hash (P3) |
| packetId | INTEGER | BIGINT | BIGINT | yes | Meshtastic packet id (uint32) |
| pathKey | TEXT | TEXT | VARCHAR(32) | no | per-path identity (§2.4); never NULL |
| latitude / longitude | REAL | DOUBLE PRECISION | DOUBLE | no | the fix |
| altitude | REAL | REAL | DOUBLE | yes | |
| precisionBits | INTEGER | INTEGER | INT | yes | |
| snr | REAL | REAL | DOUBLE | yes | dB (fractional); −128 sentinel stored as NULL |
| rssi | INTEGER | INTEGER | INT | yes | dBm; absent = NULL, 0 is real (fw 2.8 explicit presence) |
| hopStart / hopLimit | INTEGER | INTEGER | INT | yes | raw |
| hopsAway | INTEGER | INTEGER | INT | yes | derived; NULL = unknown |
| relayNode | INTEGER | INTEGER | INT | yes | Meshtastic last byte of relayer |
| transportMechanism | INTEGER | INTEGER | INT | yes | |
| channel | INTEGER | INTEGER | INT | yes | resolved slot (same as telemetry) |
| rxTime | INTEGER | BIGINT | BIGINT | yes | device receive clock, **unix seconds** |
| receivedAt | INTEGER | BIGINT | BIGINT | no | server receive time, **unix ms** (window, cursor, purge) |

Indexes:
- UNIQUE `cov_rx_path_uniq (sourceId, receiverId, senderId, packetKey, pathKey)`. `receiverId` is part of the key because a P2 MQTT source has many gateways. MySQL key length is about 1.3 KB, under the 3072-byte limit.
- `cov_rx_received_idx (receivedAt)`: the global purge.
- `cov_rx_source_received_idx (sourceId, receivedAt)`: the window query and `getReceivers`.
- `cov_rx_sender_received_idx (senderId, receivedAt)`: the sender filter.

Also add `export * from './coverageReceptions.js'` to `src/db/schema/index.ts`, and add `coverageReceptions: any` plus the three map entries to `src/db/activeSchema.ts`.

### 2.2 Migration `src/server/migrations/172_create_coverage_receptions.ts` (new)

- Model it on 152:
  - `migration.up`: SQLite `CREATE TABLE IF NOT EXISTS` + `CREATE [UNIQUE] INDEX IF NOT EXISTS`.
  - `runMigration172Postgres`: quoted camelCase columns.
  - `runMigration172Mysql`: `createTableIfMissingMysql` with inline `UNIQUE KEY` / `INDEX`.
- No backfill (epic decision).
- `down` drops the table.
- Register in `src/db/migrations.ts`: `{ number: 172, name: 'create_coverage_receptions', settingsKey: 'migration_172_create_coverage_receptions', … }`.
- `migrations.test.ts` needs no edit.

### 2.3 Repository: `src/db/repositories/coverageReceptions.ts` (new; `CoverageReceptionsRepository extends BaseRepository`)

- **`recordReception(r): Promise<boolean>`**
  - Throws if `sourceId`, `receiverId`, `senderId`, `packetKey` or `pathKey` is empty.
  - Calls `insertIgnore(...)`.
  - Returns true on insert, false on duplicate.
  - First write wins: there is no SNR merge. One row is one path, so a later copy on the same path is a replay or retransmission.
- **`getReceptions(args)`** returns `{ items; pageSize; hasMore; nextCursor }`.
  - args: `{ sourceIds; sinceMs; untilMs; receiverIds?; senderId?; hops?; hopsMode?: 'exact'|'max'; pageSize; cursor? }`
  - Empty `sourceIds` returns an empty page.
  - Conditions: `inArray(sourceId)`, `receivedAt` between since and until, optional receiver and sender filters.
  - Hops: `hopsAway = N` (exact) or `hopsAway <= N` (max). NULL hops are excluded whenever a hops filter is set.
  - Order `receivedAt DESC, id DESC`. Fetch `pageSize+1` rows to compute `hasMore`.
  - Cursor: base64 JSON `{ts,id}` with predicate `receivedAt < ts OR (receivedAt = ts AND id < id)`, using a local encode/decode pair.
  - Page size clamped 1..2000. `normalizeBigInts` on output.
- **`getReceivers({ sourceIds, sinceMs })`** (amendment 6) returns `Array<{ sourceId; protocol; receiverKind; receiverId; receiverNodeNum; lastReceivedAt; receiverLatitude; receiverLongitude }>`.
  - One row per DISTINCT `(sourceId, receiverKind, receiverId, receiverNodeNum)` present for the given sources with `receivedAt >= sinceMs`.
  - `lastReceivedAt = MAX(receivedAt)`.
  - The snapshot lat/lon comes from the **most recent** row of each group that has a non-null snapshot. Implement it portably: a GROUP BY for the keys plus MAX, then one bounded follow-up select per group (receivers are few), ordered `receivedAt DESC LIMIT 1` where the snapshot is not null. Avoid dialect-specific window functions.
  - Empty `sourceIds` returns `[]`.
- **`getSenderSummary({ sourceIds, sinceMs, untilMs, limit })`** returns `Array<{ sourceId; senderId; senderNodeNum; fixCount; lastReceivedAt }>`.
  - GROUP BY `(sourceId, senderId, senderNodeNum)`, `countDistinct(packetKey)`, `MAX(receivedAt)`, ORDER BY `lastReceivedAt DESC`, limit ≤ 2000.
- **`purgeOlderThan(cutoffMs): Promise<number>`**. The **single purge seam**: P4 adds the saved-survey exemption here and nowhere else. It is global by design, since retention is global; document that at the method.
- **`deleteForSource(sourceId): Promise<number>`** (amendment 5). Scoped delete; throws on an empty sourceId.
- **`deleteAll(): Promise<number>`**. For `purgeAllNodesAsync()` called with no sourceId (the all-sources purge).

Wiring:
- Export from `src/db/repositories/index.ts`.
- `src/services/database.ts`: `public coverageReceptionsRepo`, a `get coverageReceptions()` getter that throws if uninitialised, and construction next to `meshtasticHeardRepeatersRepo` (~line 1103).
- This follows the current repo-getter convention (`meshtasticHeardRepeaters`, `mqttPacketLog`). No facade `*Async` wrappers are needed. All methods are async.

### 2.4 Shared helpers: `src/utils/coverage.ts` (new, pure, unit-tested)

- `COVERAGE_RETENTION_DEFAULT_DAYS = 7`, `COVERAGE_RETENTION_MIN_DAYS = 1`, `COVERAGE_RETENTION_MAX_DAYS = 90`.
- `clampCoverageRetentionDays(raw: unknown): number`. Non-finite gives 7; otherwise clamp to [1, 90].
- `COVERAGE_MAX_RX_AGE_SEC = 600` (Decision D1).
- `isStaleCoverageRxTime(rxTimeSec, nowMs): boolean`. True only when `rxTimeSec >= MIN_PLAUSIBLE_UNIX_SEC` and `nowSec − rxTimeSec > 600`. An absent or implausible rxTime counts as not stale.
- `computeMeshtasticHopsAway({ hopStart, hopLimit, hasBitfield }): number | null` (Decision D2, verified in firmware develop):
  - `hopStart > 0 && hopLimit != null && hopStart >= hopLimit` gives `hopStart − hopLimit`.
  - **True zero-hop:** `hopStart === 0 && hopLimit === 0 && hasBitfield` gives `0`.
  - Anything else gives `null`. That includes 0/0 without a bitfield, which is pre-2.3 firmware with hop_start unset.
  - Why not `relay_node`: a zero-hop origin arrives with hop_start=0, hop_limit=0, relay_node=0. The **receiver** sets `relay_node = NO_RELAY_NODE (0)` whenever hop_start == 0 (`RadioLibInterface.cpp:690-692`), so relay_node cannot tell zero-hop from old firmware.
  - Firmware makes the same split with `decoded.has_bitfield`: senders on 2.5.0 or later always set `Data.bitfield` on their own packets (`Router.cpp:1249-1250`), and `NodeDB.cpp getHopsAway` treats hop_start 0 without a bitfield as unknown.
  - `hasBitfield` means `Data.bitfield` is **wire-present**. It is `optional uint32 bitfield = 9` (explicit presence), so protobufjs leaves an absent field null/undefined and a present 0 as the number 0. Test it with `typeof meshPacket.decoded?.bitfield === 'number'`, the same presence check `src/server/utils/okToMqtt.ts:76` uses. **Presence, not truthiness:** a bitfield of 0 counts as present.
- `meshtasticPathKey(relayNode, hopsAway): string` returns `` `r${relayNode ?? '-'}:h${hopsAway ?? '-'}` ``. Never empty. relayNode 0 gives `r0`, which is the normal key for zero-hop receptions.
- `nodeNumToId(n)` returns `!xxxxxxxx`. Reuse an existing `src/utils` helper if one exists.
- `COVERAGE_RSSI_BANDS = { excellent: -90, good: -105, fair: -115 }` (Decision D3). ≥ −90 excellent, ≥ −105 good, ≥ −115 fair, below that poor, null means no data.
- `groupReceptionsIntoFixes(rows)`:
  - Key `${senderId}|${packetKey}`.
  - Fix lat/lon from the newest row.
  - `receptions` sorted by the active metric, descending.
  - `bestSnr` / `bestRssi` = max across receptions (Decision D4).

`src/types/coverage.ts` (new): `CoverageReceptionDto`, `CoverageReceiverDto`, `CoverageSenderDto`, `CoveragePage`, `CoverageHopsMode`.

### 2.5 Recording hook: `src/server/meshtasticManager.ts`

In `processPositionMessageProtobuf` (~7517), **after** `isValidPosition` passes and `fromNum` / `channelIndex` are known (just before the lat/lon `insertTelemetry` block, ~7610):
```ts
void this.maybeRecordCoverageReception(meshPacket, coords, position, precisionBits, channelIndex, context);
```
It is non-blocking, like `maybeRecordHeardReflood` (~6371).

`private async maybeRecordCoverageReception(...)` runs entirely inside `try/catch`, logs at `logger.debug`, and never throws. It returns early (records nothing) when any of these hold:
1. `this.localNodeInfo?.nodeNum` is null.
2. `fromNum === localNodeNum`: our own position.
3. `meshPacket.viaMqtt === true` or `!isRfTransport(resolveRadioPacketTransport(meshPacket))`.
4. `context?.viaStoreForward` or `context?.virtualNodeRequestId != null`.
5. `packetId` is missing or 0.
6. `isStaleCoverageRxTime(rxTime, Date.now())`.

Values:
- SNR: `rxSnr ?? rx_snr`, with −128 stored as null (reuse `posRxSnr` if the hook sits after it).
- RSSI: `rxRssi ?? rx_rssi ?? null`. Keep 0.
- Hops and path:
  ```ts
  hopsAway = computeMeshtasticHopsAway({
    hopStart, hopLimit,
    hasBitfield: typeof meshPacket.decoded?.bitfield === 'number',
  })
  pathKey = meshtasticPathKey(relayNode, hopsAway)
  ```
  Before relying on it, confirm that the decoded `Data` object reaching `processMeshPacket` still carries `bitfield` (decoded by the device or by server-side decryption) for both decryption paths. If server-decrypted packets lose it, thread it through `ProcessingContext`.
- Receiver snapshot: a private cache `coverageReceiverPos: { lat; lon; at } | null`, refreshed at most every 60 s from `databaseService.nodes.getNode(localNodeNum, this.sourceId)`. Use `latitudeOverride/longitudeOverride` when `positionOverrideEnabled`, else the live `latitude/longitude`.
- The call:
  ```ts
  databaseService.coverageReceptions.recordReception({
    sourceId: this.sourceId, protocol: 'meshtastic', receiverKind: 'local',
    receiverId: nodeNumToId(localNodeNum), receiverNodeNum: localNodeNum, receiverLatitude, receiverLongitude,
    senderId: nodeId, senderNodeNum: fromNum, packetKey: String(packetId), packetId, pathKey,
    latitude, longitude, altitude: position.altitude ?? null, precisionBits, snr, rssi,
    hopStart, hopLimit, hopsAway, relayNode, transportMechanism: resolveRadioPacketTransport(meshPacket),
    channel: channelIndex, rxTime, receivedAt: Date.now(),
  })
  ```

**No** `dataEventEmitter` emit and **no** setting gate: RF sources always record. MQTT sources (`MqttBrokerManager` / `MqttBridgeManager`) ingest via `ingestServiceEnvelope` and never reach this path; P2 hooks there.

### 2.6 Visibility util extraction: `src/server/utils/positionVisibility.ts` (new)

- Move `buildPositionFilter` out of `analysisRoutes.ts` **with no behaviour change**.
- Generalise the predicate parameter to `{ sourceId: string; nodeNum: number }`. `PositionRow` still satisfies it.
- Add an optional third parameter `nodesBySource?: Map<string, DbNode[]>` so callers that already loaded nodes don't call `getAllNodes` twice.
- Also export `loadNodesBySource(sourceIds)`.
- `analysisRoutes.ts` imports it. Its existing `/positions` and `/coverage-grid` tests must stay green unchanged.

### 2.7 Retention: `src/server/services/coverageRetentionService.ts` (new)

- Singleton with explicit `start()` / `stop()`. Do not start in the constructor, which would auto-start on import during tests.
- `runCleanup()`:
  ```ts
  cutoff = Date.now() - days * 86_400_000
  databaseService.coverageReceptions.purgeOlderThan(cutoff)
  ```
- `getRetentionDays()` returns `clampCoverageRetentionDays(await databaseService.getSettingAsync('coverage_retention_days'))`. Global setting, bare-key read.
- Start it in `src/server/server.ts` next to the telemetry purge (~473-512): `await databaseService.waitForReady(); coverageRetentionService.start();`. The first sweep runs 30 s after start, then hourly.
- No persisted last-fire timestamp: the purge is idempotent and cutoff-based.

### 2.8 Setting `coverage_retention_days`

- **`src/server/constants/settings.ts`:**
  - Add the key to `VALID_SETTINGS_KEYS` (near the other `*_retention_days` keys) with the comment "#5277 global, default 7, clamped 1–90".
  - Add it to `GLOBAL_ONLY_SETTINGS_KEYS` with the comment "global retention sweep (#5277), read via getSettingAsync". It passes both GLOBAL_ONLY tests.
- Clamping happens at read time in the service, and the UI clamps too. No settingsRoutes validation change.
- **`src/components/SettingsTab.tsx`** (Category C, following `packetLogMaxAgeHours`):
  1. `SettingsDraft.coverageRetentionDays: number`, default 7.
  2. `initialCoverageRetentionDays` state + `buildBaseline` entry.
  3. Load it in the server-settings effect via `clampCoverageRetentionDays(settings.coverage_retention_days)`.
  4. `handleSave` literal: `coverage_retention_days: String(clampCoverageRetentionDays(draft.coverageRetentionDays)),`.
  5. Refresh the `initial*` snapshot after save; reset-to-defaults sets 7.
  6. UI: a new section `{show('settings-coverage') && canWriteSettings && <div id="settings-coverage" className="settings-section">…}` with a number input (min 1, max 90). Help text warns that lowering the value permanently deletes older receptions on the next hourly sweep.
- **`src/components/search/configSections.ts`:** add `'settings-coverage'` to `GLOBAL_SETTINGS_SECTIONS`, add a nav item (`label: t('settings.coverage_section','Coverage Report')`, keywords `coverage`, `range test`, `retention`, `survey`), and add it to `settingsWriteOnly`.

### 2.9 API: `src/server/routes/coverageRoutes.ts` (new)

- `router.use(optionalAuth())`. Mount in `server.ts` **before** `/analysis`: `apiRouter.use('/analysis/coverage', coverageRoutes)`. This doesn't collide with `/analysis/coverage-grid`, because Express mount paths match whole segments.
- Every handler resolves `sourceIds = parseSourcesParam(req.query.sources) ∩ await resolvePermittedSourceIds(req)` (resource `'nodes'`, read). If the result is empty, return `ok(res, <empty shape>)`.
- Responses use `ok()` / `fail()`. Codes: `INVALID_TIME_RANGE`, `INVALID_HOPS`, `INVALID_HOPS_MODE`, `INVALID_SENDER`, `INVALID_CURSOR`, `INTERNAL_ERROR` (500).
- The retention window is `sinceMs = now − retentionDays × 86_400_000`, where `retentionDays` comes from `coverageRetentionService.getRetentionDays()`.

1. **`GET /api/analysis/coverage/receivers?sources=`** returns `ok(res, { receivers: CoverageReceiverDto[], retentionDays })` (amendment 6).
   - Call `databaseService.coverageReceptions.getReceivers({ sourceIds, sinceMs: retention window start })`.
   - **No `source.type` string gate.** Receivers are whatever is present in the table, which is future-proof for P2 gateways and P3 MeshCore.
   - Enrich each receiver from `nodes`: when `receiverNodeNum` is non-null, look up `(sourceId, receiverNodeNum)` in the preloaded nodes map for `longName` / `shortName` and the current position (override-aware: override when `positionOverrideEnabled`, else live). Fall back to the latest `receiverLatitude/Longitude` snapshot when the node has no position. P3 MeshCore enrichment extends this lookup and is out of scope for P1.
   - Add `sourceName` from `databaseService.sources.getAllSources()`.
   - **Visibility nulling:** set lat/lon to null when the predicate rejects `{sourceId, nodeNum: receiverNodeNum}`. A receiver with a null nodeNum keeps its snapshot in P1; P3 adds its own gate.
2. **`GET /api/analysis/coverage/senders?since&until&sources=`** returns `ok(res, { senders: CoverageSenderDto[], truncated })`.
   - Calls `getSenderSummary` with limit 2000.
   - Drops groups whose `(sourceId, senderNodeNum)` fails the predicate.
   - Merges by `senderId`: sums `fixCount` (an upper bound across sources, documented) and takes the max of `lastReceivedAt`.
   - Attaches names; sorted by `lastReceivedAt` desc.
3. **`GET /api/analysis/coverage/receptions?since&until&sources&receivers&sender&hops&hopsMode&pageSize&cursor`** returns `ok(res, { items: CoverageReceptionDto[], pageSize, hasMore, nextCursor })`.
   - Defaults: `since = now − 24h`, `until = now`. `until < since` returns 400.
   - `hops` is an integer 0..7, else 400. `hopsMode` is `exact` (default) or `max`.
   - `sender` accepts `!hex` or a decimal nodeNum, normalised to `!hex`, else 400.
   - `receivers` is a CSV of receiverIds.
   - `pageSize` is clamped 1..2000, default 1000.
   - Post-filter each page with the predicate on `{sourceId, nodeNum: senderNodeNum}`, as /positions does. Pages can come back short; the client keeps paging on `hasMore`.
   - Null out `receiverLatitude/Longitude` on rows whose receiver fails the predicate.

### 2.10 Source-delete / purge cascade (amendment 5; WP3 wires, WP1 supplies methods)

In `src/services/database.ts` `purgeAllNodesAsync(sourceId?)`, next to the other child-record deletes:
```ts
if (this.coverageReceptionsRepo) {
  sourceId ? await this.coverageReceptionsRepo.deleteForSource(sourceId)
           : await this.coverageReceptionsRepo.deleteAll();
}
```

This one change covers every call site:
- Source deletion: `sourceRoutes.ts:1566`.
- Purge nodes: `purgeRoutes.ts:17`.
- Device purge: `deviceRoutes.ts:116`.

Update the comment block at `sourceRoutes.ts:1583` so it names coverage receptions next to beacon offers and ATAK contacts.

### 2.11 Frontend

- **`src/services/analysisApi.ts`:** add `fetchCoverageReceivers`, `fetchCoverageSenders` and `fetchCoverageReceptionsPage`. Each is typed from `src/types/coverage.ts` and **returns `body.data`**.
- **`src/hooks/useCoverageData.ts`** (new): `useCoverageReceivers()`, `useCoverageSenders(filters)`, `useCoverageReceptions(filters)`.
  - TanStack `useQuery` with keys under `['analysis','coverageReport',…]`. Avoid `['analysis','coverage',…]`, which `useCoverageGrid` already uses.
  - The receptions queryFn loops `nextCursor` up to `COVERAGE_MAX_PAGES = 10` (about 10k rows), returns `{ items, truncated }` and honours the AbortSignal between pages.
  - A manual Refresh button replaces polling.
- **`src/components/Analysis/CoverageReport.tsx`** + **`CoverageReport.module.css`** (new):
  - Filters:
    - Sender `<select>`: All, or one sender showing name, `!id` and fix count.
    - Receivers checkbox list, default all, from `/receivers`.
    - Hops: `Any | 0..7` plus an Exact / "Up to" toggle.
    - Time range presets: 1 h, 6 h, 24 h (default), 3 d, 7 d, plus custom from/to `datetime-local`.
    - Colour metric: SNR / RSSI.
  - Truncation banner.
  - Empty state explaining that only live RF receptions since upgrade appear, with no backfill.
  - "Data kept N days" note.
  - Collapsible **Setup guidance** panel:
    - Recommend hop_limit 0, smart position on (it honours hop_limit 0) and an interval of 30 s or more.
    - **Receiver firmware caveat:** receivers only keep zero-hop (hop_limit 0) packets on firmware **2.7.20 or later**. Older firmware drops packets with hop_start == 0 before decrypting them. If any receiver runs older firmware, use **hop_limit 1** instead. Direct copies still show as 0 hops, but each neighbour rebroadcasts once, which costs more airtime.
    - The airtime table from §0 with rows for hop_limit 0, 1 and 3.
    - A statement that MeshMonitor sends nothing and never changes the survey node.
- **`src/components/Analysis/CoverageMap.tsx`** (new):
  - Composes `BaseMap`, with the tileset from `useSettings()`. Center falls back to `defaultMapCenterLat/Lon/Zoom`, else `[0,0], 2`.
  - `FitCoverageBounds` controller (RouterClusterMap pattern), once per data set.
  - One `CircleMarker` per fix, filled `snrToColor(bestSnr, overlayColors.snrColors)` or `rssiToColor(bestRssi, …)`.
  - Receiver markers: larger `CircleMarker`s with a distinct stroke and a permanent `Tooltip`.
  - Clicking a fix opens a `Popup` listing each reception **within the current filter** (Decision D5): receiver name, SNR, RSSI, "Direct" or "Relayed (N hops, via 0xNN)", distance (`formatDistance(calculateDistance(fix, receiverSnapshot), distanceUnit)`, or "—" when null), and time.
  - Legend: bands for the active metric, plus the note "For receptions with 1 or more hops, colour shows the last relay's link, not the sender's position."
- **`src/utils/mapHelpers.tsx`:** add `rssiToColor` using `COVERAGE_RSSI_BANDS`.
- **`src/components/Analysis/AnalysisTab.tsx`:** add `'coverage'` to `AnalysisType`, a card (`icon: 'radioSignal'`), and a `selected === 'coverage'` branch with the back button.
- UiIcon only, no emoji, CSS modules only. Leaflet `pathOptions` take literal colours from `overlayColors`. Keep non-component helpers out of the `.tsx` files (`react-refresh/only-export-components`).
- **`public/locales/en.json`** (flat dotted keys):
  - `analysis.coverage.*` (WP4).
  - `settings.coverage_section`, `settings.coverage_retention_days`, `settings.coverage_retention_help` (WP2).

---

## 3. Test plan (standard Vitest suite)

**Migration**
- `172_create_coverage_receptions.test.ts` (SQLite): the table and 4 indexes exist, a second run is idempotent, a duplicate unique key fails.
- `172_create_coverage_receptions.pgmysql.test.ts`: `describe.skipIf`, using `createIsolatedPostgresDatabase('mig172')` / `createIsolatedMysqlDatabase('mig172')`.

**Repository**
- `coverageReceptions.test.ts` (SQLite):
  - Insert, then a duplicate returns false with the count unchanged.
  - A different `pathKey` or `receiverId` gives a new row.
  - A missing key field throws.
  - Window bounds; sender filter; receiver filter; hops exact vs max; NULL hops excluded when filtered.
  - Cursor pagination with no skip or repeat, including equal `receivedAt`.
  - `pageSize` clamp.
  - `getSenderSummary` counts distinct packets.
  - **`getReceivers`**: distinct per `(sourceId, kind, id, nodeNum)`, respects `sinceMs`, returns the latest non-null snapshot.
  - BIGINT nodeNum above 2^31 round-trips as a number.
- `coverageReceptions.perSource.test.ts`: sources A and B.
  - `getReceptions` / `getReceivers` / `getSenderSummary` scoped to A never return B.
  - **`deleteForSource('A')` leaves B.**
  - `deleteAll()` empties the table.
- `coverageReceptions.retention.test.ts`: `purgeOlderThan(cutoff)` removes only `receivedAt < cutoff` rows across sources and returns the count.
- `coverageReceptions.multiBackend.test.ts`: dedupe, window + hops query, `getReceivers`, purge and `deleteForSource` on PG and MySQL via `createPostgresBackend/createMysqlBackend({ isolationKey: 'covrx' })`. The table is created with the migration-172 runners, not hand-written DDL.

**Shared helpers**
- `src/utils/coverage.test.ts`:
  - `clampCoverageRetentionDays` (undefined, 'abc', 0, 1, 7, 90, 500).
  - `computeMeshtasticHopsAway`:
    - Normal: 3/1 gives 2.
    - **0/0 with a bitfield gives 0.**
    - **0/0 with no bitfield gives null** (pre-2.3 firmware).
    - hopStart 0 with hopLimit > 0 gives null.
    - hopLimit > hopStart gives null; null inputs give null.
  - `meshtasticPathKey`: never empty; relayNode 0 gives `r0:h0`.
  - `isStaleCoverageRxTime` at the 600 s boundary, with implausible and absent rxTime.
  - `groupReceptionsIntoFixes`.
- Extend the `mapHelpers` tests with `rssiToColor` bands (−90 / −105 / −115 edges, null).

**Recording**
- `src/server/meshtasticManager.coverageReception.test.ts` (modelled on `heardReflood.test.ts`; mock `databaseService.coverageReceptions.recordReception` with `mockResolvedValue`):
  - An RF position records the full payload.
  - **Skipped:** `viaMqtt: true`; MQTT transport; UDP; from == local; `viaStoreForward`; no local node; packetId 0; rxTime 11 min old.
  - Explicit 0 RSSI is kept; SNR −128 becomes null.
  - A 0/0 packet with `decoded.bitfield: 0` (present) records `hopsAway 0`, `pathKey 'r0:h0'`. The same packet with no bitfield records `hopsAway null`.
  - Same packet via two relays gives two calls with different pathKeys.
  - A repo throw does not break telemetry insert or node upsert.
  - No coverage emit on `dataEventEmitter`.

**Service**
- `coverageRetentionService.test.ts`: setting read and clamp ('500' gives 90, missing gives 7); cutoff maths with fake timers; idempotent `start()`/`stop()`; a purge error is logged, not thrown.

**Routes**
- `src/server/routes/coverageRoutes.test.ts` with `createRouteTestApp` (template `sourceRoutes.permissions.test.ts`). Seed receptions and nodes for `sourceA` and `sourceB`:
  - Anonymous with no grants gets empty `success/data`.
  - A limited user with `nodes:read` on A only never sees B rows or receivers (**per-source isolation**, an exit criterion).
  - `sources=B` for that user is empty.
  - A hidden-from-map sender is dropped.
  - A channel without `viewOnMap` is dropped; granting `channel_0 viewOnMap` makes it appear.
  - A private-override sender is dropped without `nodes_private:read`.
  - Receiver coordinates are nulled when the receiver is not visible.
  - Admin sees all visible rows.
  - 400 codes for bad hops, hopsMode, time range, sender and cursor.
  - `/receivers` is derived from the table only: a permitted source with no receptions has no receiver, and **there is no type-string dependency** (seed a source of a non-TCP type with rows and it appears). Enrichment covers names, the current node position, and the snapshot fallback when the node has no position.
  - `/senders` merges across sources.
- **Cascade** (amendment 5): extend or add a route test for source deletion (`sourceRoutes`) and for `purgeRoutes`, asserting that coverage rows for the target source are gone and other sources are untouched. Add a `database.ts`-level test that `purgeAllNodesAsync()` with no sourceId empties the table.
- Regression: the existing `analysisRoutes` `/positions` and `/coverage-grid` tests are unchanged and green after the extraction.

**Settings**
- The existing `settings.allowlist.test.ts` and `server.settings-persistence.test.ts` stay green with the new key.
- New test: `POST /api/settings?sourceId=X` with `coverage_retention_days` is dropped (the GLOBAL_ONLY path).
- `configSections.test.ts`: `settings-coverage` appears only in global mode for users with settings write access.

**Frontend**
- `CoverageReport.test.tsx` (mock the `analysisApi` fetchers):
  - Defaults: all receivers, 24 h.
  - A sender or hops change refetches with the right params.
  - Truncation banner; empty state; guidance toggle; metric toggle switches the legend.
- `CoverageMap.test.tsx` (react-leaflet mocked):
  - One marker per fix.
  - The popup lists every in-filter receiver with direct/relayed and distance.
  - The legend note is present.
- `useCoverageData.test.ts`: the page loop stops at `hasMore:false`, caps at 10 pages with `truncated: true`, and unwraps `data`.
- `AnalysisTab.test.tsx`: the Coverage card exists and opens the report.

**Exit gate:**
- Full suite with PG (5433) and MySQL (3307) containers up. Confirm via `numPendingTests` that the multi-backend suites actually ran.
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v .claude/worktrees` is empty.
- Browser validation in the dev container, with a screenshot attached to the PR.

---

## 4. Work packages

**Order:** WP1 first. WP2 and WP3 then run in parallel. WP4 can start once WP1 lands, against `src/types/coverage.ts` with mocked fetchers, and integrates after WP3. **WP2 lands before WP4**: both touch `en.json`, and the orchestrator rebases WP4.

### WP1: Data layer (first)
- Schema, migration 172 + registry, activeSchema / schema index / repo index / DatabaseService getter.
- `CoverageReceptionsRepository`: every method in §2.3, including `getReceivers`, `deleteForSource` and `deleteAll`.
- `src/utils/coverage.ts`, `src/types/coverage.ts`.
- Tests: migration (SQLite + pgmysql), repo, perSource, retention, multiBackend, helpers.

**Accept when:**
- Green on SQLite **and** PG/MySQL containers, with isolated DBs.
- Migration is idempotent.
- Every unique-key column is NOT NULL.
- `migrations.test.ts` is green; `lint:ci` is clean.

### WP2: Recording + retention + setting (after WP1; parallel with WP3; lands before WP4)
- `maybeRecordCoverageReception` + receiver-position cache.
- `coverageRetentionService` + start in `server.ts`.
- `coverage_retention_days` in VALID + GLOBAL_ONLY.
- SettingsTab Category C field + `settings-coverage` section + configSections entries.
- `settings.coverage_*` locale keys.
- Tests: recording, service, settings allowlist/persistence, GLOBAL_ONLY drop, configSections.

**Accept when:**
- Every skip case in §2.5 is tested.
- A repo failure can't break RX.
- No `dataEventEmitter` emission.
- The clamp is enforced at read time.
- A source-mode save can't persist the key per-source.
- Dev container: live RF positions produce rows.

### WP3: API + cascade (after WP1; parallel with WP2)
- Extract `buildPositionFilter` to `src/server/utils/positionVisibility.ts` with no behaviour change.
- `coverageRoutes.ts` (`/receivers` derived from the table per §2.9, `/senders`, `/receptions`), mounted before `/analysis`.
- Wire `deleteForSource` / `deleteAll` into `purgeAllNodesAsync` (§2.10).
- Route tests with `createRouteTestApp`, including cascade tests for source delete and purge nodes.

**Accept when:**
- Per-source isolation and all privacy gates are proven with real SQL permissions.
- No `source.type` string gate anywhere in the new code.
- The existing analysis route tests are unchanged and green.
- `ok`/`fail` with SCREAMING_SNAKE codes; page size ≤ 2000.
- `.js` extensions on server-compiled relative imports.
- Cascade removes only the target source's rows.

### WP4: Frontend report (after WP1 contract; integrate after WP3; rebase on WP2)
- `analysisApi.ts` fetchers, `useCoverageData.ts`, `rssiToColor`.
- `CoverageReport` + module CSS, `CoverageMap` (BaseMap).
- AnalysisTab card, `analysis.coverage.*` locale keys.
- Component and hook tests.
- Browser validation (light and dark, phone width) and a PR screenshot.

**Accept when:**
- No raw fetch, no emoji, CSS modules only, BaseMap composed.
- SNR and RSSI colouring via the shared palette.
- The popup lists every in-filter receiver with SNR, RSSI, direct/relayed and distance.
- The legend has the relayed-hop note; the guidance shows the airtime estimate.
- Truncation banner at the cap.
- Tests green; `lint:ci` clean.

---

## 5. Decisions

- **D1: Replay freshness.** `COVERAGE_MAX_RX_AGE_SEC = 600`. A reception whose plausible `rx_time` is more than 10 min old is dropped. This blocks FW 2.8 NodeDB replays whose original was never stored; the unique key already collapses replays of rows we did store. Accepted risk: a receiving node whose clock is off by more than 10 min loses data. MeshMonitor time-syncs its node.
- **D2: Zero-hop rule (amendment 9, verified in firmware develop; replaces the earlier relay-byte rule).**
  - Rule: 0/0 counts as zero hops only when `Data.bitfield` is wire-present (`typeof decoded.bitfield === 'number'`). Otherwise it is unknown (null).
  - Why relay_node can't work: the receiver zeroes `relay_node` whenever hop_start == 0 (`RadioLibInterface.cpp:690-692`).
  - Why the bitfield works: senders on 2.5.0 or later always set `Data.bitfield` (`Router.cpp:1249-1250`), and firmware `getHopsAway` uses the same test.
  - `pathKey` is unchanged (relayNode 0 gives `r0`).
  - Guidance adds the receiver firmware ≥ 2.7.20 caveat and the hop_limit 1 fallback with its airtime cost (§0, §2.11).
- **D3: RSSI bands.** ≥ −90 excellent, ≥ −105 good, ≥ −115 fair, below that poor.
- **D4: Dot colour.** The best (max) reception among the filtered receivers. With one receiver selected, that receiver's value.
- **D5: Popup scope.** Receivers within the current filter only; no extra per-fix query.
- **D6: Write volume.** No write rate cap. Rows are bounded by the unique key (one per packet per path per receiver) and 7-day retention. Reads are paginated (≤ 2000 per page) and the client caps at 10 pages with a truncation banner.
- **D7: Source-delete / purge cascade is in P1.** WP1 adds `deleteForSource` / `deleteAll` with tests. WP3 wires them into `purgeAllNodesAsync`, which covers source delete, purge-nodes and device purge, with call-site tests.
- **D8: Receivers are derived from data, not source type.** `/receivers` uses `getReceivers` (DISTINCT `(sourceId, receiverKind, receiverId, receiverNodeNum)` in the retention window for permitted sources). Names and current position come from `nodes`, falling back to the latest snapshot, with visibility nulling. There is no `source.type === 'meshtastic_tcp'` gate: untyped type-string gates are a known bug class. This design covers P2 gateways and P3 MeshCore without change.
- **D9: Backup.** `coverage_receptions` is **not** in `BACKUP_TABLES`. It is ephemeral, regenerable data, like `mqtt_packet_log`. P4 saved surveys may revisit this.
- **D10: Locale conflict.** WP2 lands first; WP4 rebases. The orchestrator handles it.

### Notes carried forward

- **Units.** `receivedAt` is server **ms**; `rxTime` is device **seconds**. Name both explicitly in code comments (the `nodes.createdAt` ms vs `lastHeard` s trap).
- **Query keys.** The new hooks use `['analysis','coverageReport',…]`, not `['analysis','coverage',…]` (which `useCoverageGrid` uses).
- **P2/P3 fit.**
  - P2: `receiverKind='mqtt_gateway'`, `receiverId = gateway !id`, a per-gateway snapshot, hooked in `mqttIngestion.ts` behind a per-source opt-in.
  - P3: `protocol='meshcore'`, pubkey-hex ids, `packetKey` = packet hash, `pathKey` from `path_len` plus the last hop hash, `senderNodeNum` null. It needs a MeshCore visibility predicate and receiver enrichment.
  - P4 exemption: only in `purgeOlderThan`.
- **Agent worktrees.** Run `git submodule update --init --recursive` and symlink `node_modules` before trusting a test run. Filter `.claude/worktrees` out of local `lint:ci`.
