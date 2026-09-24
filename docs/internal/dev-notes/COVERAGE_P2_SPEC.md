# Coverage Report Epic (#5277): Phase 2 Implementation Spec

**Phase:** P2: MQTT gateway receptions.
**Status:** Approved. User decisions folded into §5 (U1 = A, no cap; Q1–Q4 resolved).
**Branch:** `feature/coverage-p2-mqtt-gateways` (from origin/main 84e646fe, which holds P1 / PR #5334).
**Inputs:** `COVERAGE_REPORT_EPIC.md`, `COVERAGE_P1_SPEC.md`, the P1 code, and a firmware check of MQTT uplink fields by the meshtastic-expert agent (firmware develop `608ff51`; saved as agent memory `reference_mqtt_uplink_rx_metadata.md`).

**No schema change and no migration.** P1 built `coverage_receptions` for this phase: `receiverKind = 'mqtt_gateway'`, `receiverId = gateway !id`, a per-gateway snapshot, and `receiverId` already in the unique key. P2 adds no column and no index. PG/MySQL suites only need re-runs for the repository query changes (§2.3).

---

## 0. Mesh impact checklist (copy into the PR body)

1. **Airtime: zero.** P2 sends nothing: no packets, requests or config. It records ServiceEnvelopes the MQTT source already receives. It adds no MQTT publishes either.
2. **Spam: none.** No messages, notifications or automation triggers. Receptions are not emitted on `dataEventEmitter`. The hook does one DB insert per (packet, path, gateway). Nothing is sent, so no feedback loop and no retry.
3. **Timers: none new.** The P1 hourly retention sweep covers MQTT rows too. It is cutoff-based with no last-fire state. The new opt-in setting only flips a cached flag. A save cannot fire anything or reset a cooldown.
4. **The real cost is disk and DB load, not airtime.** See §5 U1 for measured numbers. The user chose no cap (U1 = A): the toggle is off by default, warns with the measured numbers next to the input, and asks for confirmation on enable.

---

## 1. Reuse inventory

| Need | Reuse / extend | Why |
|---|---|---|
| Hook point | `ingestServiceEnvelopeInner` POSITION case, `src/server/mqttIngestion.ts:392-507` | Both MQTT source kinds reach it: `MqttBrokerManager.handlePublish` (`mqttBrokerManager.ts:334`) and `MqttBridgeManager` (`mqttBridgeManager.ts:686`). Nothing else calls `ingestServiceEnvelope`. Hooking here scopes P2 to Meshtastic MQTT sources **with no type check at all**. `MeshCoreMqttManager` has its own path and stays out (P3). |
| Gateway id parse | `parseGatewayNodeNum` (`src/server/utils/okToMqtt.ts`) + `nodeNumToId` (`src/utils/coverage.ts`) | Already used by the packet log and violation code. |
| ok_to_mqtt bit | `readBitfieldOkToMqtt` (`okToMqtt.ts`) | Tri-state reader, presence-aware. |
| Self-echo guard | `MqttIngestionInput.localGatewayNodeNum` | The broker/bridge already pass their own gateway nodeNum. |
| Own-node check | `isOwnNodeNum` (`src/server/utils/ownNodes.ts`) | Live, cross-source, fail-open. For §5 D3. |
| Ignore check | `databaseService.ignoredNodes.isIgnoredCached(num, sourceId)` | Sync, cached. |
| Hops, path, stale, SNR | `computeMeshtasticHopsAway`, `meshtasticPathKey`, `isStaleCoverageRxTime` (`src/utils/coverage.ts`) | One definition of hops for RF and MQTT. |
| RF transport test | `isRfTransport` (`src/server/services/packetLogDedup.ts:96`) | Null counts as LoRa, which is what old firmware looks like. |
| Insert + dedupe | `databaseService.coverageReceptions.recordReception` (P1) | Unchanged. First write wins per unique key. |
| Bounded cache | `LruCache` (`src/server/utils/lruCache.ts`) | Generic, tested. For the gateway position cache. |
| Per-source setting read | `databaseService.settings.getSettingForSource(sourceId, key)` | Namespaced `source:<id>:<key>` read, no global fallback. Avoids the #5080 bare-key trap. |
| Cache invalidation on save | Direct import, like `invalidatePkiDmGlobalCache` (`settingsRoutes.ts:992`); per-source branch next to `meshcoreReceiveOnly` (`settingsRoutes.ts:977`) | A save takes effect at once, no restart. |
| TTL flag cache shape | `MqttPacketLogService.isEnabled()` (`src/server/services/mqttPacketLogService.ts`) | Same idea, keyed per source. |
| Self-saving per-source toggle UI | `MeshCoreSettingsView` receive-only toggle (`src/components/MeshCore/MeshCoreSettingsView.tsx:255-297`): `csrfFetch` POST `/api/settings?sourceId=` | Avoids SettingsTab's save partition, which routes only Node Display keys per-source (`SettingsTab.tsx:1074-1110`). |
| MQTT source type (frontend) | `isMqttOnlySourceType` (`src/utils/nodeTransport.ts:34`) | Existing named helper; no new string gate. |
| Settings nav | `SOURCE_SETTINGS_SECTIONS`, `settingsNavItems`, `buildConfigSurfaces` (`src/components/search/configSections.ts`) | Existing section model. |
| Privacy gate | `buildPositionFilter` / `loadNodesBySource` (`src/server/utils/positionVisibility.ts`) | Already keyed `{sourceId, nodeNum}`; gateways are nodes of the MQTT source. No change. |
| Receiver list API | `/receivers` + `getReceivers` (P1, D8: derived from rows, no type gate) | Gateways appear with no route change to the gate. |
| MQTT source identity (server) | `isMqttConnectionStatusManager` (`src/server/sourceManagerTypes.ts:103`) over `sourceManagerRegistry.getAllManagers()` | Typed predicate for broker + bridge managers. No `source.type` string gate. |
| Batched per-source flag read | `databaseService.settings.getSettingForSources(ids, key)` (`src/db/repositories/settings.ts:264`) | One indexed `key IN (...)` read for all MQTT sources; per-source only, no global fallback. |
| Tests | `mqttIngestion.bitfield.test.ts` / `mqttIngestion.perSource.test.ts` (mock shape), `meshtasticManager.coverageReception.test.ts`, `coverageRoutes.test.ts` (harness), `coverageReceptions.multiBackend.test.ts` | Extend or copy. |

**New things, and why:**
- `src/server/utils/coverageMqtt.ts`: a pure evaluator (`evaluateMqttCoverageReception`). The skip rules are many; a pure function tests them without a DB.
- `src/server/services/coverageMqttSettings.ts`: the per-source TTL flag cache plus invalidation.
- `src/server/utils/coverageReceiverPositionCache.ts`: one bounded, throttled position cache for both the RF manager and MQTT gateways. It fixes P1 carry-over (b).
- `src/utils/coverageReceiverFilter.ts`: the receiver-filter wire format, shared by client builder and server parser.
- `src/components/Analysis/CoverageReceiverFilter.tsx` (+ module CSS): the scalable receiver picker.
- `src/components/Settings/CoverageMqttRecordingSection.tsx`: the self-saving per-source toggle.

---

## 2. File-by-file changes

### 2.1 Setting `coverage_mqtt_enabled` (per-source, default off)

- **Key:** `coverage_mqtt_enabled`. Stored per-source as `source:<id>:coverage_mqtt_enabled`. Value `'1'` on, anything else off (also accept `'true'`).
- **Shared constant (WP0, see §4):** `export const COVERAGE_MQTT_ENABLED_SETTING = 'coverage_mqtt_enabled'` and `export function isCoverageMqttFlagOn(raw: string | null | undefined): boolean` (`'1'` or `'true'`) in `src/utils/coverage.ts`. WP1 (route status) and WP2 (cache, allowlist) both import them; WP3 posts the key. Nobody hard-codes the string.
- **`src/server/constants/settings.ts`:**
  - Add to `VALID_SETTINGS_KEYS` next to `coverage_retention_days` (:130), comment "#5277 P2, per-source, MQTT sources only, default off".
  - Add to `PER_SOURCE_SETTINGS_KEYS` (:425).
  - **Not** in `GLOBAL_ONLY_SETTINGS_KEYS`: that list drops the key from per-source POSTs, the opposite of what we need.
  - A global (unscoped) write stores a junk row nobody reads. No code path writes it globally (§2.8 saves per-source only), so no guard is needed.
- **`src/server/services/coverageMqttSettings.ts` (new):**
  ```ts
  export async function isCoverageMqttEnabled(sourceId: string): Promise<boolean>
  export function invalidateCoverageMqttEnabled(sourceId?: string): void  // no arg = clear all
  export function __resetCoverageMqttCacheForTest(): void
  ```
  - `Map<sourceId, { value; expires }>`, TTL **30 s**. Read with `databaseService.settings.getSettingForSource(sourceId, 'coverage_mqtt_enabled')`. **Never the bare key** (#5080).
  - On a read error, cache `false` for the TTL and log at debug. Fail closed: no recording is the safe side.
  - The map holds one entry per MQTT source, so it needs no bound.
- **`src/server/routes/settingsRoutes.ts`:** in the per-source branch, next to `meshcoreReceiveOnly` (:977):
  ```ts
  if ('coverage_mqtt_enabled' in filteredSettings) invalidateCoverageMqttEnabled(sourceId);
  ```
  Import it directly (`../services/coverageMqttSettings.js`), as `invalidatePkiDmGlobalCache` is. No callback plumbing through `server.ts`.
- **Source delete:** no change. A stale cache entry for a deleted source does nothing, since no manager ingests for it. The `source:<id>:*` rows go with the source's settings cleanup, if one exists; do not add one here.

### 2.2 Shared receiver position cache: `src/server/utils/coverageReceiverPositionCache.ts` (new)

```ts
export interface ReceiverPos { lat: number | null; lon: number | null; }
export class CoverageReceiverPositionCache {
  constructor(opts?: { ttlMs?: number; failureTtlMs?: number; maxEntries?: number });
  get(sourceId: string, nodeNum: number): Promise<ReceiverPos>;  // never throws
  clear(): void;
}
export function nodeCoveragePosition(node: DbNode | null | undefined): ReceiverPos;
```
- Key `${sourceId}|${nodeNum}`, backed by `LruCache` (`maxEntries` default 2000).
- **Hit:** return the cached value while `now - at < ttlMs` (default 60 s).
- **Miss:** `databaseService.nodes.getNode(nodeNum, sourceId)` → `nodeCoveragePosition(node)`, the override-aware rule moved verbatim from `meshtasticManager.refreshCoverageReceiverPos` (`positionOverrideEnabled && latitudeOverride != null && longitudeOverride != null` → override, else live).
- **Failure (carry-over b):** a throw stores `{lat: null, lon: null}` stamped `now`, with `failureTtlMs` (default 60 s). A failed lookup is retried at most once per minute per receiver, not on every reception. If an older good value exists, keep it and push its `at` forward instead.
- **Single-flight:** a per-key in-flight `Promise` map, so ten copies from one gateway in one burst do one lookup.
- **`meshtasticManager.ts`:** replace the `coverageReceiverPos` field (:1158) and `refreshCoverageReceiverPos` (:5592) with a per-manager `new CoverageReceiverPositionCache({ maxEntries: 4 })`. In `maybeRecordCoverageReception` (:5549) use `const pos = await this.coverageReceiverPosCache.get(this.sourceId, localNodeNum)`. No behaviour change beyond the failure throttle. The existing `meshtasticManager.coverageReception.test.ts` must stay green.
- **MQTT:** one module-level instance in `coverageMqtt.ts` (or the ingest module), shared across MQTT sources. The source is part of the key.

### 2.3 Repository: `src/db/repositories/coverageReceptions.ts`

1. **`getReceptions`: replace `receiverIds?: string[]` with `receiverFilter?: CoverageReceiverFilterEntry[]`** (the type lives in `src/utils/coverageReceiverFilter.ts`, §2.5).
   - Entry: `{ sourceId; mode: 'include' | 'exclude'; receiverIds: string[] }`.
   - Build the source clause as `or(inArray(sourceId, unconstrainedSources), ...entryClauses)`:
     - `unconstrainedSources` = `sourceIds` minus the sources that have an entry.
     - include → `and(eq(sourceId, s), inArray(receiverId, ids))`.
     - exclude → `and(eq(sourceId, s), notInArray(receiverId, ids))`. `receiverId` is NOT NULL, so NOT IN has no NULL trap.
     - Drop entries whose `sourceId` is not in `sourceIds`. That keeps the permission intersection authoritative.
   - Omit empty `or()` parts. If nothing is left (every entry dropped and no unconstrained sources), return an empty page.
   - This fixes the P1 bug where `receivers=!abcd` matched that id on **every** source.
   - The only caller is `coverageRoutes.ts`. Update `coverageReceptions.test.ts` cases that pass `receiverIds`.
2. **`getReceivers`: remove the N+1.** P1 runs one follow-up query per receiver ("receivers are few"). With hundreds of gateways that is hundreds of queries per `/receivers` call.
   - Add to the one GROUP BY: `receptionCount: count()` and `lastSnapAt: MAX(CASE WHEN receiverLatitude IS NOT NULL THEN receivedAt END)`. Plain SQL, portable to all three DBs.
   - Fetch the snapshots in **one batched select per chunk of 200 groups** that have a `lastSnapAt`: `or(...chunk.map(g => and(eq(sourceId), eq(receiverKind), eq(receiverId), eq(receivedAt, g.lastSnapAt), isNotNull(receiverLatitude))))`. Take the first row per group key. The unique index prefix `(sourceId, receiverId, …)` serves the lookup.
   - Add `receptionCount: number` to `CoverageReceiverRow`.
   - The query count drops from 1 + N to 1 + ceil(N/200).

### 2.4 Types: `src/types/coverage.ts`

- `CoverageReceiverDto`: add `receptionCount: number` (rows in the retention window). The filter sorts gateways by it.
- New `CoverageMqttSourceStatusDto { sourceId: string; sourceName: string; recordingEnabled: boolean }`.
- `/receivers` response grows to `{ receivers, retentionDays, mqttSources: CoverageMqttSourceStatusDto[] }` (§2.7).
- No other DTO change. `receiverKind: 'mqtt_gateway'` already exists in the union.

### 2.5 Receiver filter wire format: `src/utils/coverageReceiverFilter.ts` (new, pure, shared)

The P1 client sends `receivers=<id>,<id>`. With hundreds of gateways, that list breaks: source ids are 36-char UUIDs, and Node's 16 KB header limit caps the URL.

- **Format** (`receivers` query param, replacing the P1 format):
  `<sourceId>:+<id>,<id>;<sourceId>:-<id>,<id>`
  - `+` = include only these receivers of that source.
  - `-` = all of that source's receivers except these.
  - A source that is fully selected gets no entry. A fully deselected source is left out of `sources`.
  - `URLSearchParams` encodes it.
- `export type CoverageReceiverFilterEntry = { sourceId: string; mode: 'include' | 'exclude'; receiverIds: string[] }`
- `export function encodeReceiverFilter(entries): string`
- `export function parseReceiverFilter(raw: unknown): CoverageReceiverFilterEntry[] | null`
  - `null` means malformed: bad grammar, a sourceId containing `:`, `;` or `,`, an id failing `^[!0-9A-Za-z_-]{1,80}$` (fits Meshtastic `!hex` now and P3 pubkey hex later), or more than **1000 ids in total**.
- `export function buildReceiverQuery(receivers: Array<{sourceId; receiverId}>, deselected: Set<string>): { sources?: string[]; receiverFilter?: CoverageReceiverFilterEntry[]; noneSelected: boolean }`
  - Compose keys as `${sourceId}|${receiverId}` (carry-over a).
  - Per source: all selected → no entry; none selected → drop the source from `sources`; partial → an include or exclude entry, **whichever list is shorter**.
  - `sources` is omitted when every source keeps at least one receiver. The server then uses all permitted sources.
  - If the encoded ids would pass 1000, return `receiverFilter: undefined` and a flag `clientSideFilter: true`. The hook then filters rows on the client. This is a rare edge case (a single source with over 2000 gateways, half selected); document it.
- Export `receiverKey(sourceId, receiverId)` for the UI.

### 2.6 Recording: `src/server/utils/coverageMqtt.ts` (new) + hook in `mqttIngestion.ts`

**Pure evaluator:**
```ts
export type MqttCoverageSkip =
  | 'no-gateway' | 'own-packet' | 'local-gateway' | 'own-node-gateway'
  | 'non-rf' | 'via-mqtt' | 'no-signal' | 'no-packet-id' | 'stale'
  | 'ok-to-mqtt-no' | 'ignored-gateway';
export function evaluateMqttCoverageReception(input: {
  sourceId: string; envelope: ServiceEnvelopeShape; fromNum: number;
  localGatewayNodeNum: number | null | undefined; nowMs: number;
  isOwnNodeNum: (n: number) => boolean; isIgnored: (n: number) => boolean;
}): { skip: MqttCoverageSkip } | { skip: null; gatewayNum: number; row: Omit<RecordCoverageReceptionParams, 'receiverLatitude'|'receiverLongitude'|'latitude'|'longitude'|'altitude'|'precisionBits'|'channel'|'receivedAt'> }
```
Skip rules, in order (each tested):
1. `gatewayNum = parseGatewayNodeNum(envelope.gatewayId)`. Null → `no-gateway`.
2. `fromNum === gatewayNum` → `own-packet`. The gateway's own position: rx_snr 0, rssi absent, `hop_start == hop_limit`. In the dev DB these are **18–31% of MQTT position rows**.
3. `gatewayNum === localGatewayNodeNum` → `local-gateway`. This is our own publish echoed back.
4. `isOwnNodeNum(gatewayNum)` → `own-node-gateway`. See §5 D3: the radio source already records this reception first-hand.
5. `packet.viaMqtt === true` → `via-mqtt`. Firmware never uplinks these (MQTT.cpp:743); this is belt and braces.
6. **Transport:** read `transportMechanism` only when it is an **own property** holding a number (protobufjs prototype defaults must not count). If present and `!isRfTransport(tm)` → `non-rf`. This catches UDP-multicast arrivals, which gateways do uplink with transport `MULTICAST_UDP`, snr 0 and no rssi. Absent (old firmware) → allowed.
7. **Signal:** `snr = normalize(rxSnr)` (−128 → null). If `snr === 0 && rssi == null` → `no-signal`. That pattern marks a local, UDP or pre-transport-field copy; `rx_snr` is a proto3 float with no presence bit. A real 0.0 dB reading with RSSI present is kept.
8. `packetId` missing or 0 → `no-packet-id`.
9. `isStaleCoverageRxTime(rxTime, nowMs)` → `stale`. Same 600 s rule as P1; see §5 D1 for MQTT numbers. An absent `rx_time` (gateway with no RTC; `optional fixed32`) is not stale.
10. `readBitfieldOkToMqtt(decoded.bitfield) === 'no'` → `ok-to-mqtt-no` (§5 D4). `'unknown'` is allowed.
11. `isIgnored(gatewayNum)` → `ignored-gateway`.

Row values (`receiverKind: 'mqtt_gateway'`):
- `receiverId: nodeNumToId(gatewayNum)`, `receiverNodeNum: gatewayNum`.
- `senderId`/`senderNodeNum`, `packetKey: String(packetId)`, `packetId`.
- `snr`, `rssi` (keep an explicit 0), `hopStart`, `hopLimit`, `relayNode` (own property only, else null).
- `hopsAway = computeMeshtasticHopsAway({ hopStart, hopLimit, hasBitfield: typeof decoded?.bitfield === 'number' })`. Server-decrypted packets carry `bitfield` on the synthesised `decoded` (`mqttIngestion.ts` ~264); plaintext uplinks carry it natively.
- `pathKey = meshtasticPathKey(relayNode, hopsAway)`.
- `transportMechanism`: the own-property value or null.
- `rxTime`: seconds or null.
- Firmware check: the uplinked MeshPacket is the gateway's received copy, byte for byte. rx_snr, rx_rssi, rx_time, hop_start, hop_limit (before the gateway's own decrement) and relay_node all survive. The "hop-limit upgrade" path can uplink a second copy of one id with different hops; a different `pathKey` records it as its own row, while a same-path repeat collapses.

**Extend `MeshPacketShape`** (`src/server/mqttPacketFilter.ts:37`) with optional `relayNode`, `transportMechanism`, `viaMqtt`. Types only.

**Hook** in the POSITION case, after the inline distance check (`mqttIngestion.ts:465-469`) and before the node upsert (:505):
```ts
if (!positionIsBogus && lat != null && lng != null) {
  void maybeRecordMqttCoverageReception({
    sourceId, envelope, fromNum, localGatewayNodeNum: input.localGatewayNodeNum,
    lat, lng, altitude: alt, precisionBits, channel: effectiveChannel, nowMs,
  });
}
```
- `maybeRecordMqttCoverageReception` (private to `mqttIngestion.ts`, or exported from `coverageMqtt.ts` for tests):
  - `try/catch`-wrapped and never throws; logs at debug.
  - Order: cheap sync guards first (gateway parse, own packet), **then** `await isCoverageMqttEnabled(sourceId)`, then the evaluator, then `await positionCache.get(sourceId, gatewayNum)`, then `recordReception`.
  - Why the sync guards come first: the evaluator is sync and cheap, but the flag read is a cached async call. Most sources have the flag off, so they should pay one cached map lookup and nothing more.
- Placement means geo-out, ignored sender, distance-dropped and bogus fixes are never recorded, matching what the node table keeps.
- `channel` stores `effectiveChannel` (`CHANNEL_DB_OFFSET + id` when resolved), the same value the node row gets.
- **No `dataEventEmitter` emit.** The `ingestServiceEnvelope` wrapper and packet-log call are unchanged.
- No manager type predicate is needed: only MQTT managers call this function. Do **not** add a `source.type` check.

### 2.7 Routes: `src/server/routes/coverageRoutes.ts`

- `/receptions`: parse `receivers` with `parseReceiverFilter`. Malformed → `fail(res, 400, 'INVALID_RECEIVERS', …)`. Pass `receiverFilter` to the repo. Remove the P1 CSV parse.
- `/receivers`:
  - Pass `receptionCount` through.
  - Replace `nodesBySource.get(...).find(...)` (O(receivers × nodes)) with a `Map<sourceId, Map<nodeNum, DbNode>>` built once.
  - The gateway name and position come from the MQTT source's own `nodes` rows. That is the same enrichment, with no change.
  - Visibility nulling stays as is: gateways have a non-null `receiverNodeNum`, so the P1 predicate already covers them.
- **`mqttSources` (user decision Q4), on the existing `/receivers` response.** One fetch, no new endpoint:
  - `mqttSourceIds = sourceManagerRegistry.getAllManagers().filter(isMqttConnectionStatusManager).map(m => m.sourceId)`, intersected with the caller's `sourceIds` (permitted ∩ `?sources=`). **Typed predicate only; never `source.type`.**
  - `flags = await databaseService.settings.getSettingForSources(mqttSourceIds, COVERAGE_MQTT_ENABLED_SETTING)`; `recordingEnabled = flags.get(id) === '1' || flags.get(id) === 'true'`. Per-source read, never the bare key. WP1 reads the table directly and does **not** import WP2's cache module, so the two packages stay independent and the report never shows a 30 s-stale flag.
  - `sourceName` comes from the `getAllSources()` result the handler already loads.
  - Returned even when the caller has no receptions yet; the empty state is where it matters most. When `sourceIds` is empty, `mqttSources: []`.
  - Limitation (document in code): a disabled or unregistered MQTT source is not in the registry, so it is not listed. It records nothing while disabled, so nothing is hidden.
- Permission stays per-source `nodes:read` through `resolvePermittedSourceIds`.

### 2.8 Settings UI: per-source toggle

- **`src/components/Settings/CoverageMqttRecordingSection.tsx`** (new) + `.module.css`:
  - Props `{ baseUrl; sourceId; canWrite }`.
  - Reads the current value from `GET /api/settings?sourceId=` (already merged per-source; nothing writes a global row, so no back-fill confusion).
  - A checkbox **"Record MQTT gateway receptions for the Coverage Report"**.
  - Saves on change with `csrfFetch` POST `/api/settings?sourceId=<id>` `{ coverage_mqtt_enabled: '1' | '0' }` (MeshCore receive-only pattern). Toast on success or failure.
  - **Warning next to the input, always visible (user decision U1; no cap):** "Each gateway that hears a position packet adds one row. A regional feed adds about 12,000–14,000 rows a day: about 90,000–100,000 rows (35–50 MB) over a 7-day retention. A world-wide `msh/#` feed can reach about 1 million rows a day and several GB a week. Rows are kept for the Coverage retention period, a global setting under Settings → Coverage Report." Link the last phrase to the global `settings-coverage` section.
  - Enabling asks `window.confirm` with the same numbers. Disabling needs no confirm.
  - After a successful save, invalidate the `['analysis','coverageReport','receivers']` query prefix so an open report's status updates.
  - Note under it: "Nodes that turn off 'OK to MQTT' are not uplinked by gateways on public brokers, so they won't appear. Rows only start from when you turn this on."
- **`src/components/SettingsTab.tsx`:** render `{show('settings-coverage-mqtt') && isMqttOnlySourceType(sourceType) && <CoverageMqttRecordingSection … />}` in the source-mode block. Take `sourceType` from `useSource()`, which the file already imports. It does **not** join `SettingsDraft` or `handleSave`, so the partition and `server.settings-persistence.test.ts` stay untouched.
- **`src/components/search/configSections.ts`:**
  - Add `'settings-coverage-mqtt'` to `SOURCE_SETTINGS_SECTIONS`.
  - Add a nav item (`t('settings.coverage_mqtt_section','Coverage recording')`, keywords `coverage`, `gateway`, `mqtt`, `survey`, `range test`).
  - Add `sourceType?: string | null` to `SettingsNavOptions` and filter the item with `isMqttOnlySourceType`.
  - Add it to `settingsWriteOnly`.
  - Thread `sourceType` through `ConfigSurfaceContext` / `buildConfigSurfaces` (:254) and the SettingsTab nav call (:1571), so the palette never links to a missing section.

### 2.9 Report UI

- **`src/components/Analysis/CoverageReceiverFilter.tsx`** (new) + `CoverageReceiverFilter.module.css`:
  - A trigger button: "Receivers: 12 of 340" (or "All receivers"). It opens an inline panel, not a modal, so it works at phone width.
  - Panel:
    - Search box matching long name, short name, `!id` and source name, case-insensitive.
    - "Select all" / "Select none" buttons. They act on the rows the search currently shows.
    - Groups by source: a header with the source name, a tri-state checkbox (`indeterminate` through a ref) and "n of m", collapsible.
    - Each row: checkbox, name (fallback `!id`), `!id`, a kind badge (**Local** or **Gateway**, from `receiverKind`), and the reception count. Rows sort by `receptionCount` descending.
  - Groups with more than 200 rows show the first 200 and a "Show all N" button. No virtualisation library.
  - State stays in the parent: `deselected: Set<string>` of `receiverKey(sourceId, receiverId)`. Default all selected; a new receiver shows up selected.
  - UiIcon only, CSS module, `var(--color-*)` with no fallback.
- **`CoverageReport.tsx`:**
  - Replace the checkbox list (:352-368) with `CoverageReceiverFilter`.
  - Key `deselectedReceiverIds` by composite key (carry-over a).
  - Use `buildReceiverQuery` to get `sources` / `receiverFilter`.
  - `fitKey` uses the sorted composite keys.
  - `noReceiversSelected` comes from `buildReceiverQuery().noneSelected`.
  - Add an info line under the filter, shown when any receiver has `receiverKind === 'mqtt_gateway'` or `mqttSources` is non-empty: gateway receptions come from what each gateway reports; nodes with OK to MQTT off won't appear.
  - **MQTT recording status (user decision Q4)**, rendered by `CoverageReceiverFilter` from `/receivers`' `mqttSources`: one row per MQTT source the user can read, with the source name, a status badge (**Recording** or **Off**), and, when off, a link "Turn on in source settings" to `/source/<encodeURIComponent(sourceId)>/settings#settings-coverage-mqtt` (the `buildConfigSurfaces` path shape). Shown even when the source has no receivers, and in the empty state. Hidden when `mqttSources` is empty.
  - **Truncation banner (Q1):** keep the 24 h default. Extend the existing `analysis.coverage.truncated` text to suggest a sender: "...narrow the time range or pick a sender to see the rest." 
  - Update the empty-state hint to say MQTT sources record only after the per-source toggle is on.
- **`src/services/analysisApi.ts` / `src/hooks/useCoverageData.ts`:**
  - `CoverageReceptionsFilters.receiverIds` → `receiverFilter?: CoverageReceiverFilterEntry[]` plus `clientSideFilter?: Set<string>`.
  - The fetcher sets `receivers` from `encodeReceiverFilter`, and `sources` when given.
  - When `clientSideFilter` is set, the hook drops non-matching rows after each page.
  - The query key includes the encoded string, not the Set.
- **`CoverageMap.tsx`:**
  - `receiverById` → `receiverByKey` keyed `receiverKey(sourceId, receiverId)` (carry-over a). The popup looks up with the reception's `sourceId`.
  - **Receiver markers:** dedupe by `receiverKind|receiverId`. The same gateway seen through two MQTT sources is one physical station; keep the entry with a position and the newest `lastReceivedAt`.
  - Gateway markers use a distinct style from local receivers (dashed stroke, smaller radius), with a Local/Gateway label in the tooltip.
  - Hundreds of permanent tooltips would bury the map. Make the tooltip permanent for local receivers only; gateways show it on hover.
  - **Popup:** collapse receptions of one fix that share `receiverKind|receiverId|pathKey` across sources into one line ("via Source A, Source B"). Show a Gateway badge on gateway lines.
- **`public/locales/en.json`:** `analysis.coverage.receivers_*`, `analysis.coverage.kind_local`, `analysis.coverage.kind_gateway`, `analysis.coverage.mqtt_note`, `settings.coverage_mqtt_*`.

---

## 3. Test plan (standard Vitest suite)

**Pure helpers**
- `src/server/utils/coverageMqtt.test.ts`, one case per skip rule in §2.6 order:
  - Missing or malformed gatewayId.
  - `from === gateway`.
  - Local gateway.
  - Own-node gateway.
  - `viaMqtt`.
  - Transport own-present UDP → skip; prototype-default 0 with no own property → allowed; LORA_ALT1 → allowed.
  - snr 0 with rssi null → skip; snr 0 with rssi −100 → kept with snr 0.
  - snr −128 → null.
  - packetId 0.
  - rxTime 11 min old → skip; rxTime absent → kept; rxTime in the future → kept.
  - Bitfield ok_to_mqtt clear → skip; unknown → kept.
  - Ignored gateway.
  - Happy path: full row with `receiverKind 'mqtt_gateway'`, `receiverId '!…'`, hopsAway and pathKey (3/1 → 2; 0/0 with bitfield 0 → 0 and `r0:h0`; 0/0 with no bitfield → null).
- `src/utils/coverageReceiverFilter.test.ts`:
  - Encode/parse round trip.
  - Rejects: bad sourceId characters, bad id, more than 1000 ids, empty grammar parts.
  - `buildReceiverQuery`: all selected → no filter and no sources; one source fully off → dropped from `sources`; partial picks the shorter of include/exclude; same receiverId on two sources is independent (carry-over a); noneSelected; over 1000 → `clientSideFilter`.
- `src/server/utils/coverageReceiverPositionCache.test.ts`:
  - TTL hit/miss with fake timers.
  - Override-aware position.
  - **A failed lookup is not retried inside `failureTtlMs`** (carry-over b), and a good older value survives a failure.
  - LRU bound.
  - Single-flight: 5 concurrent `get`s → 1 loader call.
  - Key isolation across sources.

**Setting + cache**
- `src/server/services/coverageMqttSettings.test.ts`:
  - Default false.
  - Reads through `getSettingForSource(sourceId, key)`, and **never** `getSettingAsync(bareKey)` (assert the bare-key mock is not called).
  - TTL caching: 2 reads → 1 DB call.
  - `invalidateCoverageMqttEnabled(id)` forces a re-read for that source only.
  - A read error → false.
- `settingsRoutes`: a per-source POST with `coverage_mqtt_enabled` persists `source:<id>:coverage_mqtt_enabled` and calls the invalidator for that source (harness test). The existing `settings.allowlist.test.ts` and `server.settings-persistence.test.ts` stay green.

**Recording**
- `src/server/mqttIngestion.coverage.test.ts` (mock shape from `mqttIngestion.bitfield.test.ts`; `recordReception` with `mockResolvedValue`):
  - **Opt-in off (default) → no `recordReception` call.**
  - On → one row per gateway: the same packet through 3 envelopes with 3 gatewayIds gives 3 calls with distinct `receiverId`s and each gateway's own SNR/RSSI.
  - The gateway's snapshot comes from `nodes` of **that** source.
  - A gateway with no node row or no position → null coordinates.
  - A geo-out, ignored-sender, distance-dropped or bogus fix records nothing.
  - A repo throw doesn't change the ingest result or skip the node upsert.
  - No coverage emit on `dataEventEmitter`.
  - A settings flip takes effect after `invalidateCoverageMqttEnabled`, with no manager restart.
- `src/server/mqttIngestion.coverage.perSource.test.ts`: sources A (on) and B (off) ingest the same envelope; only A records. Rows carry `sourceId` A. A gateway node row in B never feeds A's snapshot.
- `meshtasticManager.coverageReception.test.ts`: unchanged cases green after the cache swap. Add: a node lookup that throws twice within 60 s calls `getNode` once.

**Repository** (SQLite + `coverageReceptions.multiBackend.test.ts` on PG/MySQL, `isolationKey: 'covrx'` as today):
- `receiverFilter` include, exclude and mixed across sources.
- The same receiverId on two sources: include on A doesn't leak B.
- Entries for non-permitted sources are dropped.
- `getReceivers` with 250 or more receivers returns every snapshot correctly (crosses the 200 chunk) and `receptionCount`. Spy the query count: `1 + ceil(N/200)`.
- A receiver with no snapshot → null.
- PG/MySQL must run: start the containers, confirm `numPendingTests` covers the multiBackend file.

**Routes** (`coverageRoutes.test.ts`, `createRouteTestApp`):
- A gateway reception on an MQTT-type source appears in `/receivers` with `receiverKind 'mqtt_gateway'`, its node name and `receptionCount`.
- A limited user with `nodes:read` on A only never sees B's gateways (**per-source isolation**, exit criterion).
- The gateway's coordinates are nulled when the gateway node fails the visibility predicate (hidden from map; channel-DB `viewOnMap` not granted).
- `receivers` new grammar filters; malformed → 400 `INVALID_RECEIVERS`; more than 1000 ids → 400.
- The existing P1 cases pass after the param change (update any that use the old CSV).
- **`mqttSources` (Q4):** register fake managers in `sourceManagerRegistry` (one `sourceType: 'mqtt_broker'`, one `'mqtt_bridge'`, one Meshtastic TCP, one `meshcore_mqtt`), seed `source:<id>:coverage_mqtt_enabled`:
  - Only the broker and bridge sources appear; the TCP and MeshCore MQTT sources never do.
  - `recordingEnabled` true for `'1'` and `'true'`, false when absent.
  - A **global** bare-key `coverage_mqtt_enabled = '1'` row does **not** turn any source on (#5080 guard).
  - A limited user with `nodes:read` on the broker only never sees the bridge's status.
  - Listed even when the source has no receptions; `[]` for an anonymous user with no grants.
  - Unregister the fakes in `afterEach`.

**Frontend**
- `CoverageReceiverFilter.test.tsx`:
  - Search narrows rows.
  - Select all / none act on the visible rows only.
  - Source tri-state (indeterminate) toggles the group.
  - Kind badges.
  - Sort by count.
  - The "Show all" cap.
  - Two sources with the same receiverId toggle independently.
- `CoverageReport.test.tsx`: sends the encoded `receivers` and `sources`, and never the raw id list; shows the MQTT note when a gateway exists; the truncation banner mentions the sender filter.
- MQTT status (in `CoverageReceiverFilter.test.tsx` or `CoverageReport.test.tsx`): one row per `mqttSources` entry; an **Off** source shows a link to `/source/<id>/settings#settings-coverage-mqtt` (id URL-encoded); a **Recording** source shows no link; hidden when `mqttSources` is empty; shown in the empty state. `CoverageReport.queryStability.test.tsx` stays green (the encoded string is key-stable).
- `CoverageMap.test.tsx`: lookup by composite key; one marker per gateway across two sources; gateway marker style; popup collapses cross-source duplicates into one line with both source names.
- `useCoverageData.test.tsx`: client-side filter path.
- `CoverageMqttRecordingSection.test.tsx`: loads the value; enabling asks confirm and POSTs `?sourceId=` with `'1'`; cancel posts nothing; disabling posts `'0'` without confirm; the warning shows the measured numbers (12,000–14,000/day, 90,000–100,000 rows, 35–50 MB, ~1 million/day world-wide) and the global-retention link; a successful save invalidates the receivers query.
- `configSections.test.ts`: `settings-coverage-mqtt` appears only in source mode, for MQTT source types, with settings write.

**Exit gate:**
- Full suite with PG (5433) and MySQL (3307) up; check `success` and `numPendingTests`.
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v .claude/worktrees` is empty. The new `.tsx` files export components only (react-refresh rule), so helpers live in `src/utils`.
- Browser validation against the dev container with a live MQTT source toggled on:
  - Gateway receivers appear in the filter.
  - Search works.
  - Light and dark.
  - Phone width.
  - Screenshot for the PR.

---

## 4. Work packages

**Order:**
1. **WP0 (orchestrator, one tiny commit on `feature/coverage-p2-mqtt-gateways` before forking any worktree):** add `COVERAGE_MQTT_ENABLED_SETTING` and `isCoverageMqttFlagOn` to `src/utils/coverage.ts`, with two unit cases in `src/utils/coverage.test.ts`. That removes the only file WP1 and WP2 would otherwise both touch.
2. **WP1 and WP2 run in parallel, in separate worktrees** branched from the WP0 commit. The orchestrator merges both.
3. **WP3** starts after WP2 merges (it needs the allowlisted key and the invalidation).
4. **WP4** starts after WP1 merges (it needs the filter format, the DTOs and `mqttSources`).
5. **WP3 lands before WP4.** Both edit `public/locales/en.json`; the orchestrator rebases WP4.

**Shared files and merge plan (WP1 ∥ WP2):**

| File | WP1 | WP2 | Notes |
|---|---|---|---|
| `src/utils/coverage.ts` / `.test.ts` | import only | import only | Changed in WP0 only. Neither WP edits it. |
| `src/utils/coverageReceiverFilter.ts` (+test) | **owns** (new) | — | |
| `src/types/coverage.ts` | **owns** | — | WP2 needs no DTO change. |
| `src/db/repositories/coverageReceptions.ts` + its tests | **owns** | — | WP2 only calls the unchanged `recordReception`. |
| `src/server/routes/coverageRoutes.ts` + `coverageRoutes.test.ts` | **owns** | — | |
| `src/server/constants/settings.ts` | — | **owns** | WP1 never needs the key in `VALID_SETTINGS_KEYS` (that list gates writes only). |
| `src/server/routes/settingsRoutes.ts` | — | **owns** | |
| `src/server/services/coverageMqttSettings.ts` | — | **owns** (new) | WP1 must not import it (§2.7). |
| `src/server/utils/coverageReceiverPositionCache.ts`, `coverageMqtt.ts` | — | **owns** (new) | |
| `src/server/meshtasticManager.ts`, `mqttIngestion.ts`, `mqttPacketFilter.ts` | — | **owns** | |
| `src/server/sourceManagerTypes.ts`, `sourceManagerRegistry.ts` | import only | import only | No edits. |
| `public/locales/en.json` | — | — | Untouched by WP1/WP2 (server-only). |

With WP0 in place, WP1 and WP2 share **no edited file**; the merge is conflict-free by construction. The orchestrator runs the full suite on the merged result, since WP2's live rows and WP1's queries meet there for the first time.

**Other hazards:**
- WP1 and WP4: WP1 owns `coverageReceiverFilter.ts` and `types/coverage.ts`; WP4 only imports.
- WP2 and WP3: WP2 owns `constants/settings.ts` and `settingsRoutes.ts`; WP3 must not touch them.
- WP3 and WP4: both edit `en.json`; both edit nothing else in common (WP3: `SettingsTab.tsx`, `configSections.ts`, new Settings component; WP4: Analysis components, hooks, `analysisApi.ts`).

### WP0: shared constant (orchestrator)
- `COVERAGE_MQTT_ENABLED_SETTING`, `isCoverageMqttFlagOn` in `src/utils/coverage.ts` + tests.

### WP1: Query layer + API (parallel with WP2)
- `src/utils/coverageReceiverFilter.ts` (full, including `buildReceiverQuery`) + tests.
- Repo: `receiverFilter`, batched `getReceivers` + `receptionCount`.
- `src/types/coverage.ts`: `receptionCount`, `CoverageMqttSourceStatusDto`, `mqttSources` on the receivers response.
- Routes: `INVALID_RECEIVERS`, the node Map, `receptionCount`, **`mqttSources`** (typed-predicate discovery + `getSettingForSources`).
- Tests: repo (SQLite + multiBackend), route harness (incl. the `mqttSources` cases in §3), helper.

**Accept when:**
- Green on SQLite, PG and MySQL, with the multiBackend suite confirmed run.
- `getReceivers` query count bounded.
- MQTT sources are found only through `isMqttConnectionStatusManager`; `grep -n "type ===\|sourceType ===" src/server/routes/coverageRoutes.ts` is empty.
- The flag is read per-source only; a global bare-key row has no effect (tested).
- `ok`/`fail` with SCREAMING_SNAKE codes; `.js` import extensions.

### WP2: Recording + setting backend (parallel with WP1)
- `coverageReceiverPositionCache.ts` + the meshtasticManager swap (carry-over b).
- `coverageMqttSettings.ts` + key in VALID and PER_SOURCE + the invalidation in `settingsRoutes.ts`.
- `coverageMqtt.ts` evaluator + the hook in `mqttIngestion.ts` + the `MeshPacketShape` fields.
- Tests: evaluator, cache, setting, ingestion (on/off/per-gateway), perSource, settingsRoutes, and the P1 manager regression.

**Accept when:**
- Default off proven.
- The bare key is never read.
- A save applies without restart.
- The hot path does one cached lookup when off.
- A repo failure never breaks ingest.
- No events.
- Dev container: toggling on a live MQTT source produces `mqtt_gateway` rows within a minute; toggling off stops them at once after a save (30 s at worst without the save hook).

### WP3: Settings UI (after WP2; lands before WP4)
- `CoverageMqttRecordingSection` + CSS module, with the U1 warning text (measured numbers + global-retention link), confirm on enable, receivers-query invalidation after save.
- SettingsTab render.
- configSections (section set, nav item, `sourceType` option, palette threading). The `#settings-coverage-mqtt` anchor must exist, since WP4 links to it.
- `settings.coverage_mqtt_*` locale keys.
- Tests.

**Accept when:**
- The section appears only on MQTT sources for writers.
- The warning sits next to the input and quotes the §5 U1 numbers.
- Enable asks confirm.
- The POST is per-source.
- The SettingsTab draft/save partition is untouched.
- lint:ci clean.

### WP4: Report UI (after WP1; rebases on WP3)
- `CoverageReceiverFilter` + CSS module, including the **MQTT recording status block** (Recording / Off + settings link).
- CoverageReport wiring (composite keys, `buildReceiverQuery`, MQTT note, empty-state text, truncation banner suggesting a sender).
- analysisApi / useCoverageData param change + the client-side fallback + the `mqttSources` field.
- CoverageMap (composite lookup, marker dedupe, gateway style, hover tooltips, popup collapse). **No `preferCanvas`** (deferred).
- `analysis.coverage.*` keys.
- Tests.
- Browser validation + screenshot, including an MQTT source shown Off with a working link to its settings section, then On after toggling.

**Accept when:**
- It scales to 500 receivers without lag (render test with 500 fixtures).
- No raw fetch, no emoji, CSS modules only.
- Carry-over (a) is fixed in both the Report and the Map.
- The status link lands on the source's Coverage recording section.
- Tests green; lint:ci clean.

---

## 5. Decisions (final)

### User decisions (2026-09-24)

- **U1 = A: no write cap for MQTT sources.** Opt-in (default off) plus the one global retention bounds the table. No trim method, no rate limit, no per-source retention.
  - Measured on the dev container's `mqtt_packet_log` (position rows, own-packet rows removed):

    | Source | Gateways carrying positions | Rows/day | Rows per 7-day retention |
    |---|---|---|---|
    | Florida MQTT (bridge, regional) | 77 | ~12,400 | ~87,000 |
    | Yeraze MQTT Broker (embedded) | 99 | ~14,200 | ~99,000 |
    | Official MQTT (bridge, topic-filtered) | 90 | ~1,900 | ~13,500 |

    Each position packet reaches 1.3–1.9 gateways on average (max 13). About 100k rows ≈ 35–50 MB with indexes. An unfiltered world-wide `msh/#` feed was not measured; estimated ~1M rows/day and several GB per week.
  - **The toggle warning must quote these numbers** (regional ~12–14k rows/day, ~90–100k rows / ~35–50 MB per 7-day retention; world-wide `msh/#` up to ~1M rows/day and several GB per week) and remind that retention is the global Coverage setting (§2.8). Confirm-on-enable stays.
- **Q1: keep the 24 h default.** The truncation banner suggests a sender filter (§2.9).
- **Q2: no `preferCanvas` in P2.** Recorded as a follow-up in `COVERAGE_REPORT_EPIC.md`.
- **Q3: sender search deferred to P4.**
- **Q4: live per-source recording status in the report.** `/receivers` gains `mqttSources: [{ sourceId, sourceName, recordingEnabled }]` (WP1, §2.7), limited to MQTT sources the caller can read, found with `isMqttConnectionStatusManager` over the registry and read with `getSettingForSources` (per-source only). The receiver filter shows Recording / Off with a link to the source's settings when off (WP4, §2.9). I chose to extend `/receivers` rather than add an endpoint: the report already loads it on mount and on Refresh, so no extra request and no extra query key.

### Architect decisions

- **D1: Keep the P1 600 s stale rule for MQTT.**
  - Measured share of MQTT position rows with rx_time more than 10 min old: Florida 4.6%, Broker 5.6%, Official 35%.
  - Causes: gateways with wrong clocks (max lag 149 days), and firmware's MQTT queue (16 entries) flushing late after a broker drop.
  - Late rows would carry a server `receivedAt` far from the real receive time and land in the wrong survey window, so dropping them is right.
  - Gateways with no RTC send no rx_time and are kept. rx_time in the future (clock ahead) is kept.
  - If field data later shows real receptions lost, the fallback is to skip the rule for MQTT and rely on the unique key.
- **D2: Hook placement.** Record after the geo, ignore and distance gates and only for non-bogus fixes: coverage never shows a node the node table refused.
- **D3: Skip gateways that are one of our own radio sources' nodes** (`isOwnNodeNum`). Say a user's TCP radio also uplinks to their embedded broker. Without the skip, the Coverage popup lists that radio twice with identical SNR. The radio source already records it first-hand. Fail-open when the registry is empty.
- **D4: Honour ok_to_mqtt = 0.** When the bitfield is readable and the bit is clear, a gateway broke the originator's wish by uplinking. Don't record it. Unknown (encrypted and undecryptable) is recorded. This matches the UI note.
- **D5: Per-source opt-in lives in the settings table**, `source:<id>:coverage_mqtt_enabled`, not in `sources.config`. A source config save restarts the MQTT manager and drops broker clients (see #5264); a settings row needs no restart. Read per-source only (#5080). Cache 30 s + explicit invalidation on save.
- **D6: The toggle is a self-saving section** (MeshCore receive-only pattern), not a `SettingsDraft` field. SettingsTab's save sends every non-Node-Display key to the **global** endpoint, even in source mode. Joining the draft would mean changing that partition and its persistence test.
- **D7: Receivers are keyed `(sourceId, receiverId)` everywhere** in filters and lookups (carry-over a). **Map markers and popup lines collapse across sources** by `receiverKind|receiverId`: one physical gateway is one marker.
- **D8: A new `receivers` wire format** (`src:+ids;src:-ids`, shorter-of include/exclude, 1000-id cap, client-side fallback). It is not backward compatible with the P1 CSV; the P1 frontend is the only consumer and ships in the same PR.
- **D9: `getReceivers` goes batched** (1 + ceil(N/200) queries). P1's "receivers are few" assumption no longer holds.
- **D10: No schema change**, so no migration and no hand-written PG/MySQL DDL edits.
- **D11: The receiver position cache is shared and fixes carry-over (b)**: failures are cached for 60 s, lookups are single-flight, and the LRU caps it at 2000 entries.


### Deferred

- Map canvas rendering (`preferCanvas`) — follow-up (Q2).
- Sender search — P4 (Q3).
