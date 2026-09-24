# Transport Breakdown — Phase 3 Implementation Spec (#5101)

Branch `feature/5101-p3-device-counters` (off `origin/main` at `7a9057f9`,
which holds Phases 1 and 2). Binding decisions live in
`TRANSPORT_BREAKDOWN_EPIC.md`, and the Phase 3 answers are in §9. This spec
turns Phase 3 into work packages. Every claim below was checked against the
tree. Line numbers are approximate.

**No migration. No packets sent.** The writer adds two server timers, and no
setting drives either one: a 5-minute flush aligned to the clock, and a
30-second checkpoint of the bin in progress. Section 6 checks both against the
mesh impact checklist.

---

## 0. Findings that shaped the plan

1. **MeshMonitor-computed telemetry already exists, and it is the pattern to
   copy.** `saveSystemNodeMetrics()` (`src/server/meshtasticManager.ts`
   ~3632-3674) writes `systemNodeCount` / `systemDirectNodeCount` rows into
   the ordinary `telemetry` table, keyed to the local node's
   `nodeId`/`nodeNum` and the source's `sourceId`. Those rows show up in the
   Info tab's Local Node Telemetry graphs, can be starred onto the Dashboard,
   get 7-day retention (longer when favorited), and ride along in
   backup/restore, all for free. The new series use the same table. That
   means **no migration and no new route**: `GET /api/telemetry/:nodeId`
   already returns every type for the node, source-scoped by
   `requireSourceId('query')`.

2. **Node rows hold only the last stamp per transport, so history cannot be
   rebuilt.** `transportLastRf/Mqtt/Udp` (mig 126) are overwritten on every
   packet (`meshtasticManager.ts` ~6405, `transportColumnForPacket`). A time
   series of "nodes heard per transport" therefore needs a writer that takes
   a sample each bin. A sample taken at a bin's end, counting nodes whose
   stamp falls in `(binStart, binEnd]`, is **exact** for that bin. A node heard
   in the bin has a last stamp at or after that moment and at or before the
   bin's end. The stamps live in the DB, so this half needs no checkpoint.

3. **`packet_log` cannot carry a 24-hour chart on default settings** (why the
   user chose the counter, §9 D1). The Packet Monitor is opt-in, and its
   default cap is 1,000 rows **across all sources combined**
   (`enforcePacketLogMaxCount`, `src/db/repositories/packetLog.ts` ~227). On a
   busy mesh that holds under an hour.

4. **The existing systemNodeCount writer rides the LocalStats scheduler, which a
   save re-arms.** `setLocalStatsInterval()` → `startLocalStatsScheduler()`
   fires `saveSystemNodeMetrics()` 30 s later on every call, and the writer
   stops when the interval is 0. The new writer must **not** piggy-back there.
   It gets its own timers, and no setting touches them.

5. **The LocalStats "(Device)" labels are English-only and not in i18n.**
   `TELEMETRY_LABELS` (`src/components/TelemetryChart.tsx` ~85-120) holds
   `'Packets RX (Device)'` etc. with no `TELEMETRY_LABEL_KEYS` entry, and
   `TelemetryGraphs.tsx` ~238 calls `getTelemetryLabel` (English fallback)
   directly. The Info-tab keys `info.packets_tx`, `info.packets_rx` and
   `info.radio_statistics` **are** translated in fr, pl, ru, id, zh_Hans and
   zh_Hant. Changing the English *value* of an existing key would leave those
   six locales without the device distinction. **Add new keys for new text,
   and do not reword existing keys.** New keys fall back to English
   (`fallbackLng: 'en'`, `returnEmptyString: false`, `src/config/i18n.ts`).
   Do not edit non-English locale files; Weblate owns them.

6. **Packet Rate charts are device counters too, and the Dashboard copy drops the
   source.** `PacketRateGraphs.tsx` (Info tab) and `PacketRateChart.tsx`
   (Dashboard) plot rates derived from `numPacketsRx`/`numPacketsTx`.
   `PacketRateChart` calls `usePacketRates({ nodeId, hours, baseUrl })`
   **without `sourceId`**, so the rates route falls back to `ALL_SOURCES`
   (`telemetryRoutes.ts` ~153). The fix is in scope (D6).

7. **Favoriting a pseudo-type does not protect its component rows.**
   `buildFavoriteRetentions` (`src/utils/telemetryRetention.ts` ~96) keys
   retention on the favorite's literal `telemetryType`. The existing
   `packetRateRx`/`packetRateTx` favorites never match a stored row, so their
   `numPackets*` history is purged at 7 days whatever the user set. The fix is
   in scope (D7).

8. **Telemetry inserts fan out nothing.** `dataEventEmitter.emitTelemetry`
   has no production callers. `insertTelemetryAsync`
   (`src/services/database.ts` ~2033) only writes and invalidates the types
   cache.

9. **Synthetic rows can be made idempotent through the existing unique index.**
   Migration 032 added a unique index on
   `telemetry(sourceId, nodeNum, packetId, telemetryType) WHERE packetId IS NOT NULL`
   (MySQL: a full unique index, and NULLs still coexist). `insertTelemetry`
   uses `insertIgnore`. Giving each computed row a deterministic
   `packetId` = **bin index** makes a second write of the same bin a no-op on
   all three backends. **The first write wins**, so a bin's rows must never be
   written before the bin closes (invariant I1, §3.4).

10. **The checkpoint belongs in a per-source settings row, with no migration.**
    `autoAnnounceService` already persists scheduler state this way:
    `settings.setSourceSetting(sourceId, 'lastAnnouncementTime', …)`
    (`autoAnnounceService.ts` ~251), and CLAUDE.md cites it as the model for
    timer state that must survive a restart. `setSourceSetting` is an upsert on
    all three backends. `getSettingForSources(ids, key)`
    (`src/db/repositories/settings.ts` ~264) reads every source's row in one
    query, **with no global-key fallback**. The key is listed the same way
    `lastAnnouncementTime` is: in `PER_SOURCE_SETTINGS_KEYS` (~587) and in
    `PER_SOURCE_KEYS_NOT_POSTABLE` (~767, "server-managed bookkeeping"), and
    not in `VALID_SETTINGS_KEYS`, so no client can POST it.
    Alternatives rejected:
    - a dedicated table needs a 3-backend migration (it would be 172), plus
      backup/restore wiring, for one small row per source;
    - a provisional telemetry row cannot be updated, because `insertIgnore`
      keeps the first write, and a partial row would then shadow the final
      count forever (finding 9).

---

## 1. Reuse inventory (use these; justify anything new)

| Need | Reuse | Where |
|---|---|---|
| Transport class type, classifier | `NodeTransportClass`, `classifyNodeTransport` | `src/utils/nodeTransport.ts` ~119 |
| Stamp-column map | `TRANSPORT_LAST_COLUMN` | same, ~81 |
| MQTT-only hide rule | `isMqttOnlySourceType(sourceType)` | same |
| TCP-manager filter | `isMeshtasticManager(m)` (`sourceType === 'meshtastic_tcp'`) | `src/server/sourceManagerTypes.ts` ~83 |
| Manager enumeration | `sourceManagerRegistry.getAllManagers()`, `getStatus().connected`, `getLocalNodeInfo()` | `src/server/sourceManagerRegistry.ts` |
| Source list at boot | `databaseService.sources.getAllSources()` | `src/db/repositories/sources.ts` ~54 |
| Persisted per-source state | `settings.setSourceSetting` / `getSettingForSources` | `src/db/repositories/settings.ts` ~264, ~292 |
| Server-managed key listing | `PER_SOURCE_SETTINGS_KEYS` + `PER_SOURCE_KEYS_NOT_POSTABLE` (mirror `lastAnnouncementTime`) | `src/server/constants/settings.ts` |
| Replay guard (skip stale receptions) | `resolveLastHeardSec(rxTime, now)` returns `undefined` for replays | `src/server/utils/replayGuard.ts` ~69 |
| Radio transport resolution | `resolveRadioPacketTransport(meshPacket)` (already computed as `txMech` at the stamp site) | `src/server/constants/meshtastic.ts` |
| Computed-telemetry precedent | `saveSystemNodeMetrics()` row shape | `meshtasticManager.ts` ~3632 |
| Idempotent insert | `databaseService.insertTelemetryAsync(row, sourceId)` → `insertIgnore` + types-cache invalidation | `src/services/database.ts` ~2033 |
| Raw (un-averaged) fetch for integer types | `TelemetryRepository.RAW_VALUE_TYPES` (SQLite and PG/MySQL paths both read it) | `src/db/repositories/telemetry.ts` ~1159 |
| Source-scoped count | `withSourceScope(table, sourceId)` | `src/db/repositories/base.ts` |
| Telemetry fetch hook | `useTelemetry({ nodeId, hours, baseUrl, sourceId })` | `src/hooks/useTelemetry.ts` ~88 |
| Favorite star + toggle | `useFavorites`, `useToggleFavorite` | `src/hooks/useFavorites.ts` |
| Info-tab multi-line chart with stars | `PacketRateGraphs.tsx` (structure; `graph-container`/`graph-header`/`favorite-btn` classes) | `src/components/` |
| Dashboard pseudo-type card | `PacketRateChart.tsx` + `isPacketRateType` branch | `src/components/`, `DashboardGrid.tsx` ~205 |
| Transport colours | RF `var(--chart-1)`, UDP `var(--chart-6)`, MQTT `var(--chart-4)` | `src/components/survey/NetworkSurveyPanel.module.css` ~121-131 |
| CSS var as recharts stroke | `stroke="var(--color-warning)"` precedent | `src/components/Analysis/SolarMonitoringReport.tsx` ~630 |
| Transport labels | `transport.rf|udp|mqtt` keys (P1) | `public/locales/en.json` |
| Category of a telemetry type | `telemetryCategory.ts` map (`'network'`) | `src/utils/telemetryCategory.ts` ~120 |
| Retention builder | `buildFavoriteRetentions` | `src/utils/telemetryRetention.ts` |
| Route tests | `createRouteTestApp` | `src/server/test-helpers/routeTestApp.ts` |
| PG/MySQL fixtures | `createPostgresBackend(ddl, isolationKey)` / `createMysqlBackend` / `createIsolated*Database` | `src/db/repositories/test-utils.ts` |
| Icons | `UiIcon` only | `src/components/icons` |

New things, and why nothing existing fits:

- **`src/utils/transportSeries.ts`**: the contract between the writer and the
  charts. It holds the type names, pseudo favorite types, bin length, row
  builder, checkpoint codec and chart-row reshaper. It is pure, so both server
  and client import it.
- **`src/utils/deviceCounters.ts`**: `DEVICE_COUNTER_TYPES` + `isDeviceCounterType()`.
- **`NodesRepository.countNodesHeardByTransport()`**: no existing query counts
  per-transport stamps in a window.
- **`src/server/services/transportTrafficService.ts`**: the counter, the
  checkpoint and the aligned flush. `meshtasticManager.ts` is already ~7,000
  lines, and the one scheduler it could share (LocalStats) is the wrong one
  (finding 4).
- **`DeviceCounterNote.tsx` + module CSS**: one muted caption line, used in six places.
- **`TransportSeriesPlot.tsx`** (shared recharts body),
  **`TransportSeriesGraphs.tsx`** (Info tab) and **`TransportSeriesChart.tsx`**
  (Dashboard), plus one CSS module. The plot body is shared, not duplicated:
  PacketRateGraphs and PacketRateChart each carry an identical copy of
  `mergeRateData`, and this code must not repeat that.

---

## 2. Part A — label the device counters (D4)

Keep the short `(Device)` suffix in chart titles, and add a **visible one-line
muted caption** wherever a device counter is drawn. Nothing is tooltip-only,
since phones cannot hover.

New `public/locales/en.json` keys:
```
"info.device_counters_note": "The node counts these itself, across every transport (RF, UDP and MQTT), so they cannot be split.",
"telemetry.device_counter_note": "Device counter: all transports combined",
```

| Widget | File | Change |
|---|---|---|
| Network Statistics "Packets TX / RX" | `InfoTab.tsx` ~677-682 | After the Packets RX `<p>`, inside the same fragment: `<DeviceCounterNote text={t('info.device_counters_note')} testId="info-packets-device-note" />` |
| Radio Statistics donuts | `InfoTab.tsx` ~761 | Directly under the `info.radio_statistics` h3: `<DeviceCounterNote text={t('info.device_counters_note')} testId="info-radio-device-note" />` |
| Packet Rate Trends (Info) | `PacketRateGraphs.tsx` ~320 | Under the `telemetry-title` h3 (success branch): `<DeviceCounterNote text={t('telemetry.device_counter_note')} />` |
| Packet Rate card (Dashboard) | `PacketRateChart.tsx` | Same caption under the header. **Also** `const { sourceId } = useSource();`, passed to `usePacketRates` (D6). |
| Local Node Telemetry / node detail graphs | `TelemetryGraphs.tsx` `TelemetryGraphWidget` ~315 | After the `graph-header` div: `{isDeviceCounterType(type) && <DeviceCounterNote text={t('telemetry.device_counter_note')} />}` |
| Dashboard telemetry cards | `TelemetryChart.tsx` header | Same condition on `favorite.telemetryType`. |
| Unified Telemetry page (D8) | `src/pages/UnifiedTelemetryPage.tsx` ~52-57 `TYPE_LABELS` | `'Nodes Online (Device)'`, `'Packets TX (Device)'`, `'Packets RX (Device)'`, `'Bad RX (Device)'`, `'Dup RX (Device)'`. The map is English-only today, so leave it untranslated. |

`src/utils/deviceCounters.ts`:
```ts
/**
 * Firmware LocalStats traffic counters (#5101 Phase 3). The firmware keeps one
 * counter per metric across every transport, so these can never be split into
 * RF / UDP / MQTT. UI surfaces them with a DeviceCounterNote caption.
 */
export const DEVICE_COUNTER_TYPES: ReadonlySet<string> = new Set([
  'numOnlineNodes', 'numTotalNodes',
  'numPacketsTx', 'numPacketsRx', 'numPacketsRxBad', 'numRxDupe',
  'numTxRelay', 'numTxRelayCanceled', 'numTxDropped',
]);
export function isDeviceCounterType(type: string): boolean {
  return DEVICE_COUNTER_TYPES.has(type);
}
```
Heap, noise floor and uptime stay out: they are device metrics, but not traffic.

`src/components/DeviceCounterNote.tsx` must export only the component (the
react-refresh lint rule):
```tsx
export interface DeviceCounterNoteProps { text: string; testId?: string }
export default function DeviceCounterNote({ text, testId }: DeviceCounterNoteProps) {
  return <p className={styles.note} data-testid={testId}>{text}</p>;
}
```
`DeviceCounterNote.module.css`: `.note { margin: 0.1rem 0 0.4rem; font-size: 0.8em; color: var(--color-text-muted); }`
Use no fallback values.

---

## 3. Part B — MeshMonitor-computed per-transport series

### 3.1 What gets stored

Per Meshtastic TCP source, per **5-minute bin** (D2), one telemetry row per
series per class. That is six rows per bin, all with
`nodeId`/`nodeNum` = the source's local node, `timestamp` = bin end (ms),
`createdAt` = now, `packetId` = bin index, and `unit` = `undefined`.

| telemetryType | value |
|---|---|
| `systemNodesHeardRf` / `…Udp` / `…Mqtt` | distinct nodes (excluding the local node) whose `transportLast<Class>` ∈ `(binStartSec, binEndSec]`. Additive: a node heard two ways counts in both (D3). |
| `systemPacketsRxRf` / `…Udp` / `…Mqtt` | packets received in the bin, each counted once under its class |

### 3.2 `src/utils/transportSeries.ts` (WP1)

```ts
import type { NodeTransportClass } from './nodeTransport.js';

/** Bin length for the computed series (#5101 P3, user decision). Wall-clock aligned. */
export const TRANSPORT_SERIES_BIN_MS = 5 * 60 * 1000;
/** How often the in-progress bin's packet counts are checkpointed to the DB. */
export const TRANSPORT_CHECKPOINT_INTERVAL_MS = 30 * 1000;
/** Per-source settings key holding the checkpoint (server-managed, not POST-able). */
export const TRANSPORT_CHECKPOINT_SETTING_KEY = 'transportTrafficCheckpoint';

export type TransportSeriesKind = 'nodesHeard' | 'packetsRx';
export const TRANSPORT_SERIES_TYPES: Record<TransportSeriesKind, Record<NodeTransportClass, string>> = {
  nodesHeard: { rf: 'systemNodesHeardRf', udp: 'systemNodesHeardUdp', mqtt: 'systemNodesHeardMqtt' },
  packetsRx:  { rf: 'systemPacketsRxRf',  udp: 'systemPacketsRxUdp',  mqtt: 'systemPacketsRxMqtt' },
};
export const TRANSPORT_SERIES_COMPONENT_TYPES: readonly string[] = [/* the six above */];

export const TRANSPORT_NODES_HEARD_TYPE = 'transportNodesHeard';
export const TRANSPORT_PACKETS_RX_TYPE = 'transportPacketsRx';
export const TRANSPORT_SERIES_PSEUDO_TYPES: Record<string, TransportSeriesKind> = {
  [TRANSPORT_NODES_HEARD_TYPE]: 'nodesHeard',
  [TRANSPORT_PACKETS_RX_TYPE]: 'packetsRx',
};
export function isTransportSeriesType(t: string): boolean;          // pseudo types
export function isTransportSeriesComponentType(t: string): boolean;  // stored types

export interface TransportCounts { rf: number; udp: number; mqtt: number }

export function binStartOf(ms: number): number;       // floor(ms / BIN) * BIN
/** Bin index, used as the rows' synthetic packetId, so re-writes are no-ops. */
export function transportBinIndex(binEndMs: number): number; // floor(binEndMs / BIN)

/** The six rows for one source and one bin. Pure; the service inserts them. */
export function buildTransportSeriesRows(args: {
  nodeId: string; nodeNum: number; binEndMs: number; nowMs: number;
  nodesHeard: TransportCounts; packetsRx: TransportCounts;
}): Array<{ nodeId: string; nodeNum: number; telemetryType: string; timestamp: number;
            value: number; createdAt: number; packetId: number }>;

/** Checkpoint codec. Stored as JSON in the per-source settings row. */
export interface TransportCheckpoint {
  v: 1; binStartMs: number; nodeId: string; nodeNum: number;
  rf: number; udp: number; mqtt: number;
}
export function encodeTransportCheckpoint(cp: TransportCheckpoint): string;
/** Returns null (never throws) for bad JSON, wrong `v`, a binStartMs not aligned
 *  to the bin, or counts that are not finite non-negative integers. */
export function decodeTransportCheckpoint(raw: string | null | undefined): TransportCheckpoint | null;

/** Reshape fetched telemetry into chart rows [{ timestamp, rf, udp, mqtt }],
 *  sorted, with null for a missing class. Ignores other types. When the row count
 *  exceeds `maxPoints` (default 500), average adjacent bins so the unit stays
 *  "per 5-minute slot", and return `{ rows, averaged: true }`. */
export function toTransportChartRows(
  rows: Array<{ telemetryType: string; timestamp: number; value: number }>,
  kind: TransportSeriesKind, maxPoints?: number,
): { rows: Array<{ timestamp: number; rf: number | null; udp: number | null; mqtt: number | null }>; averaged: boolean };
```

WP1 also:
- adds the six component types to `TelemetryRepository.RAW_VALUE_TYPES`
  (`telemetry.ts` ~1159). The server never averages them, and the client
  handles long windows (above);
- adds `network` category entries for the six types in `telemetryCategory.ts`;
- extends `telemetryRetention.ts` (D7) with an expansion map, applied in both
  loops of `buildFavoriteRetentions` (one retention per component type):
```ts
/** Favorites that name a derived chart, not a stored type (#5101 P3). */
const FAVORITE_COMPONENT_TYPES: Record<string, readonly string[]> = {
  transportNodesHeard: ['systemNodesHeardRf', 'systemNodesHeardUdp', 'systemNodesHeardMqtt'],
  transportPacketsRx:  ['systemPacketsRxRf', 'systemPacketsRxUdp', 'systemPacketsRxMqtt'],
  packetRateRx: ['numPacketsRx', 'numPacketsRxBad', 'numRxDupe'],
  packetRateTx: ['numPacketsTx', 'numTxDropped', 'numTxRelay', 'numTxRelayCanceled'],
};
```
  Use string literals, since the module stays dependency-free. A unit test pins
  them to the `transportSeries.ts` constants and to `PACKET_RATE_RX_TYPE` /
  `PACKET_RATE_TX_TYPE`.

### 3.3 Nodes-heard count — `NodesRepository.countNodesHeardByTransport` (WP1)

`src/db/repositories/nodes.ts`, beside `getNodeCount` (~389):
```ts
/**
 * Distinct nodes whose per-transport "last heard" stamp (#4240, mig 126) falls in
 * (fromSec, toSec]. Additive: a node heard over two transports counts in both.
 * Excludes `excludeNodeNum` (the local node). NULL stamps never count.
 */
async countNodesHeardByTransport(
  sourceId: string, fromSec: number, toSec: number, excludeNodeNum?: number,
): Promise<TransportCounts>
```
Build one Drizzle `select` with three
`sum(case when <col> > from and <col> <= to then 1 else 0 end)` over
`nodes.transportLastRf/Udp/Mqtt`, and
`where(and(withSourceScope(nodes, sourceId), ne(nodes.nodeNum, excludeNodeNum)))`.
Coerce each result with `Number(… ?? 0)`: PG returns strings and MySQL returns
decimals. The stamp columns are BIGINT on PG/MySQL. `sourceId` is required.

### 3.4 Writer — `src/server/services/transportTrafficService.ts` (WP3)

```ts
interface BinState extends TransportCounts {
  binStartMs: number;
  nodeId: string | null; nodeNum: number | null;  // local-node identity, when known
  dirty: boolean;                                   // changed since last checkpoint
}

export class TransportTrafficService {
  /** sourceId → binStartMs → state. Holds the in-progress bin plus, briefly, the
   *  one just closed (a packet can land after a boundary, before its flush). */
  private bins = new Map<string, Map<number, BinState>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(private readonly deps: {
    getManagers: () => ISourceManager[];
    db: Pick<typeof databaseService, 'insertTelemetryAsync' | 'nodes' | 'settings' | 'sources'>;
    now?: () => number;
  }) {}

  async start(): Promise<void>   // restore/recover checkpoints, then arm both timers; idempotent
  async stop(): Promise<void>    // clear timers, then checkpoint every dirty bin; never throws
  recordRx(sourceId: string, cls: NodeTransportClass): void   // sync, O(1), never throws
  async flush(binEndMs: number): Promise<void>                 // public for tests
  async checkpointAll(): Promise<void>                         // public for tests
}
export const transportTrafficService = new TransportTrafficService({
  getManagers: () => sourceManagerRegistry.getAllManagers(),
  db: databaseService,
});
```

**Invariant I1: never write a bin's telemetry rows before the bin closes.**
The 032 index keeps the first write (finding 9), so an early write would
freeze a partial count.

**Start (restore and recover).** `start()` runs before any manager connects
(see wiring):
1. `ids = (await db.sources.getAllSources()).map(s => s.id)`, then
   `cps = await db.settings.getSettingForSources(ids, TRANSPORT_CHECKPOINT_SETTING_KEY)`.
   Decode each with `decodeTransportCheckpoint`. A null result is logged at
   `warn` and ignored.
2. `cur = binStartOf(now)`. For each checkpoint:
   - `cp.binStartMs === cur` (**restart inside the bin**): seed `bins` with the
     checkpoint's counts and identity, marked `dirty: false`. Packets after the
     restart add to it. The bin is written once, at its normal boundary.
   - `cp.binStartMs < cur` (**bin closed while the server was down**): write
     it now through the flush path in "recovery" mode. Packets come from the
     checkpoint. Nodes heard come from
     `countNodesHeardByTransport(sourceId, binStart, binEnd, cp.nodeNum)`,
     which is exact: no packet has arrived since shutdown, so no stamp in that
     window has moved. Identity comes from the checkpoint. Skip it if
     `binEnd` is older than 7 days (the purge would delete it anyway). If this
     bin was already flushed before the shutdown, the insert is a no-op.
   - `cp.binStartMs > cur` (the clock went backwards): discard with `warn`.
   - Bins between the checkpointed one and `cur` had no listener, so they get
     no rows (a gap, which is the truth).
3. Arm the timers.

**recordRx(sourceId, cls).** Get or create `BinState` for
`binStartOf(now)`, increment `cls`, and set `dirty`. Identity is filled at
checkpoint or flush time from `getLocalNodeInfo()`, so `recordRx` stays sync and cheap.

**Checkpoint.** A `setInterval(checkpointAll, TRANSPORT_CHECKPOINT_INTERVAL_MS)`
handle with `unref()`. For each source's **current** bin with `dirty` set,
fill identity from the manager if missing. Skip the bin if identity is still
unknown, since recovery could not key the rows. Then call
`db.settings.setSourceSetting(sourceId, KEY, encodeTransportCheckpoint(…))`
and clear `dirty`. That is at most one upsert per source per 30 s, and none
on an idle source **within a bin already checkpointed for that bin** — see
R13 below: a bin's *first* checkpoint no longer depends on `dirty` at all.
Errors per source are caught and logged at `warn`.

**"Bin opened" checkpoint event (R13, found in restart validation).** A
source that is idle for an entire bin never sets `dirty`, so the 30 s cadence
above never checkpoints it — its persisted checkpoint keeps pointing at
whatever bin it was last dirty in, possibly several bins ago. A crash landed
between then and the idle bin's boundary left **no checkpoint for that closed
bin at all**, so `start()`'s recovery had nothing to key off — a hole in both
series for that bin, even though nodes-heard (from DB stamps, independent of
the counter) was real. Fix: treat "a new bin opened for a source whose
identity is known" as a checkpoint event in its own right, via a shared
`writeBinOpenedCheckpoint(sourceId, binStartMs, nodeId, nodeNum)`: get-or-
create the `BinState`, persist whatever counts already exist (0 for a
genuinely idle source, or already-accumulated counts if a packet raced in
between a boundary and this call), and clear `dirty` — reusing the exact same
persist path as the 30 s cadence, just called unconditionally instead of only
when dirty. Called from two places, both "at most once per source per bin":
- **`start()`**, after restore/recovery: inside `restoreAndRecover`'s recovery
  branch (`cp.binStartMs < cur`), right after attempting to write the closed
  bin (regardless of whether that write was skipped by the 7-day guard or
  itself failed) — the checkpoint's own identity is enough, no live manager
  needed (R10 means none is connected yet in production at this point). A
  second pass, `ensureCurrentBinCheckpoints()`, covers a known-identity
  manager that restore didn't already seed a fresh `cur` bin for (no prior
  checkpoint at all) — ordinarily a no-op in production given R10, but keeps
  the guarantee order-independent and is exercised directly in tests.
- **`flush()`**, right after writing the just-closed bin for each
  known-identity source (see below) — opens/checkpoints the bin that just
  became current, using the exact identity already resolved for the closed
  bin's write.

Cost: one extra settings upsert per source per 5-minute bin, on top of the
existing "at most one per 30 s while dirty" cadence — the 30 s cadence itself
is unchanged.

**Crash loss bound.** A hard kill (SIGKILL, power loss, OOM) loses at most
the **packet counts from the last 30 s** of the bin in progress. That bin is
still written, from the checkpoint, either at its normal boundary after a
quick restart or through recovery after a longer one. Nodes heard lose
nothing, because they come from the persisted stamps. A graceful stop loses
nothing (see stop).

**Flush (aligned timer).** `next = (floor(now / BIN) + 1) * BIN`, then
`setTimeout(…, next - now + 2_000)` with `unref()`, re-armed after each flush
with the same formula. Never use `setInterval` here, since drift would break
the alignment. `flush(binEndMs)`, with `binStartMs = binEndMs - BIN`:
- **Single-flight:** if `flushing`, return.
- For each `sourceId` that has a manager in `getManagers().filter(isMeshtasticManager)`
  **or** a `BinState` for `binStartMs`:
  - identity = the manager's `getLocalNodeInfo()` when connected, else the
    `BinState` identity. If there is none, skip. With no listener and no
    counts, a bin has no honest value.
  - `nodesHeard = countNodesHeardByTransport(sourceId, binStartSec, binEndSec, nodeNum)`;
    `packetsRx` = the `BinState` counts, or zeros when connected with no
    packets. A quiet bin on a live link is a real zero.
  - insert each row from `buildTransportSeriesRows` via `db.insertTelemetryAsync(row, sourceId)`.
  - errors per source are caught and logged at `warn`. One source never blocks another.
  - **R13:** then call `writeBinOpenedCheckpoint(sourceId, binEndMs, identity.nodeId,
    identity.nodeNum)` for the bin that just became current — even when the
    write above failed. This is what closes the idle-source recovery hole.
- Drop `BinState`s older than the new current bin. The checkpoint row is
  **not** deleted: it is overwritten by the next bin's first checkpoint, and a
  stale one is harmless (recovery would re-insert an existing bin, a no-op).

**Stop (graceful).** Clear both timers, then `await checkpointAll()` for every
dirty current bin. The next start then restores the exact count. `stop()`
must resolve even when the DB throws.

**No settings drive either timer.** A settings save cannot re-arm or reset
them. The checkpoint key is not POST-able, so the settings route (which
restarts announce/timer schedulers, `server.ts` ~977) never sees it.

**Wiring (`src/server/server.ts`):**
- Startup: `await transportTrafficService.start();` after
  `await databaseService.waitForReady()` (~316) and **before**
  `await bootstrapSources(…)` (~327). Recovery must read the stamps before any
  manager can receive a packet. Wrap it in try/catch, and log and continue on
  failure: the feature must never block boot.
- Shutdown (`gracefulShutdown`, ~1138): right after `isShuttingDown = true`,
  start `const trafficStopped = transportTrafficService.stop();`. The write
  goes out at once, while the DB is open. Do not wait for `server.close()`,
  which waits for every client connection. Make `shutdownDependencies` async,
  and before `databaseService.close()` add
  `await Promise.race([trafficStopped, new Promise(r => setTimeout(r, 3000))]);`.
  Call sites become `void shutdownDependencies()`. The existing 10-second
  forced exit still bounds the whole sequence.

**Settings constants (`src/server/constants/settings.ts`):** add
`'transportTrafficCheckpoint'` to `PER_SOURCE_SETTINGS_KEYS` (next to
`lastAnnouncementTime`, ~587) and to `PER_SOURCE_KEYS_NOT_POSTABLE` (~767,
with a comment naming the service). **Do not** add it to
`VALID_SETTINGS_KEYS`. Bump the expected size in
`settings.allowlist.test.ts` ("PER_SOURCE_KEYS_NOT_POSTABLE has the expected size").

**Counter hook (`src/server/meshtasticManager.ts` ~6436, after `txColumn`):**
```ts
// #5101 P3: per-transport RX counter. Starts from the same gate as the
// stamp (#4192 6h replay guard + not-our-own-node) but ALSO requires
// isLiveReception (120s) — see R12: the 6h stamp-refresh threshold alone let
// firmware 2.8's hourly/reconnect PhoneAPI NodeDB replay (#5034) inflate the
// counter by dozens per reconnect. Deliberately does not change
// lastHeard/transportLast* stamping, which keeps the lenient #4192 policy.
if (
  heardSec !== undefined &&
  fromNum !== this.localNodeInfo?.nodeNum &&
  isLiveReception(meshPacket.rxTime != null ? Number(meshPacket.rxTime) : undefined, Date.now())
) {
  transportTrafficService.recordRx(
    this.sourceId,
    classifyNodeTransport({ transportMechanism: txMech, viaMqtt: meshPacket.viaMqtt }),
  );
}
```
Compute `const heardSec = resolveLastHeardSec(…)` once, and use it for
`lastHeard`, `[txColumn]` and the gate. Today the code calls it twice with the
same arguments. Import `classifyNodeTransport` next to
`transportColumnForPacket`, and `isLiveReception` next to
`resolveLastHeardSec` (both from `./utils/replayGuard.js`). Use `.js` on the
service import. **Post-browser-validation addendum:** `isLiveReception` and
`LIVE_RECEPTION_WINDOW_SEC` (120s) live in `replayGuard.ts` alongside
`resolveLastHeardSec` — see R12 for why the counter needs a second, tighter
gate than the stamp.

### 3.5 Frontend (WP4, WP5)

**Chart style (D5).** Nodes heard: **three lines**. The classes overlap, so a
stack would suggest a false total. Packets RX: **stacked area** (each packet
counts once). Colours: RF `var(--chart-1)`, UDP `var(--chart-6)`, MQTT
`var(--chart-4)`. Hide a class whose values are all zero or null in the
visible range. If all three are empty, show the empty-state text. When
`toTransportChartRows` reports `averaged`, allow decimal Y ticks and show
`info.transport_series_averaged` under the chart. Otherwise use
`allowDecimals={false}`.

`src/components/TransportSeriesPlot.tsx`: props
`{ rows, kind, averaged, height?: number, timeRange: [number, number] | null }`.
It renders `ResponsiveContainer` → `ComposedChart` with `Line` (nodesHeard) or
`Area stackId="transport"` (packetsRx), with `Legend` labels from
`t('transport.rf'|'udp'|'mqtt')` and X ticks via `formatChartAxisTimestamp`.
Tooltip styles use token strings (`var(--color-bg)` etc.). Do not copy the
MutationObserver block.

`src/components/TransportSeriesGraphs.tsx` (Info tab), with props
`{ nodeId: string; telemetryHours?: number; baseUrl?: string }`:
- `const { sourceId } = useSource();`, then
  `useTelemetry({ nodeId, hours: telemetryHours, baseUrl, sourceId })`, then
  memoised `toTransportChartRows(data ?? [], 'nodesHeard' | 'packetsRx')`.
- Layout mirrors `PacketRateGraphs`: `telemetry-graphs` wrapper, h3
  `info.transport_series_title`, the caption `info.transport_series_note`, and
  a `graphs-grid` with two `graph-container`s. The titles are
  `info.transport_nodes_heard` / `info.transport_packets_rx`, and the
  per-chart captions are `info.transport_nodes_note` /
  `info.transport_packets_note`. Each chart has a favorite star toggling
  `TRANSPORT_NODES_HEARD_TYPE` / `TRANSPORT_PACKETS_RX_TYPE`.
- States: `common.loading_indicator`, `info.transport_series_error`,
  `info.transport_series_empty`. Test ids: `transport-series-section`,
  `transport-series-nodes`, `transport-series-packets`, `transport-series-empty`.

`src/components/TransportSeriesChart.tsx` (Dashboard card): props match
`PacketRateChart` (`id, favorite, node, hours, baseUrl, globalTimeRange, onRemove`).
Use `useSortable` and the `dashboard-chart-*` / `dashboard-remove-btn`
classes, with `UiIcon name="close"`. The kind comes from
`TRANSPORT_SERIES_PSEUDO_TYPES[favorite.telemetryType]`. Fetch with
`useTelemetry({ nodeId: favorite.nodeId, hours, baseUrl, sourceId })`, taking
`sourceId` from `useSource()`. Keep the drag-handle glyph the sibling cards
already use, and add no new glyphs.

`TransportSeries.module.css`: caption and empty-state styles only.

`DashboardGrid.tsx`, before the `isPacketRateType` branch (~205):
```tsx
if (isTransportSeriesType(favorite.telemetryType)) {
  return <TransportSeriesChart key={key} id={key} favorite={favorite} node={node}
    hours={hours} baseUrl={baseUrl} globalTimeRange={globalTimeRange} onRemove={onRemoveFavorite} />;
}
```

`TelemetryChart.tsx` `TELEMETRY_LABELS`:
`transportNodesHeard: 'Nodes Heard by Transport (MeshMonitor)'`,
`transportPacketsRx: 'Packets RX by Transport (MeshMonitor)'`,
`systemNodesHeardRf: 'Nodes Heard RF (MeshMonitor)'` (plus Udp and Mqtt), and
`systemPacketsRxRf: 'Packets RX RF (MeshMonitor)'` (plus Udp and Mqtt).
`UnifiedTelemetryPage.tsx` `TYPE_LABELS`: `'Heard RF'`, `'Heard UDP'`,
`'Heard MQTT'`, `'RX RF'`, `'RX UDP'`, `'RX MQTT'`.

`TelemetryGraphs.tsx` `filteredData` (~1023):
`if (isTransportSeriesComponentType(type)) return false;`

`InfoTab.tsx` (WP5), after the PacketRateGraphs block (~1098):
```tsx
{showTransport && currentNodeId && connectionStatus === 'connected' && (
  <div className="info-section-full-width">
    <TransportSeriesGraphs nodeId={currentNodeId} telemetryHours={telemetryHours} baseUrl={baseUrl} />
  </div>
)}
```

**i18n (en.json, all added by WP2):**
```
"info.device_counters_note": "The node counts these itself, across every transport (RF, UDP and MQTT), so they cannot be split.",
"telemetry.device_counter_note": "Device counter: all transports combined",
"info.transport_series_title": "Traffic by Transport (MeshMonitor)",
"info.transport_series_note": "MeshMonitor counts these from the packets this node passes on, in 5-minute slots.",
"info.transport_nodes_heard": "Nodes Heard by Transport",
"info.transport_nodes_note": "A node heard over two transports in the same slot counts on both lines.",
"info.transport_packets_rx": "Packets Received by Transport",
"info.transport_packets_note": "Each packet counts once, under the transport it arrived on.",
"info.transport_series_averaged": "Long range: each point is the average of several 5-minute slots.",
"info.transport_series_empty": "No data yet. MeshMonitor adds a point every 5 minutes.",
"info.transport_series_error": "Could not load transport traffic."
```

---

## 4. Permissions

There is no new route. Both series come back through
`GET /api/telemetry/:nodeId` (`telemetryRoutes.ts` ~41), which requires
`info:read` or `dashboard:read`, plus `checkNodeChannelAccess(nodeId, user, sourceId)`.
`requireSourceId('query')` scopes the rows to one source. This is the same
gate as `systemNodeCount` and every device counter. The rows are aggregate
counts with no packet content or node identities. `packetmonitor:read` would
be wrong here, because nothing reads `packet_log`.

The checkpoint row is readable through `GET /api/settings?sourceId=…`, like
`lastAnnouncementTime`. It holds counts only, so it is not secret.

Known pre-existing gap, not widened: the `hasPermission(user, 'info', 'read')`
check in the telemetry route is not source-scoped (Deferred).

---

## 5. Source types

- **Meshtastic TCP**: full feature.
- **MQTT-only (`mqtt_bridge`, `mqtt_broker`)**: the writer skips them
  (`isMeshtasticManager` is TCP-only, and they never call `recordRx`), and
  InfoTab hides the section (`showTransport`, ~81).
- **MeshCore / Reticulum**: never reach InfoTab, and use other packet paths.
  The Dashboard branch is type-driven, so it is inert there.
- Device-counter captions show wherever the counters render.

---

## 6. Mesh impact checklist

1. **Airtime:** zero. Nothing sends a packet. `requestLocalStats` and the
   LocalStats scheduler are untouched.
2. **Spam / fan-out:** none. Telemetry inserts emit no events (finding 8).
   Settings upserts through the repository emit nothing either; only the
   settings HTTP route re-arms schedulers. There are no retries: a failed
   flush or checkpoint logs and waits for its next tick.
3. **Save resets a timer:**
   - No setting drives either timer, so no save can re-arm or reset them.
   - The "last fired" state is persisted in two places. For finished bins it is
     the telemetry row itself: a re-write is a no-op through the synthetic
     `packetId` and the 032 index, so a restart cannot write a bin twice or
     early (I1). For the bin in progress it is the checkpoint row, restored on
     start, so a restart mid-bin keeps that bin's count. A crash loses at most
     30 s of packet counts.
   - No cooldown protects the mesh here, so there is nothing for a save to clear.
   - **Restart checks (acceptance, on the dev container):**
     1. `docker restart` twice inside one bin. Expect one row per type for that
        bin, with a packet total no lower than the packets logged before the
        first restart.
     2. `docker kill -s KILL`, wait past a boundary, then start. Expect the
        closed bin to be written by recovery.
4. **Storage (D2, 5-minute bins):** 6 rows × 288 bins = **1,728 telemetry
   rows/day per TCP source**. That is ~12.1k at the 7-day default retention,
   and up to ~155.5k for a favorited chart at the 90-day maximum (D7 makes
   favorites extend these rows). For scale, LocalStats at its 15-minute
   default writes ~1,250 rows/day. The checkpoint adds one settings row per
   source, upserted at most every 30 s while packets flow (≤ 2,880 upserts/day,
   none when idle). The client reads raw rows (288/day per type), and
   `toTransportChartRows` averages anything past 500 points.

---

## 7. Test plan

Agent worktrees: `git submodule update --init --recursive` and symlink
`node_modules` first. Confirm `success: true` via the JSON reporter. For
the multi-backend suites, start the PG (5433) and MySQL (3307) containers and
confirm they did not skip (`numPendingTests`).

| File (new unless noted) | Covers |
|---|---|
| `src/utils/transportSeries.test.ts` | `binStartOf`, bin index; `buildTransportSeriesRows` (6 rows, packetId = index, timestamp = bin end); checkpoint codec round-trip, plus rejection of bad JSON, wrong `v`, unaligned `binStartMs`, and negative or float counts; `toTransportChartRows` (sort, null for a missing class, foreign types ignored, averaging above `maxPoints` sets `averaged`) |
| `src/utils/deviceCounters.test.ts` | set membership; heap/noise/uptime excluded |
| `src/utils/telemetryRetention.test.ts` (extend) | pseudo favorites expand to component types, global and per-source; the literals equal the exported constants |
| `src/db/repositories/nodes.transportHeard.multiBackend.test.ts` | SQLite + PG + MySQL, each with its **own** isolated DB (`isolationKey: 'nodes_transport_heard'`). Window edges (`from` exclusive, `to` inclusive), OR counting, NULL stamps ignored, local node excluded, stamps above 2^31 on PG/MySQL, numeric results |
| `src/db/repositories/nodes.transportHeard.perSource.test.ts` | source A's nodes never counted for source B |
| `src/db/repositories/telemetry.syntheticBin.multiBackend.test.ts` | the same bin inserted twice leaves one row per type on all three backends, and **the first value wins**; a different `sourceId` with the same packetId still inserts |
| `src/server/services/transportTrafficService.test.ts` | Fake timers, injected `now`, mocked db and managers. **Timers:** the first flush lands on boundary + slack and re-arms aligned; the checkpoint fires every 30 s, writes only dirty current bins, skips unknown identity, and stays silent when idle. **Restore:** a current-bin checkpoint seeds counts, and later `recordRx` adds to them, with one write at the boundary. **Recovery:** a closed-bin checkpoint writes rows at start, with packets from the checkpoint and nodes from the stamp query using the checkpoint's nodeNum and window; it is skipped past 7 days, and future or invalid checkpoints are discarded. **Flush:** writes when connected with zero packets; writes from `BinState` identity when disconnected but counts exist; skips when neither; MQTT/MeshCore managers skipped; a packet recorded after a boundary but before its flush lands in the new bin; a DB error on source A still writes source B; single-flight. **I1:** no telemetry insert ever targets the bin in progress. **Stop:** timers cleared, dirty bins checkpointed, resolves when the DB throws. **Checkpoint crash loss:** counts recorded after the last checkpoint are absent after a simulated restart, and earlier ones are present. |
| `src/server/meshtasticManager.transportTraffic.test.ts` | modelled on `meshtasticManager.lastHeardReplayGuard.test.ts`: RF / MQTT (mechanism 5, and viaMqtt with no mechanism) / UDP packets call `recordRx` with the right class; the local node's own packet and a stale replayed rxTime do not |
| `src/server/constants/settings.allowlist.test.ts` (extend) | the size bump, plus `transportTrafficCheckpoint` is in `PER_SOURCE_KEYS_NOT_POSTABLE` and **not** in `VALID_SETTINGS_KEYS` |
| `src/server/routes/telemetryRoutes.transportSeries.test.ts` | `createRouteTestApp`: with `info:read` on source A, `GET /api/telemetry/:localNodeId?sourceId=A` returns A's `systemNodesHeard*` rows and none of B's, raw (integers) over a 7-day window |
| `src/components/DeviceCounterNote.test.tsx` | renders text + testid |
| `src/components/InfoTab.transportBreakdown.test.tsx` (extend) | the two device notes render; the transport section renders for `meshtastic_tcp` and not for `mqtt_bridge`. **Add `vi.mock('./TransportSeriesGraphs', …)`** next to the existing TelemetryGraphs / PacketRateGraphs mocks. |
| `src/components/TransportSeriesGraphs.test.tsx` | two charts from mocked `useTelemetry`; UDP hidden when all-zero; averaged caption; empty and error states; stars toggle the pseudo types |
| `src/components/TransportSeriesChart.test.tsx` | the right kind from the favorite; passes `sourceId`; remove calls `onRemove` |
| `src/components/TelemetryGraphs.test.tsx` (extend) | component types are not drawn as single charts; the `numPacketsRx` widget shows the device caption, and `batteryLevel` does not |
| `src/components/PacketRateChart.test.tsx` | `usePacketRates` gets the context `sourceId`; the device caption renders |

Then run the full suite, `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'`
(must be empty), and `npx tsc --noEmit -p tsconfig.server.json`.

Browser validation (WP5): deploy the dev container from the worktree (`/deploy`,
with the USB override). Wait for three bin boundaries, then check both charts
on the Info tab and on the Dashboard after starring each. Check the captions
at 375 px, and in the light and dark themes. Run both restart checks from §6.
Attach screenshots to the PR.

---

## 8. Work packages

Exclusive file ownership per wave.

### Wave 1

**WP1 — contract and data layer**
Files: `src/utils/transportSeries.ts` (+test), `src/db/repositories/nodes.ts`,
`src/db/repositories/telemetry.ts` (RAW_VALUE_TYPES only),
`src/utils/telemetryCategory.ts`, `src/utils/telemetryRetention.ts` (+test extension),
`nodes.transportHeard.multiBackend.test.ts`, `nodes.transportHeard.perSource.test.ts`,
`telemetry.syntheticBin.multiBackend.test.ts`.
Accept: tests green on SQLite, PG and MySQL (verified not skipped), and
`lint:ci` clean.

### Wave 2 (parallel, after WP1)

**WP2 — device labels, i18n, label maps**
Files: `src/utils/deviceCounters.ts` (+test), `src/components/DeviceCounterNote.tsx`
+ `.module.css` (+test), `src/components/InfoTab.tsx` (the two captions only),
`PacketRateGraphs.tsx`, `PacketRateChart.tsx` (+ test, with the sourceId fix),
`TelemetryChart.tsx` (device caption + all new `TELEMETRY_LABELS`),
`TelemetryGraphs.tsx` (device caption + hide component types),
`src/pages/UnifiedTelemetryPage.tsx`, `public/locales/en.json` (**every** key in
§2 and §3.5), and the caption extensions to
`InfoTab.transportBreakdown.test.tsx` / `TelemetryGraphs.test.tsx`.
Accept: captions visible at phone width; no existing i18n value changed; only
en.json touched among the locales.

**WP3 — writer, checkpoint, wiring**
Files: `src/server/services/transportTrafficService.ts` (+test),
`src/server/meshtasticManager.ts` (counter hook only),
`meshtasticManager.transportTraffic.test.ts`, `src/server/server.ts` (start
before bootstrap; async shutdown step), `src/server/constants/settings.ts`,
`settings.allowlist.test.ts`, and
`src/server/routes/telemetryRoutes.transportSeries.test.ts` (test only).
Accept: the service tests cover every rule in §3.4; on the dev container, rows
appear at each 5-minute boundary and both restart checks in §6 pass; `.js`
on every relative import.

**WP4 — chart components**
Files: `src/components/TransportSeriesPlot.tsx`, `TransportSeriesGraphs.tsx`,
`TransportSeriesChart.tsx`, `TransportSeries.module.css` (+ the two component
tests), `src/components/Dashboard/components/DashboardGrid.tsx`.
It uses the WP2 i18n keys by name (tests mock `t`), and does **not** touch
InfoTab.
Accept: a starred pseudo-type renders as the combined card; lines vs stacked
area; survey colours; all-zero classes hidden.

### Wave 3 (after WP2, WP3 and WP4)

**WP5 — integration, validation, docs**
Files: `src/components/InfoTab.tsx` (mount the section),
`InfoTab.transportBreakdown.test.tsx` (mock + render/hide assertions),
`docs/internal/dev-notes/TRANSPORT_BREAKDOWN_EPIC.md` (tick Phase 3, add the
status log entry and the decisions below), and user docs if a telemetry page
lists computed types (`grep -rn systemNodeCount docs/`).
Accept: the full suite passes with PG/MySQL up; `lint:ci` clean in the repo;
browser validation and both restart checks, with screenshots.

---

## 9. Decisions (user, 2026-09-24)

- **D1: Packets RX source.** An in-memory counter at the receive seam,
  **with DB backing so in-progress counts survive reboots**: a per-source
  checkpoint every 30 s and on graceful shutdown, restored on start (§3.4).
  This replaces the earlier "skip the first partial bin" rule. The
  `packet_log` variant is dropped.
- **D2: Bin length.** 5 minutes, fixed. 1,728 rows/day per TCP source.
- **D3: Nodes heard.** Heard during the bin: the stamp is inside the bin.
- **D4: Labels.** Keep "(Device)" titles, and add a visible caption.
- **D5: Charts.** Lines for nodes, stacked area for packets, all-zero classes hidden.
- **D6:** Fix `PacketRateChart`'s missing `sourceId`. Yes.
- **D7:** Favorited pseudo-charts keep their component rows, including the
  existing Packet Rate favorites. Yes.
- **D8:** "(Device)" on the Unified Telemetry page's short labels. Yes.

---

## 10. Risks

- **R1: stamp vs counter disagree.** Nodes come from DB stamps, packets from the
  counter. Both sit behind one gate on one line, and a test pins it. **Updated
  post-browser-validation (see R12): the two gates are no longer identical.**
  Both still exclude a stale replay per the 6h `#4192` threshold and our own
  node's packets, but the counter additionally requires `isLiveReception`
  (120s). This is intentional, not a regression: "nodes heard" is a *stamp*,
  where a firmware-2.8 replay refreshing it early is harmless (the node really
  is there); "packets RX" is a *counter*, where the same replay would inflate
  the count by dozens per reconnect. The two series can legitimately disagree
  on a given bin for exactly this reason — see R12.
- **R2: firmware double delivery (#4811).** The counter does not use the
  packet-log dedup map, so a packet delivered twice counts twice. It is rare.
  Document it in the service header.
- **R3: disconnect inside a bin.** The bin is written from whatever was heard.
  It is a true count and rare. Do not add connection-epoch tracking.
- **R4: local node change.** Rows key to the local nodeId, as `systemNodeCount`
  does. A radio swap mid-bin writes that bin under the identity captured at
  checkpoint or flush time. Acceptable.
- **R5: MySQL insert path.** Use single `insertTelemetryAsync` (`insertIgnore`).
  The multiBackend test proves "first write wins" on MySQL.
- **R6: synthetic packetId.** Nothing joins `telemetry.packetId` to `packet_log`
  for `system*` types, and the unique tuple includes `telemetryType`. Note it
  in the service header.
- **R7: TelemetryGraphs hides types globally.** Intended, since only the local
  node ever has them.
- **R8: backup/restore carries the checkpoint.** The settings row rides in
  system backups. Restoring an old backup brings back its checkpoint, and the
  next start writes that old bin, if it is within 7 days, for the same source
  it came from. Duplicates are impossible (I1 + index). Acceptable, and correct.
- **R9: clock steps.** A backwards step makes the checkpoint "future", so it is
  discarded with a warning. A forward step skips bins, which then have no rows.
  Neither can double-write.
- **R10: boot order.** Recovery counts are exact only because `start()` runs
  before `bootstrapSources`. A future refactor that moves it later would
  undercount the recovered bin's nodes. Comment it at the call site.
- **R11: shutdown hang.** `server.close()` waits for all clients. That is why
  `stop()` begins at the top of `gracefulShutdown`, not inside
  `shutdownDependencies`. The 3 s race plus the 10 s forced exit bound it.
- **R12: firmware 2.8 PhoneAPI NodeDB replay inflated the packet counter
  (found in browser/restart validation, fixed same PR).** Firmware 2.8's
  `PhoneAPI` replays each NodeDB entry's cached position/telemetry as
  synthetic LoRa packets on every client reconnect and roughly hourly
  (firmware PR #10413/#11014, issue #5034 — see
  `src/server/services/packetLogDedup.ts`'s header). The replay is
  indistinguishable from a fresh reception on every field except `rx_time`,
  which keeps the packet's ORIGINAL first-heard timestamp. The counter
  originally reused the `#4192` replay guard (`heardSec !== undefined`,
  a 6-hour staleness threshold meant for deciding whether to *refresh*
  `lastHeard`), so any replay of something heard in the last 6h was counted
  as a brand-new live reception — observed on the dev container as
  `systemPacketsRxRf` jumping ~70 per reconnect (67 -> 134 across two
  restarts within seconds). Fixed with a second, much tighter gate:
  `isLiveReception(rxTimeSec, nowMs)` (`src/server/utils/replayGuard.ts`),
  true only when `rx_time` is absent/implausible or within
  `LIVE_RECEPTION_WINDOW_SEC` (120s) of now. `lastHeard`/`transportLast*`
  stamping is deliberately UNCHANGED — it keeps the lenient 6h `#4192` policy,
  since a stamp only records "the node exists", where an early refresh from a
  replay is harmless. Net effect: **"nodes heard" still includes
  replay-refreshed stamps (inherits the #4192 policy), while "packets RX"
  excludes replays outright.** The two series measuring the same bin can
  therefore diverge — e.g. a node quiet for an hour can still show up in
  `systemNodesHeardRf` (an hourly replay refreshed its stamp) while
  contributing 0 to `systemPacketsRxRf` for that bin. This is correct, not a
  bug: "packets RX" answers "how much real RF traffic did we receive", and a
  replay is not real traffic.
- **R13: idle-source recovery hole (found in restart validation, fixed same
  PR).** `docker kill -s KILL` at 14:59:32, restart at 15:00:32. Source e887
  had 2 packets in the 14:55 bin (dirty) and recovered correctly. Source c9dd
  had zero packets in that bin — its checkpoint was never rewritten for the
  new bin (the dirty-only 30 s cadence never fires for an idle source), so it
  still pointed at the already-flushed 14:50 bin. `start()`'s recovery had no
  checkpoint to key the 14:55 bin off, so it wrote nothing: a hole in both
  charts for c9dd for that bin, even though its nodes-heard (from DB stamps)
  would have been 48. Fixed by making "a new bin opened for a source with a
  known identity" a checkpoint event in its own right, independent of
  `dirty` — see `writeBinOpenedCheckpoint` in §3.4. Cost: one extra settings
  upsert per source per 5-minute bin. The dirty-only 30 s cadence, the 7-day
  recovery-age guard, and invariant I1 (never write a bin's telemetry rows
  before it closes) are all unchanged.

## 11. Deferred

- `hasPermission(user, 'info'|'dashboard', 'read')` in `telemetryRoutes.ts` is
  not source-scoped (pre-existing).
- LocalStats `setLocalStatsInterval` re-fires `saveSystemNodeMetrics` 30 s after
  each save (finding 4), which writes an extra sample. Separate issue.
- `PacketRateGraphs` / `PacketRateChart` duplicate `mergeRateData`.
