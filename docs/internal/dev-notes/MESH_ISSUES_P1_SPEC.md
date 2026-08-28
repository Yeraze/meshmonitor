# Mesh Issues Analysis — Phase 1 Implementation Spec

**Epic:** #4964 — see `MESH_ISSUES_EPIC.md` (binding; every locked decision there applies).
**Phase:** 1 — Foundation + Tier A rules.
**Worktree:** `../meshmonitor-mesh-issues-p1` on `feature/mesh-issues-analysis-phase1`.
**Audience:** Sonnet implementers. Every file path is repo-relative.

**Mesh impact: ZERO.** This phase reads only rows already on disk. It sends no
packets, arms no mesh-facing timer, and emits no `dataEventEmitter` event. The
mesh-impact checklist §1/§2 are satisfied by construction; §3 is satisfied by
persisting `mesh_issues_last_run` to settings (see WP3). Restating this in the
PR body is required.

---

## 1. Reuse inventory (read this before writing any code)

Nothing in this list may be re-implemented. If a work package believes it needs
a new mechanism, it must first explain why the listed one does not fit.

### 1.1 Must reuse — parsing and pure helpers

| Need | Reuse | Notes |
|------|-------|-------|
| Traceroute hop arrays | `parseHopArray(json)` — `src/utils/tracerouteSegments.ts` | Returns `number[]`; never `JSON.parse` a `route`/`routeBack`/`snr*` column by hand. |
| "Does this traceroute carry route data" | `hasRouteData(route)` — same file | The epic's validity filter clause 1. |
| Valid route participant | `isValidRouteNode(nodeNum)`, `BROADCAST_ADDR` — same file | The epic's validity filter clause 2. |
| SNR sentinel handling | `UNKNOWN_SNR_SENTINEL` (= -32), `isUnknownSnr`, `averageNonSentinelSnr` — same file | Needed by Phase 2; the sampler must carry raw SNR arrays through untouched so Phase 2 can apply these. |
| Reboot / uptime reset detection | `isUptimeReboot(prior, next, slack?)`, `REBOOT_UPTIME_SLACK_SECONDS` — `src/server/utils/rebootDetection.ts` | A3's "uptime resets" clause. Do **not** write a new comparison. |
| Powered-vs-battery | `isPowered(batteryLevel)` — `src/server/utils/poweredState.ts` | Encodes the firmware `>100` (101 = powered) convention. A3's `battery ≠ 101` clause is `!isPowered(...)`. |
| Effective node position | `getEffectiveDbNodePosition(node)` — `src/server/utils/nodeEnhancer.ts` | Honors `positionOverrideEnabled`. Used by A2b + A4. |
| Null Island / bogus position | `isBogusPosition(lat, lon, precisionBits?)` — `src/utils/nullIsland.ts` | Handles the firmware precision re-centering. A2b + A4 skip bogus positions. |
| Mobility classification | `nodeMobilityService` — `src/server/services/nodeMobilityService.ts` | A4. See §2.6 for the required behavior-preserving extraction. |
| Firmware version compare | `compareVersions(a, b)` — `src/server/utils/systemInfo.ts` | A5's firmware guard. Handles `2.5.20.4c97351`-style strings. |
| Device role ints | `DeviceRole` — `src/constants/index.ts` (`ROUTER=2`, `ROUTER_CLIENT=3`, `REPEATER=4`, `ROUTER_LATE=11`) | Never hardcode the ints in rule code; import the enum. |
| MQTT source-type test | `isMqttSourceType(type)` — `src/db/repositories/sources.ts` | Selecting the Meshtastic-family source set. |

### 1.2 Must reuse — data access

| Need | Reuse | Notes |
|------|-------|-------|
| Traceroute corpus load | `AnalysisRepository.getTraceroutes({ sourceIds, sinceMs, pageSize, cursor })` — `src/db/repositories/analysis.ts` | Already cross-source, already paginated with a stable `(timestamp, id)` cursor. **Extend** it with `packetId` (§2.3) rather than adding a new method. |
| Telemetry history | `TelemetryRepository.getTelemetryByTypesSince(types, sinceMs, sourceIds?)` | Exactly the shape A2a/A2b/A3 need. **No new telemetry repo method is required.** |
| Position history (A4) | `TelemetryRepository.getPositionTelemetryByNode(nodeId, limit, sinceTimestamp?, sourceScope?)` | Call with `ALL_SOURCES`, matching `nodeMobilityService`. |
| Pooled node rows | `NodesRepository.getAllNodes(ALL_SOURCES)` | One row per `(nodeNum, sourceId)`; §2.5 merges them. Mark the call site `// intentional cross-source:` per the repo convention. |
| Enabled sources | `databaseService.sources.getAllSources()` | Filter `enabled !== false` and `type ∈ {meshtastic_tcp, mqtt_broker, mqtt_bridge}`. |
| Settings get/set | `databaseService.settings.getSetting/setSetting` | Same as `positionEstimationScheduler`. |
| Cross-source sentinel | `ALL_SOURCES` — `src/db/repositories/base.ts` | Never pass `undefined` to mean "all". |

### 1.3 Must reuse — structural patterns (copy the shape, not the domain)

| Need | Model file | What to copy |
|------|-----------|--------------|
| Global (no-`sourceId`) table | `src/db/schema/estimatedPositions.ts` + `src/db/repositories/estimatedPositions.ts` | The header comment justifying the carve-out; keyed by physical `nodeNum`. |
| 3-backend migration | `src/server/migrations/152_create_meshtastic_heard_repeaters.ts` | `migration.up/down` + `runMigrationNNNPostgres` + `runMigrationNNNMysql`, `createTableIfMissingMysql`, `CREATE ... IF NOT EXISTS` elsewhere. |
| Migration test pair | `152_create_meshtastic_heard_repeaters.test.ts` + `.pgmysql.test.ts` | |
| Repository | `src/db/repositories/meshtasticHeardRepeaters.ts` | `extends BaseRepository`, `this.tables.<name>`, `this.now()`, `this.normalizeBigInts(...)`. |
| Scheduler | `src/server/services/positionEstimationScheduler.ts` | Clone **exactly**: 60 s tick, pure exported `isRunDue`, in-memory `lastRunTime` cache backed by a settings key, `runLock: Promise<T> | null`, `inProgress`, `getStatus()`, `finally`-block last-run write. |
| Global batch service | `src/server/services/positionEstimationService.ts` | Class + `export const <name>Service = new …()`, single `run*` entry point returning a result object. |
| Read-only passive route | `src/server/routes/surveyRoutes.ts` | Header comment stating why there is no TX guard; `ok()`/`fail()`; `optionalAuth()` + `requirePermission`. |
| Cross-source permission filtering in a route | `resolvePermittedSourceIds()` — `src/server/routes/analysisRoutes.ts` (lines ~41-70) | **Copy the helper into the new router** (it is module-private today); do not export/refactor `analysisRoutes.ts` in this phase. |
| Admin "run now" route | `settingsRoutes.ts` `/position-estimation/run-now` | 409 on in-progress, `databaseService.auditLogAsync(...)`. |
| Report card + TanStack fetch | `src/components/Analysis/SolarMonitoringReport.tsx` | `useQuery` + `apiService.get`, `.reports-*` classes from `src/styles/analysis-reports.css`. |
| Report wire types module | `src/components/Analysis/mqttViolationTypes.ts` | Types-only sibling module next to the report. |
| Route test harness | `createRouteTestApp()` — `src/server/test-helpers/routeTestApp.ts` | Mandatory for the new route tests. |
| Multi-backend repo test | `src/db/repositories/estimatedPositionAnchors.test.ts` + `test-utils.ts` probes | |

### 1.4 New code, and why nothing existing fits

| New file | Closest existing mechanism | Why new |
|----------|---------------------------|---------|
| `mesh_issues` table + repo | `estimated_positions` | Same *shape* (global, nodeNum-keyed, batch-written), different domain. No table stores findings today. |
| `meshIssues/tracerouteCorpus.ts` | `src/utils/tracerouteAggregate.ts` (frontend map aggregation) | `tracerouteAggregate` aggregates *segments for rendering*; the corpus sampler does packet-level dedup + a per-(pair, time-bucket) stratified cap for statistics. Different output, different invariants. It **reuses** `tracerouteAggregate`'s parsers via `tracerouteSegments.ts`. |
| `meshIssues/nodeSnapshot.ts` | `nodeEnhancer.ts` (per-row enrichment) | `nodeEnhancer` enriches a single row; nothing merges N per-source rows into one physical-node view. `positionEstimationService` does an ad-hoc version inline — this extracts a reusable, tested one. |
| `meshIssues/rules.ts` + `thresholds.ts` | `solarAnalysis.ts` | Direct precedent for "pure analysis module under `src/server/services/`, exercised by a route/scheduler". New because the rules are new. |
| `meshIssuesAnalysisService.ts` / `meshIssuesScheduler.ts` | `positionEstimationService` / `Scheduler` | Structural clones; the domain is new. |
| `meshIssuesRoutes.ts` | `analysisRoutes.ts` | `analysisRoutes.ts` is already 1068 lines; a separate router keeps it from growing and lets the mesh-issues routes carry their own header contract. Mounted under the same `/api/analysis` namespace. |

### 1.5 Explicitly **not** touched in Phase 1

- `BACKUP_TABLES` (`systemBackupService.ts`) — `mesh_issues` is derived data that
  regenerates on the next run, exactly like `estimated_positions`, which is
  **not** in `BACKUP_TABLES`. Follow that precedent: do not add it.
- `dataEventEmitter` — no finding events. Emitting one would route findings into
  the automation engine / Apprise / desktop notifications fan-out (mesh-impact
  checklist §2, "indirect spam"). Deferred to Phase 3 with a user decision.
- `SettingsDraft` / `SettingsTab.tsx` — the threshold settings UI is Phase 3. The
  settings keys are registered server-side only in Phase 1.
- `src/styles/nodes.css` and the other frozen global sheets.

---

## 2. File-by-file changes

### 2.1 `src/db/schema/meshIssues.ts` — NEW

Three table definitions, one per backend, following
`schema/estimatedPositions.ts` (global-by-design header) and
`schema/meshtasticHeardRepeaters.ts` (three-block layout + `$inferSelect`
type exports at the bottom).

**Identity model.** A finding's identity is `(issueType, subjectKey)`.
`subjectKey` is a single non-null string so the UNIQUE index behaves
identically on all three backends (a nullable column in a UNIQUE index treats
NULLs as distinct on SQLite, PostgreSQL and MySQL alike, which would silently
allow duplicate area findings). Canonical forms:

- node subject: `` `node:${nodeNum}` ``
- area subject: `` `area:${latBin}:${lonBin}` `` (bin indices, integers, see §2.7 A2b)

`nodeNum` is kept as a nullable denormalized column purely for querying/joining;
`subjectKey` is the key.

| Column | SQLite | PostgreSQL | MySQL | Meaning |
|--------|--------|-----------|-------|---------|
| `id` | `integer` PK autoinc | `serial` PK | `int` autoinc PK | |
| `issueType` | `text` NOT NULL | `text` NOT NULL | `varchar(64)` NOT NULL | e.g. `A1_deprecated_role` |
| `subjectKey` | `text` NOT NULL | `text` NOT NULL | `varchar(128)` NOT NULL | see above |
| `nodeNum` | `integer` | `bigint` (mode number) | `bigint` (mode number) | null for area findings |
| `severity` | `text` NOT NULL | `text` NOT NULL | `varchar(16)` NOT NULL | `info` \| `warning` \| `critical` |
| `confidence` | `text` NOT NULL | `text` NOT NULL | `varchar(16)` NOT NULL | `low` \| `medium` \| `high` |
| `evidence` | `text` NOT NULL | `text` NOT NULL | `text` NOT NULL | JSON object |
| `sourceIds` | `text` NOT NULL | `text` NOT NULL | `text` NOT NULL | JSON array of source ids |
| `firstDetected` | `integer` NOT NULL | `bigint` NOT NULL | `bigint` NOT NULL | ms |
| `lastDetected` | `integer` NOT NULL | `bigint` NOT NULL | `bigint` NOT NULL | ms |
| `cleanRuns` | `integer` NOT NULL default 0 | `integer` NOT NULL default 0 | `int` NOT NULL default 0 | consecutive runs not re-detected |
| `status` | `text` NOT NULL default `'open'` | same | `varchar(16)` NOT NULL default `'open'` | `open` \| `closed` |
| `closedAt` | `integer` | `bigint` | `bigint` | ms, null while open |
| `dismissed` | `integer` boolean-mode NOT NULL default 0 | `boolean` NOT NULL default false | `boolean` NOT NULL default false | Phase 3 UI; column now |
| `dismissedAt` | `integer` | `bigint` | `bigint` | |
| `dismissedBy` | `integer` | `integer` | `int` | `users.id`; no FK (cross-table FKs are avoided elsewhere in this codebase) |
| `createdAt` | `integer` NOT NULL | `bigint` NOT NULL | `bigint` NOT NULL | |
| `updatedAt` | `integer` NOT NULL | `bigint` NOT NULL | `bigint` NOT NULL | |

Indexes:
- `mesh_issues_type_subject_uniq` UNIQUE `(issueType, subjectKey)`
- `mesh_issues_status_idx` `(status, severity)`
- `mesh_issues_node_idx` `(nodeNum)`

Export the six `$inferSelect` / `$inferInsert` types as
`MeshIssueSqlite` / `NewMeshIssueSqlite` / … .

### 2.2 `src/db/activeSchema.ts` — MODIFY (4 sites)

Following the `meshtasticHeardRepeaters` precedent exactly:
1. import the three tables from `./schema/meshIssues.js`;
2. add `meshIssues: any;` to the `ActiveSchema` interface;
3. add `meshIssues: meshIssuesSqlite,` to the sqlite map;
4. …`meshIssuesPostgres` to the pg map and `meshIssuesMysql` to the mysql map.

Also add `export * from './meshIssues.js';` to `src/db/schema/index.ts`.

### 2.3 `src/db/repositories/analysis.ts` — MODIFY (small, additive)

Add `packetId: number | null` to `TracerouteRow`, to the `.select({...})` object
in `getTraceroutes`, and to the `mapped` projection
(`packetId: r.packetId == null ? null : Number(r.packetId)`).

The dedup key locked by the epic is `(packetId, fromNodeNum)`; without this the
sampler cannot be built. The change is additive — `/api/analysis/traceroutes`
gains one field and no consumer breaks.

### 2.4 `src/server/migrations/154_create_mesh_issues.ts` — NEW

Number **154** (registry currently ends at 153). Follow migration 152 exactly.

```
LABEL = 'Migration 154'; TABLE = 'mesh_issues';
UNIQUE_INDEX = 'mesh_issues_type_subject_uniq';
STATUS_INDEX = 'mesh_issues_status_idx';
NODE_INDEX   = 'mesh_issues_node_idx';
```

**SQLite** (`export const migration = { up, down }`):

```sql
CREATE TABLE IF NOT EXISTS mesh_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issueType TEXT NOT NULL,
  subjectKey TEXT NOT NULL,
  nodeNum INTEGER,
  severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  evidence TEXT NOT NULL,
  sourceIds TEXT NOT NULL,
  firstDetected INTEGER NOT NULL,
  lastDetected INTEGER NOT NULL,
  cleanRuns INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  closedAt INTEGER,
  dismissed INTEGER NOT NULL DEFAULT 0,
  dismissedAt INTEGER,
  dismissedBy INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mesh_issues_type_subject_uniq ON mesh_issues(issueType, subjectKey);
CREATE INDEX IF NOT EXISTS mesh_issues_status_idx ON mesh_issues(status, severity);
CREATE INDEX IF NOT EXISTS mesh_issues_node_idx ON mesh_issues(nodeNum);
```

`down`: `DROP TABLE IF EXISTS mesh_issues`.

**PostgreSQL** (`runMigration154Postgres(client)`) — same DDL with
`id SERIAL PRIMARY KEY`, `"issueType" TEXT`, `"subjectKey" TEXT`,
`"nodeNum" BIGINT`, `"firstDetected"/"lastDetected"/"closedAt"/"dismissedAt"/"createdAt"/"updatedAt" BIGINT`,
`dismissed BOOLEAN NOT NULL DEFAULT FALSE`, all identifiers quoted (camelCase),
and `CREATE [UNIQUE] INDEX IF NOT EXISTS`.

**MySQL** (`runMigration154Mysql(pool)`) — `createTableIfMissingMysql(pool, TABLE, ...)`
with inline key clauses (MySQL has no `CREATE INDEX IF NOT EXISTS`; the inline
form inside `createTableIfMissingMysql` is the pattern used by 152):

```sql
CREATE TABLE mesh_issues (
  id INT AUTO_INCREMENT PRIMARY KEY,
  issueType VARCHAR(64) NOT NULL,
  subjectKey VARCHAR(128) NOT NULL,
  nodeNum BIGINT,
  severity VARCHAR(16) NOT NULL,
  confidence VARCHAR(16) NOT NULL,
  evidence TEXT NOT NULL,
  sourceIds TEXT NOT NULL,
  firstDetected BIGINT NOT NULL,
  lastDetected BIGINT NOT NULL,
  cleanRuns INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  closedAt BIGINT,
  dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  dismissedAt BIGINT,
  dismissedBy INT,
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL,
  UNIQUE KEY mesh_issues_type_subject_uniq (issueType, subjectKey),
  INDEX mesh_issues_status_idx (status, severity),
  INDEX mesh_issues_node_idx (nodeNum)
)
```

`varchar` lengths matter: `TEXT` cannot participate in a MySQL UNIQUE KEY
without a prefix length, which is why `issueType`/`subjectKey` are `VARCHAR`.

**Registration** — `src/db/migrations.ts`:

```ts
import { migration as createMeshIssuesMigration, runMigration154Postgres, runMigration154Mysql }
  from '../server/migrations/154_create_mesh_issues.js';
...
registry.register({
  number: 154,
  name: 'create_mesh_issues',
  settingsKey: 'migration_154_create_mesh_issues',
  sqlite: (db) => createMeshIssuesMigration.up(db),
  postgres: (client) => runMigration154Postgres(client),
  mysql: (pool) => runMigration154Mysql(pool),
});
```

`src/db/migrations.test.ts` needs **no** edit (registry-derived assertions).

### 2.5 `src/server/services/meshIssues/types.ts` — NEW

Shared domain types, so the pure analysis modules, the repository and the
frontend contract all agree. Kept dependency-free (no imports from `db/`) so
WP2 can consume it without waiting on the repository.

```ts
export type MeshIssueSeverity = 'info' | 'warning' | 'critical';
export type MeshIssueConfidence = 'low' | 'medium' | 'high';
export type MeshIssueStatus = 'open' | 'closed';

/** Stable machine ids. UI labels live in the frontend types module. */
export const MESH_ISSUE_TYPES = {
  A1_DEPRECATED_ROLE:  'A1_deprecated_role',
  A2A_CHATTY_NODE:     'A2a_chatty_node',
  A2B_CONGESTED_AREA:  'A2b_congested_area',
  A2B_CONGESTED_NODE:  'A2b_congested_node',
  A3_INFRA_POWER:      'A3_infra_power',
  A4_MOBILE_INFRA:     'A4_mobile_infra',
  A5_COSPLAY_ROUTER:   'A5_cosplay_router',
} as const;
export type MeshIssueType = typeof MESH_ISSUE_TYPES[keyof typeof MESH_ISSUE_TYPES];

/** What a rule emits. No persistence fields — the repository owns those. */
export interface MeshIssueFinding {
  issueType: MeshIssueType;
  /** `node:${nodeNum}` or `area:${latBin}:${lonBin}` */
  subjectKey: string;
  nodeNum: number | null;
  severity: MeshIssueSeverity;
  confidence: MeshIssueConfidence;
  /** Serialized to JSON by the repository. Rule-specific shape. */
  evidence: Record<string, unknown>;
  /** Sources whose rows contributed evidence. Sorted, deduped. */
  sourceIds: string[];
  /** Human-readable action, official-guidance-compliant (never "promote to ROUTER"). */
  recommendation: string;
}

export const nodeSubjectKey = (nodeNum: number): string => `node:${nodeNum}`;
export const areaSubjectKey = (latBin: number, lonBin: number): string =>
  `area:${latBin}:${lonBin}`;
```

`recommendation` is stored inside `evidence` on the wire — see §2.9 — so the
column set does not need a `recommendation` column. The repository writes
`JSON.stringify({ ...finding.evidence, recommendation: finding.recommendation })`.

### 2.6 `src/server/services/nodeMobilityService.ts` — MODIFY (behavior-preserving extraction)

A4 needs the same bounding-box span the mobility flag is built on, at a
different threshold (500 m vs the flag's 100 m). Extract, do not duplicate:

```ts
/**
 * Bounding-box span, in kilometers, of a set of position samples (the diagonal
 * of the min/max lat-lon box, Haversine). Returns null with fewer than two
 * latitude AND two longitude samples. Extracted from updateNodeMobility so the
 * mesh-issues A4 rule can apply a different threshold to the same measurement.
 */
export function positionSpanKm(latValues: number[], lonValues: number[]): number | null
```

`updateNodeMobility` then becomes `isMobile = (positionSpanKm(latValues, lonValues) ?? 0) > 0.1 ? 1 : 0`.
The existing `nodeMobilityService.test.ts` must still pass unchanged — that is
the proof the extraction is behavior-preserving.

### 2.7 `src/server/services/meshIssues/tracerouteCorpus.ts` — NEW, pure

Implements the epic's locked pipeline. No I/O, no `databaseService` import.

```ts
import type { TracerouteRow } from '../../../db/repositories/analysis.js'; // type-only

export interface TracerouteSample extends TracerouteRow {
  routeHops: number[];
  routeBackHops: number[];
  snrTowardsValues: number[];
  snrBackValues: number[];
  /** `${min(from,to)}-${max(from,to)}` */
  pairKey: string;
  /** floor(timestamp / bucketMs) */
  bucket: number;
}

export interface TracerouteCorpusStats {
  rawCount: number;
  validCount: number;
  dedupedCount: number;
  sampledCount: number;
  distinctPairCount: number;
  /** True when the caller stopped paginating at the page cap (see §2.10 step 5). */
  truncated: boolean;
}

export interface BuildTracerouteCorpusOptions {
  pairBucketHours: number;   // clamped 1..24 by the caller
  truncated?: boolean;       // passed through into stats
}

export function buildTracerouteCorpus(
  rows: TracerouteRow[],
  opts: BuildTracerouteCorpusOptions,
): { samples: TracerouteSample[]; stats: TracerouteCorpusStats };
```

**Stage 1 — validity filter.** Drop a row unless all hold:
- `hasRouteData(row.route)` is true;
- `isValidRouteNode(fromNodeNum)` and `isValidRouteNode(toNodeNum)`;
- neither endpoint is `BROADCAST_ADDR`;
- `fromNodeNum !== toNodeNum` (no self-traces);
- every hop in `parseHopArray(route)` and `parseHopArray(routeBack)` satisfies
  `isValidRouteNode` and is not `BROADCAST_ADDR`.

**Stage 2 — exact dedup by `(packetId, fromNodeNum)`.** Group key:
`` row.packetId == null ? `row:${row.id}` : `${row.packetId}:${row.fromNodeNum}` ``.
A null `packetId` cannot be correlated across sources, so each such row is its
own group (never merged, never dropped). Within a group keep the **most
complete** copy, ranked in this order:
1. `routeBack` present and non-empty (`parseHopArray(routeBack).length > 0`);
2. more non-empty SNR arrays (`snrTowardsValues.length > 0` + `snrBackValues.length > 0`, count 0-2);
3. longer `routeHops`;
4. newest `timestamp`;
5. highest `id` (deterministic tiebreak — tests depend on it).

**Stage 3 — stratified cap: 1 per (unordered pair, bucket).**
`bucketMs = pairBucketHours * 3600_000`; `bucket = Math.floor(timestamp / bucketMs)`;
`pairKey` uses the *unordered* endpoint pair. Within each `(pairKey, bucket)`
cell keep one winner using the **same** ranking function as stage 2 (extract it
as a module-private `compareCompleteness(a, b)` and use it in both places).

Output `samples` sorted by `(timestamp desc, id desc)`; `distinctPairCount` =
number of distinct `pairKey` values in `samples`.

No recency decay — the cap already flattens frequency bias (epic, locked).

Phase 1 has no rule consuming `samples`; the service computes the corpus so
`stats` can be surfaced on the status endpoint (a live consumer that proves the
pipeline end-to-end) and Phase 2's Tier B graph builder can drop straight in.

### 2.8 `src/server/services/meshIssues/nodeSnapshot.ts` — NEW, pure

```ts
export interface PooledNodeInput {
  nodeNum: number | string; nodeId: string; sourceId: string;
  longName?: string | null; shortName?: string | null; hwModel?: number | null;
  role?: number | null; isUnmessagable?: boolean | number | null;
  firmwareVersion?: string | null;
  batteryLevel?: number | null; voltage?: number | null;
  channelUtilization?: number | null; airUtilTx?: number | null;
  latitude?: number | null; longitude?: number | null;
  positionOverrideEnabled?: boolean | number | null;
  latitudeOverride?: number | null; longitudeOverride?: number | null;
  positionPrecisionBits?: number | null;
  mobile?: number | null; lastHeard?: number | null; updatedAt?: number | null;
}

export interface PooledNode {
  nodeNum: number; nodeId: string;
  longName: string | null; shortName: string | null; hwModel: number | null;
  role: number | null; isUnmessagable: boolean; firmwareVersion: string | null;
  batteryLevel: number | null; voltage: number | null;
  channelUtilization: number | null; airUtilTx: number | null;
  latitude: number | null; longitude: number | null;
  positionPrecisionBits: number | null;
  mobile: boolean;
  /** max across rows — the freshness proxy; see below. */
  lastHeardMs: number | null;
  sourceIds: string[];  // sorted, deduped
}

export function buildPooledNodeSnapshot(rows: PooledNodeInput[]): Map<number, PooledNode>;
```

**Merge rules** (document each in JSDoc):
- Key: `Number(row.nodeNum)` — PG/MySQL return BIGINT; the `Number()` coercion is
  mandatory (CLAUDE.md multi-database rule).
- **Freshness proxy.** There is no NodeInfo-receipt-time column on `nodes`. Use
  `freshness = row.lastHeard ?? row.updatedAt ?? 0` (`lastHeard` is unix
  **seconds** in this schema — normalize to ms as `lastHeard * 1000` when it is
  below `1e12`). State this proxy explicitly in the module header; A1's
  `nodeInfoAgeMs` evidence field is derived from it and is labelled
  "last heard" in the UI, not "NodeInfo age", so the report never overstates it.
- **Newest-NodeInfo-wins, per field:** `longName`, `shortName`, `hwModel`,
  `role`, `isUnmessagable`, `firmwareVersion`, `batteryLevel`, `voltage`,
  `channelUtilization`, `airUtilTx`, position — for each field independently,
  take the value from the highest-freshness row **that has a non-null value for
  that field**. A source that has a name but no role must not blank the role.
- Position: run `getEffectiveDbNodePosition(row)` per row first, then apply the
  newest-wins rule to the resulting `(latitude, longitude)` pair *as a pair*
  (never mix lat from one source with lon from another).
- `positionPrecisionBits`: **min** across non-null values (worst precision wins —
  it is a guard input, so be conservative).
- `mobile`: logical OR across rows (mobility is a physical property).
- `sourceIds`: union, sorted ascending.

**Telemetry series builder** (same file):

```ts
export interface TelemetrySample { timestamp: number; value: number; sourceId: string; }
export interface NodeTelemetrySeries {
  airUtilTx: TelemetrySample[];
  channelUtilization: TelemetrySample[];
  batteryLevel: TelemetrySample[];
  uptimeSeconds: TelemetrySample[];
}
export const MESH_ISSUE_TELEMETRY_TYPES =
  ['airUtilTx', 'channelUtilization', 'batteryLevel', 'uptimeSeconds'] as const;

export function buildTelemetrySeries(
  rows: Array<{ nodeNum: number | string; telemetryType: string; timestamp: number | string;
                value: number; sourceId?: string | null }>,
): Map<number, NodeTelemetrySeries>;
```

- Coerce `nodeNum` and `timestamp` with `Number()`.
- **Cross-source dedup (epic: "newest per timestamp"):** collapse rows with an
  identical `(nodeNum, telemetryType, timestamp)` to one sample. These are the
  same self-reported reading arriving via TCP and via N MQTT gateways. Keep the
  first encountered after sorting by `(timestamp asc, sourceId asc)` — a
  deterministic choice; record all contributing `sourceId`s at the *finding*
  level, not the sample level.
- Each series sorted ascending by `timestamp`.

### 2.9 `src/server/services/meshIssues/thresholds.ts` + `rules.ts` — NEW, pure

#### `thresholds.ts`

Every constant carries a one-line JSDoc ending in `[official]` or `[ours]`.
`[official]` means it comes from the Meshtastic ROUTER_LATE blog post; every
other number is ours and is tunable (settings UI is Phase 3).

```ts
/** Mean airUtilTx above which a node is "chatty", percent. [official] */
export const AIR_UTIL_TX_PCT_THRESHOLD = 8;
/** Minimum airUtilTx samples in-window before A2a may fire. [ours] */
export const AIR_UTIL_TX_MIN_SAMPLES = 6;
/** A2a/A2b metric window, hours. [ours] */
export const UTILIZATION_WINDOW_HOURS = 24;
/** Mean channelUtilization above which an area is congested, percent. [official] */
export const CHANNEL_UTIL_PCT_THRESHOLD = 25;
/** Minimum nodes in a geographic bin before A2b is an AREA finding. [ours] */
export const CONGESTED_AREA_MIN_NODES = 3;
/** Geographic bin size for A2b clustering, degrees (~5.5 km of latitude). [ours] */
export const AREA_GRID_BIN_DEG = 0.05;
/** Battery percent below which an infra node counts as deep-discharging. [ours] */
export const BATTERY_LOW_PCT = 20;
/** Minimum batteryLevel samples in-window before the A3 battery clause fires. [ours] */
export const BATTERY_MIN_SAMPLES = 3;
/** Uptime resets in the A3 window that make a power problem a warning. [ours] */
export const UPTIME_RESET_MIN_COUNT = 2;
/** A3/A4 window, hours (7 days). [ours] */
export const POWER_WINDOW_HOURS = 168;
/** Bounding-box span above which an infra node counts as mobile, meters. [ours] */
export const MOBILE_SPAN_METERS = 500;
/**
 * Minimum position precision bits before A4 trusts a computed span. At 16 bits
 * a position cell is 360/2^16 deg ~= 610 m, which straddles MOBILE_SPAN_METERS,
 * so truncated positions could fabricate "movement". 17 bits ~= 305 m. [ours]
 */
export const MOBILE_MIN_PRECISION_BITS = 17;
/** Firmware version at/after which `is_unmessagable` is meaningful. [ours] */
export const UNMESSAGABLE_MIN_FIRMWARE = '2.5.0';
/** Consecutive clean runs before an open finding auto-closes. [ours] */
export const AUTO_CLOSE_CLEAN_RUNS = 3;
/** Roles that carry routing responsibility. Built from DeviceRole. */
export const INFRA_ROLES: ReadonlySet<number>;      // ROUTER, ROUTER_CLIENT, REPEATER, ROUTER_LATE
/** Roles the firmware documentation now deprecates for new deployments. */
export const DEPRECATED_ROLES: ReadonlySet<number>; // ROUTER_CLIENT, REPEATER
/** Dedicated-infrastructure roles that SHOULD be unmessagable (A5). */
export const DEDICATED_ROUTER_ROLES: ReadonlySet<number>; // ROUTER, ROUTER_LATE
```

Build the sets from `DeviceRole` (`src/constants/index.ts`) — no literal ints.

#### `rules.ts`

```ts
export interface RuleContext {
  nodes: Map<number, PooledNode>;
  telemetry: Map<number, NodeTelemetrySeries>;
  /** nodeNum -> bounding-box span in meters, present only for infra-role nodes (A4). */
  positionSpanMeters: Map<number, number>;
  nowMs: number;
}

export function evaluateA1(ctx: RuleContext): MeshIssueFinding[];
export function evaluateA2a(ctx: RuleContext): MeshIssueFinding[];
export function evaluateA2b(ctx: RuleContext): MeshIssueFinding[];
export function evaluateA3(ctx: RuleContext): MeshIssueFinding[];
export function evaluateA4(ctx: RuleContext): MeshIssueFinding[];
export function evaluateA5(ctx: RuleContext): MeshIssueFinding[];
/** A1..A5 in order. Never throws; a rule that cannot evaluate returns []. */
export function evaluateAllTierA(ctx: RuleContext): MeshIssueFinding[];
```

Epic Tier A table, copied verbatim, followed by the exact Phase 1 predicate:

---

**A1 — Deprecated role in use (REPEATER=4, ROUTER_CLIENT=3).**
*Threshold: —. Guard: note NodeInfo age in evidence.*

- Predicate: `node.role != null && DEPRECATED_ROLES.has(node.role)`.
- Severity `warning`, confidence `high`.
- Evidence: `{ role, roleName, lastHeardAgeMs, sources }` where `lastHeardAgeMs
  = nowMs - node.lastHeardMs` (null when `lastHeardMs` is null). Per the guard,
  the age is **recorded only** — it does not change severity.
- Recommendation: REPEATER → `"Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE."`;
  ROUTER_CLIENT → `"Consider CLIENT, or CLIENT_BASE if the node is fixed and powered."`
- Subject: `nodeSubjectKey(nodeNum)`.

**A2a — Chatty node: mean `airUtilTx` > 8% over 24 h, ≥6 samples.**
*[official]. Guard: node-attributed; self-reported metric, newest per timestamp.*

- Window: samples with `timestamp >= nowMs - UTILIZATION_WINDOW_HOURS*3600_000`.
  (`telemetry.timestamp` is ms in this schema.)
- Predicate: `samples.length >= AIR_UTIL_TX_MIN_SAMPLES && mean > AIR_UTIL_TX_PCT_THRESHOLD`.
- Severity `warning`, confidence `medium`.
- Evidence: `{ meanAirUtilTx, maxAirUtilTx, sampleCount, windowHours, sources }`.
- Recommendation: `"This node is transmitting a large share of the channel's airtime. Review its position/telemetry broadcast intervals and any auto-responder."`
- The "newest per timestamp" guard is satisfied by `buildTelemetrySeries`'s
  cross-source collapse (§2.8) — the rule does **not** re-implement it.

**A2b — Congested area: ≥3 nodes in a geographic cluster with mean `channelUtilization` > 25%.**
*[official]. Guard: attributed to the AREA, not a node; single node = info.*

- Position per node from `PooledNode.latitude/longitude`; skip when either is
  null or `isBogusPosition(lat, lon, positionPrecisionBits)` is true.
- Bin: `latBin = Math.floor(lat / AREA_GRID_BIN_DEG)`, `lonBin = Math.floor(lon / AREA_GRID_BIN_DEG)`.
  (Integer bin indices, so `areaSubjectKey` is stable across runs. Deliberately
  simpler than `AnalysisRepository.getCoverageGrid`'s zoom-derived binning,
  which is tuned for map rendering, not clustering.)
- Per node in the bin: mean `channelUtilization` over the same 24 h window,
  computed only for nodes with ≥1 sample. `binMean` = mean of those per-node means.
- **Area finding** when `qualifyingNodes.length >= CONGESTED_AREA_MIN_NODES &&
  binMean > CHANNEL_UTIL_PCT_THRESHOLD`: type `A2b_congested_area`,
  subject `areaSubjectKey(latBin, lonBin)`, `nodeNum: null`, severity `warning`,
  confidence `medium`. Evidence `{ latBin, lonBin, centerLat, centerLon,
  binSizeDeg, nodeCount, meanChannelUtilization, nodes: [{ nodeNum, longName,
  meanChannelUtilization }], windowHours, sources }`.
- **Single/pair node fallback (the guard's "single node = info"):** for a bin
  with fewer than `CONGESTED_AREA_MIN_NODES` qualifying nodes, emit one
  `A2b_congested_node` **info** finding per node whose own mean exceeds the
  threshold — subject `nodeSubjectKey(nodeNum)`, confidence `low`,
  evidence `{ meanChannelUtilization, sampleCount, windowHours, binNodeCount, sources }`.
- Recommendations: area → `"This area's channel utilization is above the healthy 25% ceiling. Look for over-broadcasting nodes and redundant routers here rather than adding more infrastructure."`; node → `"One node reports high channel utilization; not enough neighbors in this area to confirm area-wide congestion."`
- A node with no position is excluded from A2b entirely (it cannot be clustered).

**A3 — Infra role on failing power: battery ≠ 101 AND (≥2 uptime resets in 7 d OR battery < 20%).**
*[ours]. Guard: solar cycles battery% but stays up — require resets/deep discharge; battery-only clean-uptime = info.*

- Gate: `node.role != null && INFRA_ROLES.has(node.role) && !isPowered(node.batteryLevel)`.
  (`isPowered` encodes the firmware `>100` convention, i.e. the "battery ≠ 101" clause.)
- Window: `POWER_WINDOW_HOURS` (7 d).
- `uptimeResets` = count of adjacent pairs `(prev, next)` in the ascending
  `uptimeSeconds` series where `isUptimeReboot(prev.value, next.value)` is true.
- `minBatteryLevel` = min over in-window `batteryLevel` samples;
  `batterySampleCount` = their count.
- Fire when `uptimeResets >= UPTIME_RESET_MIN_COUNT`
  **OR** (`batterySampleCount >= BATTERY_MIN_SAMPLES && minBatteryLevel < BATTERY_LOW_PCT`).
- Severity per the guard: `warning` (confidence `medium`) when the reset clause
  is satisfied; `info` (confidence `low`) when only the battery clause is
  ("battery-only clean-uptime = info").
- Evidence: `{ role, roleName, uptimeResets, uptimeSampleCount, minBatteryLevel,
  latestBatteryLevel, batterySampleCount, windowHours, clause: 'resets' | 'battery', sources }`.
- Recommendation: `"An infrastructure node on battery power is resetting or deep-discharging. Verify the power budget, or move the role to CLIENT until power is reliable."`

**A4 — Mobile node with infra role. 500 m [ours].**
*Guard: reuse `nodeMobilityService` classification (handles precision truncation).*

- Gate: `node.role != null && INFRA_ROLES.has(node.role)`.
- Precision guard: skip when `node.positionPrecisionBits != null &&
  node.positionPrecisionBits < MOBILE_MIN_PRECISION_BITS` — a truncated position
  can fabricate a 500 m span (see the constant's JSDoc for the arithmetic).
- Span: `ctx.positionSpanMeters.get(nodeNum)`, computed by the service via
  `positionSpanKm` (§2.6) over `getPositionTelemetryByNode(nodeId, 500, undefined, ALL_SOURCES)`
  — the *same* accessor and sample cap `nodeMobilityService` uses, so the two
  classifications can never disagree about the underlying data.
- Fire when `span > MOBILE_SPAN_METERS`. The persisted `node.mobile` flag (the
  100 m classification) is carried in evidence for corroboration but is **not**
  a gate — a node can exceed 500 m before the flag's next refresh.
- Severity `warning`, confidence `medium`.
- Evidence: `{ role, roleName, spanMeters, positionSampleCount, mobileFlag,
  positionPrecisionBits, sources }`.
- Recommendation: `"A node that moves should be CLIENT. Routing roles assume a fixed, well-sited antenna."`

**A5 — Cosplay router: ROUTER with `isUnmessagable=false` OR unsolicited-telemetry median interval ≪ 12 h (< 2 h).**
*[ours], low confidence. Guard: MUST exclude telemetry MeshMonitor solicited; if not separable, fire only on `isUnmessagable`.*

**Phase 1 fires on the `isUnmessagable` clause only.** The telemetry-cadence
clause is deferred — see §5 for the investigation that established it.

- Gate: `node.role != null && DEDICATED_ROUTER_ROLES.has(node.role)` (ROUTER,
  ROUTER_LATE — `ROUTER_CLIENT` is *meant* to be messagable, and `REPEATER` does
  not run the client stack, so neither belongs in this rule).
- Firmware guard: skip when `node.firmwareVersion` is null, or when
  `compareVersions(node.firmwareVersion, UNMESSAGABLE_MIN_FIRMWARE) < 0` —
  `is_unmessagable` did not exist before then, so `false` there means "unknown",
  not "messagable", and would fire on every old node.
- Fire when `node.isUnmessagable === false`.
- Severity `info`, confidence `low` (locked by the epic).
- Evidence: `{ role, roleName, isUnmessagable: false, firmwareVersion,
  lastHeardAgeMs, telemetryCadenceClause: 'deferred', sources }`.
- Recommendation: `"A dedicated router normally advertises itself as unmessagable. If this is someone's handheld running a routing role, CLIENT is the right role."`

---

`evaluateAllTierA` wraps each rule in try/catch, logs a warning through the
caller's injected logger (or simply lets the service log), and returns the union.
A single rule throwing must not lose the other four.

### 2.10 `src/server/services/meshIssuesAnalysisService.ts` — NEW

```ts
export interface MeshIssuesRunOptions {
  lookbackHours: number;     // clamped by the scheduler
  pairBucketHours: number;   // clamped by the scheduler
  nowMs?: number;            // test seam; defaults to Date.now()
}

export interface MeshIssuesRunResult {
  durationMs: number;
  sourceCount: number;
  nodeCount: number;
  findingCount: number;
  newCount: number;
  reopenedCount: number;
  updatedCount: number;
  closedCount: number;
  byType: Record<string, number>;
  corpusStats: TracerouteCorpusStats;
}

class MeshIssuesAnalysisService {
  async runAnalysis(opts: MeshIssuesRunOptions): Promise<MeshIssuesRunResult>;
}
export const meshIssuesAnalysisService = new MeshIssuesAnalysisService();
```

Header comment must state: passive, zero packets, zero events emitted.

Steps:

1. **Sources.** `getAllSources()` → keep `enabled !== false` and
   `type === 'meshtastic_tcp' || isMqttSourceType(type)`. MeshCore and Reticulum
   are excluded (they do not write `nodes`/`telemetry`; MeshCore lives in
   `meshcore_nodes`). Empty set → return a zeroed result immediately.
2. **Nodes.** `// intentional cross-source: findings pool physical nodes across every Meshtastic source`
   `databaseService.nodes.getAllNodes(ALL_SOURCES)`, filtered to the resolved
   source ids, → `buildPooledNodeSnapshot`.
3. **Telemetry.** `getTelemetryByTypesSince(MESH_ISSUE_TELEMETRY_TYPES, nowMs - lookbackHours*3600_000, sourceIds)`
   → `buildTelemetrySeries`. One query; do not loop per node.
4. **Position spans (A4 input).** For infra-role nodes only, in a bounded
   `Promise.all` over chunks of 25:
   `getPositionTelemetryByNode(nodeId, 500, undefined, ALL_SOURCES)` →
   split `latitude`/`longitude` rows → `positionSpanKm(lats, lons)` → `* 1000`.
   Infra nodes are a small fraction of the DB; a full-mesh per-node loop would
   not be acceptable and is not what this does.
5. **Traceroute corpus.** Paginate `databaseService.analysis.getTraceroutes({ sourceIds, sinceMs, pageSize: 2000, cursor })`
   until `hasMore === false` or `MAX_CORPUS_PAGES = 25` pages (50 000 rows) —
   set `truncated: true` when the cap stops the loop. Pass rows +
   `{ pairBucketHours, truncated }` to `buildTracerouteCorpus`. Phase 1 keeps
   `stats` only.
6. **Evaluate.** `evaluateAllTierA({ nodes, telemetry, positionSpanMeters, nowMs })`.
7. **Persist.**
   - For each finding: `databaseService.meshIssues.upsertFinding(finding, nowMs)`;
     tally its returned `outcome` into `newCount` / `reopenedCount` / `updatedCount`.
   - Load `getIssues({ includeClosed: false, includeDismissed: true })`; for every
     row whose `(issueType, subjectKey)` is not in the finding set, call
     `bumpCleanRun(row.id, AUTO_CLOSE_CLEAN_RUNS, nowMs)` and count the ones that
     returned `closed: true`.
   - Dismissed rows still participate in clean-run bookkeeping (so a dismissed
     issue that resolves eventually closes) but are never re-opened by an upsert
     into `dismissed = false`; the repository preserves `dismissed`.
8. Return the result. Throw on unexpected failure — the scheduler owns
   logging and last-run recording.

### 2.11 `src/server/services/meshIssuesScheduler.ts` — NEW

A structural clone of `positionEstimationScheduler.ts`. Differences only in
names, keys, defaults and clamps.

```ts
const LAST_RUN_KEY = 'mesh_issues_last_run';
export const DEFAULT_FREQUENCY_HOURS = 24;
export const DEFAULT_LOOKBACK_HOURS  = 168;   // 7 days
export const DEFAULT_PAIR_BUCKET_HOURS = 6;
const MIN_FREQUENCY_HOURS = 1;
const MIN_LOOKBACK_HOURS = 24,  MAX_LOOKBACK_HOURS = 720;
const MIN_PAIR_BUCKET_HOURS = 1, MAX_PAIR_BUCKET_HOURS = 24;
const CHECK_INTERVAL_MS = 60_000;

/** Pure due-check. Identical semantics to positionEstimationScheduler.isRunDue. */
export function isRunDue(lastRunMs: number | null, frequencyHours: number, nowMs: number): boolean;

/** Pure clamps — exported so the unit tests can hit them directly. */
export function clampLookbackHours(raw: unknown): number;
export function clampPairBucketHours(raw: unknown): number;
export function clampFrequencyHours(raw: unknown): number;

export interface MeshIssuesStatus {
  running: boolean; inProgress: boolean; enabled: boolean;
  frequencyHours: number; lookbackHours: number; pairBucketHours: number;
  lastRunTime: number | null; lastRunResult: MeshIssuesRunResult | null;
}

class MeshIssuesScheduler {
  initialize(): void; start(): void; stop(): void;
  async runNow(): Promise<MeshIssuesRunResult>;   // throws 'Mesh issues analysis already in progress'
  async getStatus(): Promise<MeshIssuesStatus>;
}
export const meshIssuesScheduler = new MeshIssuesScheduler();
```

Non-negotiable details carried from the model:
- `mesh_issues_enabled` is **default ON**: `value !== 'false'`.
- `getLastRun()` prefers the in-memory `lastRunTime` and otherwise reads the
  settings key — the timer survives a process restart (mesh-impact checklist §3).
- `execute()` writes `LAST_RUN_KEY` in a `finally`, on success **and** failure,
  so a failing run cannot become a retry storm.
- `runNow()` throws when `runLock` is set; the route turns that into a 409.
- Out-of-range / unparseable settings clamp to the default rather than throwing.

### 2.12 `src/server/constants/settings.ts` — MODIFY

Add to `VALID_SETTINGS_KEYS` (next to the `position_estimation_*` block):

```
'mesh_issues_enabled',
'mesh_issues_frequency_hours',
'mesh_issues_lookback_hours',
'mesh_issues_pair_bucket_hours',
'mesh_issues_last_run',
```

Add the same five to `GLOBAL_ONLY_SETTINGS_KEYS` — the analysis is a global
batch job with no per-source variant, exactly like `position_estimation_*`
(which is already listed there). Omitting this would let a per-source write
shadow the global value.

### 2.13 `src/server/server.ts` — MODIFY (2 sites)

1. Beside the `positionEstimationScheduler.initialize()` block (~line 363):

```ts
// Initialize mesh issues analysis scheduler (global, batch, passive — issue #4964)
meshIssuesScheduler.initialize();
logger.debug('Mesh issues scheduler initialized');
```

2. Beside the other route mounts (~line 823):

```ts
apiRouter.use('/analysis/mesh-issues', meshIssuesRoutes);
```

Both imports need the explicit `.js` extension (CLAUDE.md hard rule).

### 2.14 `src/db/repositories/meshIssues.ts` — NEW

```ts
export interface DbMeshIssue {
  id: number;
  issueType: string; subjectKey: string; nodeNum: number | null;
  severity: MeshIssueSeverity; confidence: MeshIssueConfidence;
  evidence: string;      // JSON text as stored
  sourceIds: string;     // JSON text as stored
  firstDetected: number; lastDetected: number;
  cleanRuns: number; status: MeshIssueStatus; closedAt: number | null;
  dismissed: boolean; dismissedAt: number | null; dismissedBy: number | null;
  createdAt: number; updatedAt: number;
}

export type UpsertOutcome = 'created' | 'updated' | 'reopened';

export interface GetIssuesOptions {
  includeClosed?: boolean;     // default false
  includeDismissed?: boolean;  // default false
}

export class MeshIssuesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType);

  /** Insert or refresh one finding. Never clears `dismissed`. */
  async upsertFinding(finding: MeshIssueFinding, nowMs: number)
    : Promise<{ issue: DbMeshIssue; outcome: UpsertOutcome }>;

  /** Findings, newest-detected first. */
  async getIssues(opts?: GetIssuesOptions): Promise<DbMeshIssue[]>;

  async getIssueById(id: number): Promise<DbMeshIssue | null>;

  /**
   * Record one run in which this finding was NOT re-detected.
   * Increments `cleanRuns`; when it reaches `autoCloseAfter`, sets
   * status='closed' and closedAt=nowMs. Returns whether it closed.
   */
  async bumpCleanRun(id: number, autoCloseAfter: number, nowMs: number)
    : Promise<{ cleanRuns: number; closed: boolean }>;

  /** Phase 3 UI; implemented and tested now so no follow-up migration is needed. */
  async setDismissed(id: number, dismissed: boolean, userId: number | null, nowMs: number): Promise<void>;

  async deleteAll(): Promise<number>;
}
```

`upsertFinding` semantics (select-then-insert-or-update, the pattern
`meshtasticHeardRepeaters.recordHeardRepeater` uses — portable across all three
dialects, no `ON CONFLICT` dialect branching):

| Existing row | Action | `outcome` |
|---|---|---|
| none | insert with `firstDetected = lastDetected = createdAt = updatedAt = nowMs`, `cleanRuns = 0`, `status = 'open'`, `dismissed = false` | `created` |
| `status = 'open'` | update `severity`, `confidence`, `evidence`, `sourceIds`, `lastDetected = nowMs`, `updatedAt = nowMs`, `cleanRuns = 0`. `firstDetected` and `dismissed` untouched. | `updated` |
| `status = 'closed'` | same as above **plus** `status = 'open'`, `closedAt = null`. `firstDetected` untouched (the original first sighting is the useful fact). | `reopened` |

`evidence` is written as
`JSON.stringify({ ...finding.evidence, recommendation: finding.recommendation })`;
`sourceIds` as `JSON.stringify([...finding.sourceIds].sort())`.

Reads must run every row through `this.normalizeBigInts(...)` and coerce
`nodeNum` with `Number()` (PG/MySQL BIGINT).

### 2.15 `src/db/repositories/index.ts` and `src/services/database.ts` — MODIFY

`index.ts`: `export { MeshIssuesRepository } from './meshIssues.js';` plus the
type re-exports, following the `meshtasticHeardRepeaters` lines.

`database.ts` (4 sites, mirroring `estimatedPositionsRepo`):
1. import `MeshIssuesRepository`;
2. `public meshIssuesRepo: MeshIssuesRepository | null = null;`
3. `get meshIssues(): MeshIssuesRepository { if (!this.meshIssuesRepo) throw new Error('Database not initialized'); return this.meshIssuesRepo; }`
4. construct it in the same block that builds the other repositories
   (`this.meshIssuesRepo = new MeshIssuesRepository(drizzleDb, this.drizzleDbType);`).

Async facade methods (CLAUDE.md: "Expose through DatabaseService with `Async` suffix"):

```ts
async getMeshIssuesAsync(opts?: GetIssuesOptions): Promise<DbMeshIssue[]>
async upsertMeshIssueFindingAsync(finding: MeshIssueFinding, nowMs: number): Promise<{ issue: DbMeshIssue; outcome: UpsertOutcome }>
async bumpMeshIssueCleanRunAsync(id: number, autoCloseAfter: number, nowMs: number): Promise<{ cleanRuns: number; closed: boolean }>
async setMeshIssueDismissedAsync(id: number, dismissed: boolean, userId: number | null, nowMs: number): Promise<void>
```

### 2.16 `src/server/routes/meshIssuesRoutes.ts` — NEW

Mounted at `/api/analysis/mesh-issues`. Header comment states, like
`surveyRoutes.ts`, that this surface is read-only and passive and therefore
carries no TX guard.

```ts
const router = Router();
router.use(optionalAuth());
```

Copy `resolvePermittedSourceIds(req, 'nodes')` and `parseSourcesParam` from
`analysisRoutes.ts` into this module (they are module-private there; do not
refactor `analysisRoutes.ts` in this phase).

**Why source filtering at all, on a global table?** Findings carry no
`sourceId`, but their **evidence** names the sources it came from. A user with
read access to only source B must not see a finding assembled entirely from
source A's rows (the cross-source permission leak of #3745). So:

#### `GET /api/analysis/mesh-issues`

- `permitted = await resolvePermittedSourceIds(req, 'nodes')`.
- `permitted.length === 0` → `fail(res, 403, 'NO_PERMITTED_SOURCES', 'No sources readable by this user')`.
- Optional `?includeClosed=true` (default false). Dismissed always excluded in Phase 1.
- Load via `databaseService.getMeshIssuesAsync({ includeClosed, includeDismissed: false })`.
- For each row: `JSON.parse` `evidence` and `sourceIds`; intersect `sourceIds`
  with `permitted`. Drop the row when the intersection is empty; otherwise
  return the **intersection** as `sourceIds` (never the full list).
- A malformed `evidence`/`sourceIds` JSON must not 500 the endpoint: fall back to
  `{}` / `[]`, log a warning, and (for `sourceIds`) drop the row (fail closed).
- `ok(res, { issues, counts })` where
  `counts = { critical, warning, info, total }` computed over the returned set.

Wire shape of one issue (frozen — WP5 codes against this):

```ts
{
  id: number;
  issueType: string;
  subjectKey: string;
  nodeNum: number | null;
  nodeName: string | null;        // longName ?? shortName ?? `!hex`, resolved server-side
  severity: 'info' | 'warning' | 'critical';
  confidence: 'low' | 'medium' | 'high';
  evidence: Record<string, unknown>;   // parsed; includes `recommendation`
  sourceIds: string[];                 // intersected with the caller's permissions
  firstDetected: number;
  lastDetected: number;
  status: 'open' | 'closed';
}
```

`nodeName` is resolved from `databaseService.nodes.getAllNodes(ALL_SOURCES)`
(one call, built into a `Map<number, string>`) so the report does not need a
second round trip.

#### `GET /api/analysis/mesh-issues/status`

Same permitted-sources gate (403 when empty). `ok(res, await meshIssuesScheduler.getStatus())`.

#### `POST /api/analysis/mesh-issues/run-now`

`requirePermission('settings', 'write')` — matches
`/api/settings/position-estimation/run-now`, the closest precedent for
"trigger a global batch job".

```ts
try {
  const result = await meshIssuesScheduler.runNow();
  void databaseService.auditLogAsync(req.user!.id, 'mesh_issues_run', 'settings',
    `Ran mesh issues analysis: ${result.findingCount} finding(s)`, req.ip || null, null,
    JSON.stringify(result));
  ok(res, result);
} catch (error) {
  if (error instanceof Error && /in progress/.test(error.message)) {
    return fail(res, 409, 'MESH_ISSUES_RUN_IN_PROGRESS', 'Mesh issues analysis already in progress');
  }
  logger.error('[API] Error running mesh issues analysis:', error);
  fail(res, 500, 'MESH_ISSUES_RUN_FAILED', 'Failed to run mesh issues analysis');
}
```

No new rate limiter: the global `apiLimiter` already wraps `/api`, and the
service's `runLock` makes concurrent runs impossible. The job sends no packets,
so the mesh-impact checklist adds no cap here.

### 2.17 `src/components/Analysis/meshIssueTypes.ts` — NEW

Types-only sibling (precedent: `mqttViolationTypes.ts`): the wire interfaces
from §2.16, plus

```ts
export const SEVERITY_ORDER = ['critical', 'warning', 'info'] as const;
export const ISSUE_TYPE_LABELS: Record<string, string>;   // 'A1_deprecated_role' -> 'Deprecated role'
export const ISSUE_TYPE_BLURBS: Record<string, string>;   // one sentence per rule
```

### 2.18 `src/components/Analysis/MeshIssuesReport.tsx` — NEW

Pattern-matched to `SolarMonitoringReport.tsx`:

- `useQuery` + `apiService.get<{ success: boolean; data: MeshIssuesResponse }>('/api/analysis/mesh-issues')`.
  **`ApiService.request()` does not unwrap `data`** (CLAUDE.md) — read `body.data`.
- Layout: `.reports-page` → `.reports-header` → `.reports-controls`
  (a "Run analysis now" button, shown only when the status call reports the
  user may run it; a 403/401 simply hides it) → `.reports-body`.
- A `.reports-banner--empty` state ("No mesh issues detected") and a
  `.reports-banner--error` state.
- Findings grouped by severity in `SEVERITY_ORDER`; within a group sorted by
  `lastDetected` desc. Each group is a `<section>` with a heading and a count.
- Each finding renders as a `.reports-node` card: title = `ISSUE_TYPE_LABELS[issueType]`,
  subtitle = `nodeName ?? subjectKey`, a severity badge, a confidence badge, the
  recommendation, and the remaining `evidence` entries as `.reports-node__fields`
  label/value pills (skip `recommendation`; format numbers to 1–2 dp; render
  `sources` as the source-id list).
- **Raw `fetch()` is banned in `src/components/**`** — use `apiService` only.
- **No coverage preface and no dismiss UI** (both Phase 3).
- Icons via `UiIcon` only; no emoji or Unicode stand-ins (CLAUDE.md hard rule).
- Severity/confidence badge styling goes in a **new** `MeshIssuesReport.module.css`
  (CSS containment rule #3962 5.6). Structural classes reuse `analysis-reports.css`.
  Colors must use `var(--color-*)` tokens **with no fallback value** (see the
  map-sidebar lesson) so themes apply.

### 2.19 `src/components/Analysis/AnalysisTab.tsx` — MODIFY

- `type AnalysisType = 'solar-monitoring' | 'nodeinfo-enrichment' | 'mqtt-oktomqtt-violations' | 'mesh-issues' | null;`
- Append to `reports`:
  ```ts
  {
    id: 'mesh-issues',
    title: t('analysis.mesh_issues.title', 'Mesh Issues'),
    description: t('analysis.mesh_issues.description',
      'Flag wrongly-roled or poorly placed routers, airtime abusers, and infrastructure nodes on failing power — from passively collected data only.'),
    icon: 'alert',
  }
  ```
  (`alert` is a real `UiIconName`; verify against `UI_ICON_DEFINITIONS` before use.)
- Add the matching `if (selected === 'mesh-issues')` branch, copying the
  existing back-button wrapper verbatim.
- No `src/locales/*.json` edit — this tab uses inline `t(key, default)` fallbacks
  throughout, and there is no `analysis` section in `en.json` today.

---

## 3. Test plan

All tests are standard Vitest files in the normal suite. Nothing new in
`tests/system-tests.sh` (no device comms, no release chore).

| File | Kind | Must cover |
|------|------|-----------|
| `src/server/migrations/154_create_mesh_issues.test.ts` | SQLite migration | Table + all 18 columns exist after `migration.up`; the three indexes exist; running `up` twice is a no-op (idempotency); `down` drops. Model: `152_create_meshtastic_heard_repeaters.test.ts`. |
| `src/server/migrations/154_create_mesh_issues.pgmysql.test.ts` | PG/MySQL migration | `describe.skipIf` on the `test-utils.ts` availability probes; column set + unique index enforcement on both backends; re-run idempotency. Model: `152_….pgmysql.test.ts`. |
| `src/db/repositories/meshIssues.test.ts` | Repository, all 3 backends | `upsertFinding` → `created`; second call same key → `updated`, `firstDetected` unchanged, `cleanRuns` reset to 0; `bumpCleanRun` ×3 → `closed: true`, `status='closed'`, `closedAt` set; upsert after close → `reopened`, `closedAt` null, `firstDetected` still original; `setDismissed` then upsert → `dismissed` stays true; `getIssues` default excludes closed + dismissed; `includeClosed`/`includeDismissed` honored; `nodeNum` round-trips as a `number` (BIGINT coercion); area finding with `nodeNum: null`; UNIQUE `(issueType, subjectKey)` prevents duplicates. |
| `src/db/repositories/analysis.test.ts` | Existing — EXTEND | `getTraceroutes` returns `packetId` (number when set, null when not). |
| `src/server/services/meshIssues/tracerouteCorpus.test.ts` | Pure unit | Validity filter drops: no route data; BROADCAST_ADDR endpoint; invalid node num; self-trace; invalid hop inside `route`. Dedup: two rows same `(packetId, from)` → the one with `routeBack` wins; tie → more SNR arrays; tie → longer route; tie → newest; tie → highest id. Null `packetId` rows are never merged. Stratified cap: 3 traceroutes for one pair inside one 6 h bucket → 1 sample; same pair in two buckets → 2; reversed endpoints share a `pairKey`. `stats` arithmetic on a mixed fixture. `truncated` passthrough. |
| `src/server/services/meshIssues/nodeSnapshot.test.ts` | Pure unit | Pooling: two source rows for one `nodeNum` → one `PooledNode` with both `sourceIds`; newest-wins picks the fresher row's `role`; a null field on the fresher row falls back to the older row's value; lat/lon taken as a pair from one source; `positionPrecisionBits` = min; `mobile` = OR; `lastHeard` seconds→ms normalization; string `nodeNum` (BIGINT) coerced. Telemetry: identical `(nodeNum, type, timestamp)` across two sources collapses to one sample; series sorted ascending; unknown telemetry types ignored. |
| `src/server/services/meshIssues/rules.test.ts` | Pure unit | **One `describe` per rule.** A1: fires for REPEATER and ROUTER_CLIENT, not for ROUTER/CLIENT; `lastHeardAgeMs` present; recommendation never contains "promote". A2a: fires at 6 samples mean 9%; does not fire at 5 samples; does not fire at mean 8.0 (strict `>`); out-of-window samples excluded. A2b: 3 nodes in one bin mean 30% → one area finding, `nodeNum` null; 2 nodes → info node findings instead; bogus/Null-Island position excluded; nodes without position excluded; bin key stable for two nearby coords. A3: powered (101) never fires; 2 uptime resets → warning; battery 15% with clean uptime → info; battery 15% with only 2 samples → no finding; non-infra role never fires. A4: infra + span 600 m → fires; span 400 m → no; `positionPrecisionBits = 16` → skipped; non-infra never fires. A5: ROUTER + fw 2.6 + `isUnmessagable=false` → info finding; `isUnmessagable=true` → none; fw 2.4 → none; null fw → none; ROUTER_CLIENT/REPEATER → none. Plus: `evaluateAllTierA` survives one rule throwing. |
| `src/server/services/meshIssuesScheduler.test.ts` | Unit | `isRunDue` truth table (null last-run, exactly-at, just-under, just-over). Clamps: lookback 10→168? **no** — 10 clamps to 24 (MIN), 900 clamps to 720, `'abc'` → 168; pair bucket 0→1, 99→24; frequency 0.1→24. `enabled` default ON (`null` and `'true'` → true, `'false'` → false). `runNow` twice concurrently → second rejects with `/in progress/`. Last-run written to settings even when `runAnalysis` rejects. Mock `meshIssuesAnalysisService` and `databaseService.settings`. |
| `src/server/services/meshIssuesAnalysisService.test.ts` | Unit | With mocked repositories: no Meshtastic sources → zeroed result, no writes. Findings persist via `upsertFinding`. An open issue absent from this run's findings gets `bumpCleanRun`; one present does not. `byType` tally. `corpusStats` present on the result. **Asserts `dataEventEmitter` is never called** (guard the deferred-notification decision). |
| `src/server/routes/meshIssuesRoutes.test.ts` | Route, `createRouteTestApp()` | Admin GET → 200 with all findings. Limited user granted `nodes:read` on `sourceA` only: a finding citing `['sourceA','sourceB']` returns with `sourceIds === ['sourceA']`; a finding citing only `sourceB` is **absent**. User with no grants → 403 `NO_PERMITTED_SOURCES`. `counts` matches the returned set. `includeClosed=true` includes closed rows. Malformed `evidence` JSON → row still returned with `evidence: {}` (not a 500); malformed `sourceIds` → row dropped. `/status` obeys the same 403 gate. `POST /run-now` without `settings:write` → 403; with it → 200 and an audit-log call; when the scheduler throws "in progress" → 409 `MESH_ISSUES_RUN_IN_PROGRESS`. Non-DB mocks (`meshIssuesScheduler`) stay `vi.mock`ed; the DB path uses the harness's real SQL. |
| `src/components/Analysis/MeshIssuesReport.test.tsx` | Component | Renders three severity groups in `critical → warning → info` order from a mocked `apiService.get`; empty response shows the empty banner; rejected query shows the error banner; a finding's `recommendation` is rendered and other evidence keys appear as field pills; `recommendation` is not duplicated as a pill. Model: `MqttViolationsReport.test.tsx`. |
| `src/components/Analysis/AnalysisTab.test.tsx` | Component (NEW) | The Mesh Issues card renders in the grid and clicking it swaps to the report with a working back button. |
| `src/server/services/nodeMobilityService.test.ts` | Existing — MUST PASS UNCHANGED | Proof that the `positionSpanKm` extraction is behavior-preserving. Add one direct `positionSpanKm` case (fewer than 2 samples → null). |
| `src/db/migrations.test.ts`, `src/db/repositories/schemaIntegrity.test.ts` | Existing — NO EDIT | Both are registry/replay-derived and pick up 154 automatically. `schemaIntegrity` is the safety net that migration 154 actually replays cleanly on a fresh DB. |

**Verification rules for whoever runs the suite:**
- Judge a run by `success` in the JSON reporter, not the assertion counts
  (`rtk`'s `PASS FAIL(0)` summary masks suite-level collection failures).
- A schema/migration change is **not** verified without the PG and MySQL
  containers up — the multi-backend suites `skipIf` silently. Start them per
  CLAUDE.md and confirm via `numPendingTests`.
- `npm run lint:ci`, filtered as `grep '^FAIL' | grep -v '.claude/worktrees'`,
  must be empty. Do not regenerate `eslint-baseline.json`.

---

## 4. Work packages

Five packages. WP1 is the only hard blocker; WP5 can run alongside WP3/WP4
because its wire contract is frozen in §2.16.

```
WP1 ──┬── WP2 ── WP3 ── WP4
      └── WP5 (parallel from WP1; merges last)
```

### WP1 — Data layer: migration, schema, repository (no dependencies)

**Files:** `src/db/schema/meshIssues.ts` (new), `src/db/schema/index.ts`,
`src/db/activeSchema.ts`, `src/server/migrations/154_create_mesh_issues.ts` (new),
`src/db/migrations.ts`, `src/db/repositories/meshIssues.ts` (new),
`src/db/repositories/index.ts`, `src/services/database.ts`,
`src/server/services/meshIssues/types.ts` (new),
`src/db/repositories/analysis.ts` (add `packetId`),
plus the three test files (`154_….test.ts`, `154_….pgmysql.test.ts`,
`meshIssues.test.ts`) and the `analysis.test.ts` extension.

**Acceptance:**
- `mesh_issues` exists with the §2.1 column set on all three backends; running
  the migration twice is a no-op on each.
- `MeshIssuesRepository` implements every method in §2.14 with the exact
  create/update/reopen/auto-close/dismiss semantics.
- `databaseService.meshIssues` and the four `*Async` facade methods exist.
- `AnalysisRepository.getTraceroutes` returns `packetId`.
- `src/db/repositories/meshIssues.test.ts` passes on SQLite **and** on PG and
  MySQL with the containers running; `schemaIntegrity.test.ts` still passes.
- No raw SQL outside `migrations/` and the repository's Drizzle builders.

### WP2 — Pure analysis core: sampler, snapshot, thresholds, rules (depends: WP1)

**Files:** `src/server/services/meshIssues/tracerouteCorpus.ts`,
`nodeSnapshot.ts`, `thresholds.ts`, `rules.ts` (all new);
`src/server/services/nodeMobilityService.ts` (extract `positionSpanKm`);
tests `tracerouteCorpus.test.ts`, `nodeSnapshot.test.ts`, `rules.test.ts`,
plus the `nodeMobilityService.test.ts` addition.

**Acceptance:**
- Zero imports of `databaseService` in any of the four new modules (grep-checkable);
  only type-only imports from `db/`.
- Every parser call goes through `src/utils/tracerouteSegments.ts`; no local
  `JSON.parse` of a route/SNR column.
- Every threshold is a named constant in `thresholds.ts` with an
  `[official]`/`[ours]` JSDoc tag; no numeric literal thresholds inside `rules.ts`.
- `INFRA_ROLES` / `DEPRECATED_ROLES` / `DEDICATED_ROUTER_ROLES` are built from
  `DeviceRole`, not literal ints.
- No recommendation string in `rules.ts` contains the word "promote", and none
  suggests the ROUTER role. (Add a test asserting this across all rules.)
- The existing `nodeMobilityService.test.ts` passes **unchanged**.
- The three new unit test files cover every case listed in §3.

### WP3 — Service, scheduler, settings, server wiring (depends: WP1, WP2)

**Files:** `src/server/services/meshIssuesAnalysisService.ts`,
`src/server/services/meshIssuesScheduler.ts` (both new);
`src/server/constants/settings.ts`; `src/server/server.ts`;
tests `meshIssuesAnalysisService.test.ts`, `meshIssuesScheduler.test.ts`.

**Acceptance:**
- The scheduler is a line-for-line structural match to
  `positionEstimationScheduler` (60 s tick, pure `isRunDue`, `runLock`,
  `finally`-block last-run write, default-ON `enabled`).
- Restart safety demonstrated by a test: `getLastRun()` with an empty in-memory
  cache reads `mesh_issues_last_run` from settings, and a rejected run still
  writes the key.
- All five settings keys are in **both** `VALID_SETTINGS_KEYS` and
  `GLOBAL_ONLY_SETTINGS_KEYS`.
- `meshIssuesScheduler.initialize()` is called from `server.ts` beside
  `positionEstimationScheduler.initialize()`.
- The service sends no packets and calls no `dataEventEmitter` method — asserted
  by a test, not just by inspection.
- Traceroute pagination is capped at `MAX_CORPUS_PAGES` and sets `truncated`.
- Every relative import in the new server files carries an explicit `.js`
  extension (this is the failure mode that only shows up in `dist/`).

### WP4 — API routes (depends: WP3)

**Files:** `src/server/routes/meshIssuesRoutes.ts` (new);
`src/server/server.ts` (mount); `src/server/routes/meshIssuesRoutes.test.ts`.

**Acceptance:**
- All three routes use `ok()` / `fail()` from `src/server/utils/apiResponse.ts`
  with SCREAMING_SNAKE codes.
- The cross-source permission filter behaves exactly as §2.16 describes —
  proven by the harness test with a `sourceA`-only user, including the "drop the
  finding entirely" case. This is the #3745 leak class; a mocked
  `checkPermissionAsync` would not catch a regression here, so
  `createRouteTestApp()` is mandatory.
- 403 on zero permitted sources; 409 on a concurrent run-now; audit log written
  on a successful run-now.
- Mounted at `/api/analysis/mesh-issues`; the route file is a new module and
  `analysisRoutes.ts` is not refactored.

### WP5 — Reports card (depends: WP1 for `types.ts`; contract frozen in §2.16)

**Files:** `src/components/Analysis/meshIssueTypes.ts`,
`MeshIssuesReport.tsx`, `MeshIssuesReport.module.css` (all new);
`src/components/Analysis/AnalysisTab.tsx`;
tests `MeshIssuesReport.test.tsx`, `AnalysisTab.test.tsx`.

**Acceptance:**
- No raw `fetch()` anywhere in the new components (ESLint-enforced; the baseline
  must not grow).
- Reads `body.data` — the report renders real findings against the running dev
  container, not just mocked ones.
- Findings grouped by severity in `critical → warning → info`, each with the
  recommendation and the evidence fields.
- All icons via `UiIcon`; no emoji or Unicode stand-ins.
- New styles live in the CSS module; `var(--color-*)` tokens with **no**
  fallback values; `analysis-reports.css` gains nothing.
- A screenshot of the rendered report is attached to the PR (UI PRs require one).
- `npm run lint:ci` (worktree-filtered) is clean.

### Phase exit (all packages)

- Full Vitest suite green with the PostgreSQL **and** MySQL containers running;
  verify via `numPendingTests`, not just `success`.
- `npm run lint:ci` clean; `eslint-baseline.json` unchanged.
- Dev container rebuilt from this branch, report renders findings from the live
  dev DB, screenshot in the PR.
- PR body states the zero-airtime finding and lists every `[ours]` threshold with
  its value, so the user can veto any of them at review.

---

## 5. Spec-level decisions and refinements

These either resolve an open question in the epic or add detail beyond it. Each
is flagged so the user can override before implementation starts.

1. **A5's telemetry-cadence clause is deferred; A5 fires only on
   `isUnmessagable`.** *Investigation:* the `telemetry` table has no
   destination, request-id or solicited flag — its columns are `nodeId`,
   `nodeNum`, `telemetryType`, `timestamp`, `value`, `packetId`, `channel`,
   `rxSnr`, `hopStart`, `hopLimit`, `sourceId`. Outstanding requests live in
   `MeshtasticManager.pendingTelemetryRequests`, an **in-memory `Map` cleared on
   disconnect**, and nothing persists them. The only durable discriminator is a
   join from `telemetry.packetId` to `packet_log` (a solicited reply is a DM, so
   `packet_log.to_node` is our node) — but `packet_log_enabled` is **opt-in and
   off by default**, per-source, and pruned, so on most installs the join finds
   nothing and every broadcast would look solicited (or vice versa). Firing a
   cadence rule on that is a false-positive generator. Phase 3 can enable the
   clause behind an explicit `packet_log_enabled` availability check; the code
   comment in `rules.ts` records this.
2. **`subjectKey` as the identity column.** The epic says "keyed by physical
   nodeNum", but A2b is attributed to an area, so `nodeNum` alone cannot be the
   key, and a nullable column in a UNIQUE index treats NULLs as distinct on all
   three backends (silent duplicate area findings). One non-null `subjectKey`
   string, with `nodeNum` kept as a denormalized nullable column, fixes it
   portably.
3. **A2b's "single node = info" is implemented as a second issue type.** A bin
   with 1–2 qualifying nodes emits `A2b_congested_node` (info, node-attributed)
   instead of the area finding. The epic's one-line guard admits this reading;
   this makes it concrete.
4. **A5 restricted to ROUTER + ROUTER_LATE.** `ROUTER_CLIENT` is *designed* to
   be messagable and `REPEATER` does not run the client stack, so including
   either would fire on correctly configured nodes.
5. **A5 firmware guard added.** `is_unmessagable` did not exist before firmware
   2.5, where the column defaults to `false` — without the guard A5 fires on
   every older node. Uses the existing `compareVersions`. `[ours]`.
6. **A3 adds `BATTERY_MIN_SAMPLES = 3` `[ours]`.** The epic's guard warns about
   solar false positives; a single stray low reading firing a finding is exactly
   that failure. Three in-window samples is the minimum that rules out one bad
   packet. Veto candidate.
7. **A4 adds `MOBILE_MIN_PRECISION_BITS = 17` `[ours]`.** The epic's guard says
   "handles precision truncation", but `nodeMobilityService` has no such
   handling — it just measures the bounding box. At 16 precision bits a cell is
   ~610 m, straddling the 500 m threshold, so a stationary node with truncated
   positions can look mobile. 17 bits (~305 m) is the first safe value.
8. **A4 does not gate on the persisted `nodes.mobile` flag.** The flag encodes a
   100 m threshold refreshed on position ingest; a node can cross 500 m before
   the flag refreshes. The rule reuses the *measurement* (`positionSpanKm`, the
   same accessor and 500-sample cap) and carries the flag in evidence.
9. **NodeInfo freshness is `lastHeard`, and the report says so.** There is no
   NodeInfo-receipt-time column on `nodes`. A1's evidence field is named
   `lastHeardAgeMs`, not `nodeInfoAgeMs`, so the UI never claims more precision
   than the data supports.
10. **Traceroute corpus is computed in Phase 1 with only its `stats` consumed**
    (surfaced on `/status`). It costs one paginated read per 24 h and proves the
    pipeline before Phase 2's graph rules depend on it. Alternative considered:
    defer the sampler to Phase 2 — rejected, because the epic makes it a Phase 1
    deliverable and the stats are the raw material for Tier C's coverage preface.
11. **Findings emit no `dataEventEmitter` events.** Routing findings onto the
    event bus would fan them out to the automation engine, Apprise, desktop and
    MQTT-publish subscribers — mesh-impact checklist §2 "indirect spam". Whether
    mesh issues should notify at all is a user decision, deferred to Phase 3.
12. **`mesh_issues` is excluded from `BACKUP_TABLES`.** It is derived data that
    the next scheduled run regenerates, matching `estimated_positions`, which is
    also absent from that list.
13. **Routes live in a new `meshIssuesRoutes.ts`, mounted under
    `/api/analysis/mesh-issues`.** `analysisRoutes.ts` is already 1068 lines;
    `resolvePermittedSourceIds` is copied rather than exported so this phase
    does not refactor a heavily-used module.
14. **Per-source permission filtering on a global table.** Findings have no
    `sourceId`, but their evidence names its sources. The GET route intersects
    each finding's `sourceIds` with the caller's permitted set, drops empty
    intersections, and returns only the intersection — the #3745 cross-source
    leak class, applied to a global table.
15. **`MAX_CORPUS_PAGES = 25` (50 000 traceroutes) `[ours]`** bounds the run's
    memory on a large mesh; `stats.truncated` reports when it bit.
16. **A2b's per-node fallback also fires inside a >=3-node bin whose *mean*
    is under the ceiling but which contains one node individually over it**
    (review finding, #4964) — broader than this section's literal "fewer
    than `CONGESTED_AREA_MIN_NODES` qualifying nodes" wording. Implemented
    as the `else` of the combined area condition (node count AND binMean),
    so it naturally covers this case too; kept deliberately, since a single
    hot node in an otherwise-quiet area is still real, low-confidence signal.
