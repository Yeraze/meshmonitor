# MQTT Packet Monitor — Phase 1 Implementation Spec

**Epic:** `docs/internal/dev-notes/MQTT_PACKET_MONITOR_EPIC.md`
**Branch/worktree:** `feature/mqtt-packet-monitor` → `../meshmonitor-wt-mqtt-packetmon`
**Scope:** Backend capture + API only. No user-visible change (capture off by default).
**Exit criteria:** full Vitest suite green, `lint:ci` green, typecheck green.

Implementers: follow this verbatim. Every decision below was resolved by reading the
current code; do not re-litigate the epic's interview decisions. Where a signature is
given, match it exactly so tests and callers line up.

---

## 1. Reuse inventory (mandatory — use/extend these, do NOT hand-roll)

| Mechanism | Location | How Phase 1 uses it |
|-----------|----------|---------------------|
| **Migration idempotency helpers** — `CREATE TABLE IF NOT EXISTS` (SQLite/PG native), MySQL `information_schema.TABLES` pre-check | `src/server/migrations/075_meshcore_packet_log.ts` is the exact template | Migration 121 copies 075's structure verbatim (3 exports, same guards). No new helper needed — a fresh table only needs `IF NOT EXISTS` (SQLite/PG) and the MySQL existence pre-check pattern already in 075. |
| **Migration registry** | `src/db/migrations.ts` (import block ~L92–136, `registry.register({ number, name, settingsKey, sqlite, postgres, mysql })` entries; 119 entry at ~L1891) | Add one import line + one `registry.register` entry for 120. The count test (`src/db/migrations.test.ts`) is registry-derived — **no edit needed**. |
| **Active schema table map** | `src/db/activeSchema.ts` (three dialect blocks ~L299/355/411, `any`-typed field ~L217, re-export ~L99) | Add `mqttPacketLog` in all four spots so `this.tables.mqttPacketLog` resolves per driver. |
| **Schema re-export barrel** | `src/db/schema/index.ts` (L37 exports `meshcorePacketLog.js`) | Add `export * from './mqttPacketLog.js';`. |
| **`BaseRepository` + `this.tables` + `normalizeBigInts`** | `src/db/repositories/base.ts` (L64 ctor `buildActiveSchema(dbType)`; `normalizeBigInts` L267) | New `MqttPacketLogRepository extends BaseRepository`. **Every** result that carries a BIGINT column (packetId/fromNode/toNode/gatewayNodeNum/timestamps) MUST be passed through `this.normalizeBigInts(...)` before return — PG/MySQL return BigInt/string for BIGINT. |
| **Raw-SQL ban exception** | ESLint `no-restricted-syntax` allows raw `sql`` `` inside `src/db/repositories/**` | The grouped aggregate query uses `sql`` `` templates (COUNT DISTINCT, MAX/MIN, group-key expression). This is allowed **only** because it lives in the repository. Do not leak raw SQL into the service/route. |
| **Drizzle grouped-aggregate pattern** | `src/db/repositories/neighbors.ts` L287–304 (`COUNT(*)`, `MAX(timestamp)`, `.groupBy(packetLog.from_node)`); `telemetry.ts` L975–992 (`AVG`, `MIN`, multi-column `.groupBy`) | Copy this exact shape for `getGroupedPackets`. |
| **`ok()` / `fail()` envelope** | `src/server/utils/apiResponse.ts` | All new route handlers use `ok(res, data)` / `fail(res, status, CODE, msg)`. New handlers are greenfield so `ok()` is safe (no legacy consumer). |
| **`requirePermission` + `optionalAuth` + `requireAuth`** | `src/server/auth/authMiddleware.js` (import as in `meshcoreRoutes.ts` L23) | Reuse the existing `packetmonitor` resource, per-source scoped via `{ sourceIdFrom: 'params.id' }`. Do NOT invent a new resource. |
| **`Router({ mergeParams: true })`** | `meshcoreRoutes.ts` L52 | Required so the mounted sub-router can read `req.params.id`. |
| **`auditLogAsync`** | `databaseService.auditLogAsync(userId, action, resource, JSON.stringify(details), ip)` — wrapped by `auditMeshcoreEvent` in `meshcoreRoutes.ts` L175 | DELETE handler writes an audit row via a local `auditMqttEvent` helper copied from `auditMeshcoreEvent` (resource `'configuration'`). |
| **`getSettingAsync`** | `databaseService.getSettingAsync(key)` | Service reads the three `mqtt_packet_log_*` settings; enabled === `'1'`. |
| **`VALID_SETTINGS_KEYS`** | `src/server/constants/settings.ts` L96–98 (meshcore keys) | Add the three `mqtt_packet_log_*` keys right after. Without this, settings silently fail to save. **Not** `SERVER_ONLY_SETTINGS` (meshcore packet keys aren't either). |
| **`meshtasticProtobufService.getPortNumName(portnum)`** | `src/server/meshtasticProtobufService.ts` L992 (returns e.g. `'TEXT_MESSAGE_APP'`, `'UNKNOWN_<n>'`) | Service builds `portnumName` from it. |
| **`nodeNumToId(num)`** | `src/server/mqttPacketFilter.ts` L328 (`!aabbccdd`) | Build `fromNodeId`/`toNodeId`. Reverse (`gatewayId → gatewayNodeNum`) is a local `parseGatewayNodeNum` (strip `!`, `parseInt(hex,16)`, NaN → null). |
| **`ServiceEnvelopeShape` / `MeshPacketShape`** | `src/server/mqttPacketFilter.ts` L28–46 | The row builder reads only these typed fields (`gatewayId`, `channelId`, `packet.{id,from,to,channel,rxTime,rxSnr,rxRssi,hopLimit,hopStart,decoded,encrypted}`). |
| **`MqttIngestionResult`** | `src/server/mqttIngestion.ts` L113–117 (`{ ingested, reason?, portnum? }`) | The hook maps `reason` → `ingestOutcome`. |
| **Route-test harness** | `src/server/test-helpers/routeTestApp.ts` (`createRouteTestApp`, `harness.grant/loginAs/limited/admin/sourceA/sourceB/cleanup`) | All route tests use this. **No** `vi.mock('../../services/database.js')`. |
| **Repo-test DB** | `src/server/test-helpers/testDb.ts` `createTestDb()` → `{ sqlite, db }`; construct `new MqttPacketLogRepository(t.db, 'sqlite')` | Repository unit + perSource tests. See `meshcorePacketLog.perSource.test.ts` template. |

### Why a NEW table (`mqtt_packet_log`) rather than reusing `packet_log` or `meshcore_packet_log`

- **`packet_log`** (Meshtastic TCP monitor) is a **one-row-per-packet** model with TCP-specific
  columns (`direction` rx/tx, `hop_start`/`hop_limit`, no gateway concept). MQTT's defining
  characteristic is **N receptions per packet, one per gateway** — the whole feature is the
  gateway fan-out. Bolting a nullable `gatewayId` onto `packet_log` and teaching every existing
  `packet_log` query to ignore it would be more invasive and riskier than a purpose-built table.
- **`meshcore_packet_log`** models the MeshCore OTA wire format (payloadType/routeType/relay-hash
  chain, no node numbers or channels). It shares none of MQTT's envelope metadata
  (`gatewayId`, `channelId`, Meshtastic portnum, hop counts, encrypted/decryptedBy).
- The new table's **grouped list = query-time dedup** over `(packetId, fromNode)` with a
  gateway count, plus a **per-gateway detail** query, is unique to MQTT and does not exist in
  either sibling. A dedicated table keeps the aggregate query simple and the retention model
  ("5000 rows because each row is one reception") coherent.

The **service/route/settings shape is copied from the MeshCore monitor** (opt-in enable,
count+age retention, 15-min sweep, `packetmonitor` permission, `ok/fail` routes) — only the
table + repository + the grouped/gateway query surface is genuinely new.

---

## 2. File-by-file changes with concrete signatures

### 2.1 `src/server/migrations/121_mqtt_packet_log.ts` (NEW)

Copy the structure of `075_meshcore_packet_log.ts` exactly. `LABEL = 'Migration 121'`,
`TABLE = 'mqtt_packet_log'`. Three exports:

- `export const migration = { up(db: Database): void, down(db): void }` — SQLite.
- `export async function runMigration121Postgres(client: any): Promise<void>`.
- `export async function runMigration121Mysql(pool: any): Promise<void>` — with the
  `information_schema.TABLES` pre-check + `conn.release()` in `finally`, as in 075.

**Columns** (SQLite DDL shown; PG uses quoted camelCase + `BIGINT`/`GENERATED ALWAYS AS
IDENTITY`; MySQL uses `SERIAL`/`BIGINT`/`VARCHAR`/`INT`/`DOUBLE` as in 075):

| Column | SQLite | PG | MySQL | Notes |
|--------|--------|----|----|-------|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | `INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | `SERIAL PRIMARY KEY` | |
| `sourceId` | `TEXT NOT NULL` | `TEXT NOT NULL` | `VARCHAR(255) NOT NULL` | required on every write |
| `packetId` | `INTEGER` | `BIGINT` | `BIGINT` | nullable (0/null tolerated) |
| `fromNode` | `INTEGER` | `BIGINT` | `BIGINT` | unsigned 32-bit → BIGINT |
| `fromNodeId` | `TEXT` | `TEXT` | `VARCHAR(16)` | `!aabbccdd` |
| `toNode` | `INTEGER` | `BIGINT` | `BIGINT` | |
| `toNodeId` | `TEXT` | `TEXT` | `VARCHAR(16)` | |
| `channel` | `INTEGER` | `INTEGER` | `INT` | wire channel-hash byte (0–255) |
| `channelId` | `TEXT` | `TEXT` | `VARCHAR(64)` | envelope channel **name** string |
| `gatewayId` | `TEXT` | `TEXT` | `VARCHAR(32)` | `!aabbccdd` |
| `gatewayNodeNum` | `INTEGER` | `BIGINT` | `BIGINT` | parsed from gatewayId, nullable |
| `timestamp` | `INTEGER NOT NULL` | `BIGINT NOT NULL` | `BIGINT NOT NULL` | server receive ms |
| `rxTime` | `INTEGER` | `BIGINT` | `BIGINT` | ms (wire seconds × 1000), null when ≤0 |
| `rxSnr` | `REAL` | `REAL` | `DOUBLE` | |
| `rxRssi` | `INTEGER` | `INTEGER` | `INT` | |
| `hopLimit` | `INTEGER` | `INTEGER` | `INT` | |
| `hopStart` | `INTEGER` | `INTEGER` | `INT` | |
| `portnum` | `INTEGER` | `INTEGER` | `INT` | nullable (encrypted copies have none) |
| `portnumName` | `TEXT` | `TEXT` | `VARCHAR(48)` | |
| `encrypted` | `INTEGER NOT NULL DEFAULT 0` | `INTEGER NOT NULL DEFAULT 0` | `INT NOT NULL DEFAULT 0` | **0/1 integer, NOT a boolean type** (see §3 — `MAX(encrypted)` must work on PG) |
| `decryptedBy` | `TEXT` | `TEXT` | `VARCHAR(16)` | `'server'` or null |
| `ingestOutcome` | `TEXT NOT NULL` | `TEXT NOT NULL` | `VARCHAR(24) NOT NULL` | enum text (see below) |
| `payloadSize` | `INTEGER` | `INTEGER` | `INT` | |
| `payloadPreview` | `TEXT` | `TEXT` | `VARCHAR(256)` | text preview or null |
| `createdAt` | `INTEGER NOT NULL` | `BIGINT NOT NULL` | `BIGINT NOT NULL` | |

`ingestOutcome` ∈ `'ingested' | 'encrypted' | 'geo-filtered' | 'unsupported-portnum' | 'decode-error'`.

**Indexes** (create with `IF NOT EXISTS` on SQLite/PG; inline `INDEX` in the MySQL
`CREATE TABLE`, matching 075):

- `idx_mqtt_pl_source_ts` on `(sourceId, timestamp)` — list ordering + age cleanup.
- `idx_mqtt_pl_source_pkt_from` on `(sourceId, packetId, fromNode)` — grouping + detail lookup.
- `idx_mqtt_pl_source_gw` on `(sourceId, gatewayId)` — gateway filter + `getGateways`.

### 2.2 `src/db/migrations.ts` (EDIT)

Add near L136:
```ts
import { migration as mqttPacketLogMigration, runMigration121Postgres, runMigration121Mysql } from '../server/migrations/121_mqtt_packet_log.js';
```
Add after the 119 `registry.register` block (~L1897):
```ts
registry.register({
  number: 121,
  name: 'mqtt_packet_log',
  settingsKey: 'migration_121_mqtt_packet_log',
  sqlite: (db) => mqttPacketLogMigration.up(db),
  postgres: (client) => runMigration121Postgres(client),
  mysql: (pool) => runMigration121Mysql(pool),
});
```

### 2.3 `src/db/schema/mqttPacketLog.ts` (NEW)

Mirror `meshcorePacketLog.ts` camelCase style, three dialect tables:
`mqttPacketLogSqlite` / `mqttPacketLogPostgres` / `mqttPacketLogMysql`.

- BIGINT ms timestamps: `timestamp`, `rxTime`, `createdAt` → `integer` (sqlite) /
  `bigint('...', { mode: 'number' })` (pg/mysql).
- BIGINT node ids: `packetId`, `fromNode`, `toNode`, `gatewayNodeNum` → `integer` (sqlite) /
  `bigint(..., { mode: 'number' })` (pg/mysql).
- `encrypted` → `integer('encrypted').notNull().default(0)` (sqlite) / `pgInteger`.notNull().default(0) / `myInt`.notNull().default(0). **Do NOT use a boolean column type.**
- `ingestOutcome` → notNull text/varchar.
- Text columns as in the table above (`myVarchar` with the lengths listed).

### 2.4 `src/db/activeSchema.ts` (EDIT — 4 spots)

- Import block (~L99): add `mqttPacketLogSqlite, mqttPacketLogPostgres, mqttPacketLogMysql` from `./schema/mqttPacketLog.js`.
- `ActiveSchema` interface (~L217): add `mqttPacketLog: any;`.
- SQLite map (~L299): `mqttPacketLog: mqttPacketLogSqlite,`.
- PG map (~L355): `mqttPacketLog: mqttPacketLogPostgres,`.
- MySQL map (~L411): `mqttPacketLog: mqttPacketLogMysql,`.

### 2.5 `src/db/schema/index.ts` (EDIT)

Add `export * from './mqttPacketLog.js';`.

### 2.6 `src/db/repositories/mqttPacketLog.ts` (NEW — standalone repository)

Standalone repo is the idiomatic choice: there is no "mqtt domain" repo (MQTT ingestion writes
through `nodes`/`messages`/`telemetry` repos), and CLAUDE.md prescribes one file per domain.

```ts
export interface DbMqttPacket {
  id?: number;
  sourceId: string;              // required on writes
  packetId?: number | null;
  fromNode?: number | null;
  fromNodeId?: string | null;
  toNode?: number | null;
  toNodeId?: string | null;
  channel?: number | null;       // wire channel-hash byte
  channelId?: string | null;     // envelope channel name
  gatewayId?: string | null;
  gatewayNodeNum?: number | null;
  timestamp: number;             // server receive ms
  rxTime?: number | null;
  rxSnr?: number | null;
  rxRssi?: number | null;
  hopLimit?: number | null;
  hopStart?: number | null;
  portnum?: number | null;
  portnumName?: string | null;
  encrypted: number;             // 0 | 1
  decryptedBy?: string | null;   // 'server' | null
  ingestOutcome: MqttIngestOutcome;
  payloadSize?: number | null;
  payloadPreview?: string | null;
  createdAt: number;
}

export type MqttIngestOutcome =
  | 'ingested' | 'encrypted' | 'geo-filtered' | 'unsupported-portnum' | 'decode-error';

/** Filters shared by grouped list + count. `sourceId` is required (enforced by caller). */
export interface MqttGroupedQuery {
  sourceId: string;
  gateways?: string[];           // gatewayId IN (...)
  portnum?: number;
  since?: number;                // timestamp >= since (ms)
  encrypted?: boolean;           // true → encrypted=1, false → encrypted=0
  limit?: number;
  offset?: number;
}

/** One deduplicated packet (a group of gateway receptions). */
export interface MqttGroupedPacket {
  packetId: number | null;
  fromNode: number | null;
  fromNodeId: string | null;
  toNode: number | null;
  toNodeId: string | null;
  channel: number | null;
  channelId: string | null;
  portnum: number | null;
  portnumName: string | null;
  encrypted: number;             // representative (MAX)
  ingestOutcome: string;
  payloadSize: number | null;
  payloadPreview: string | null;
  gatewayCount: number;          // COUNT(DISTINCT gatewayId)
  receptionCount: number;        // COUNT(*)
  firstHeard: number;            // MIN(timestamp)
  lastHeard: number;             // MAX(timestamp)
}

export interface MqttGateway {
  gatewayId: string;
  gatewayNodeNum: number | null;
  receptionCount: number;
  lastHeard: number;
}
```

**Class** `MqttPacketLogRepository extends BaseRepository` (ctor `(db, dbType)` → `super(...)`).
Methods:

- `insertPacket(packet: DbMqttPacket): Promise<void>` — throw if `!packet.sourceId`;
  `await this.db.insert(this.tables.mqttPacketLog).values(packet)`.
- `private buildGroupedConditions(q: MqttGroupedQuery): SQL[]` — `eq(sourceId)` (always);
  `inArray(gatewayId, q.gateways)` when non-empty; `eq(portnum)`; `gte(timestamp, since)`;
  `eq(encrypted, q.encrypted ? 1 : 0)` when `encrypted !== undefined`.
- `getGroupedPackets(q): Promise<MqttGroupedPacket[]>` — see §3 for the exact aggregate/group-by.
  `.orderBy(sql`MAX(${t.timestamp}) DESC`)`, `.limit(q.limit ?? 100).offset(q.offset ?? 0)`,
  return `this.normalizeBigInts(rows)`.
- `getGroupedPacketCount(q): Promise<number>` — subquery count of groups (see §3).
- `getReceptions(sourceId: string, packetId: number, fromNode: number): Promise<DbMqttPacket[]>` —
  `where sourceId=? AND fromNode=? AND packetId=?`, `orderBy(asc(timestamp), asc(id))`,
  `normalizeBigInts`.
- `getGateways(sourceId: string): Promise<MqttGateway[]>` — see §3.
- `getPacketCount(query?: { sourceId?: string }): Promise<number>` — `COUNT(*)` (used by retention).
- `deletePacketsOlderThan(timestamp: number, sourceId?: string): Promise<number>` — copy the
  meshcore before/after-count pattern (`meshcore.ts` L1448).
- `trimPacketsToCount(sourceId: string, maxCount: number): Promise<number>` — copy meshcore
  L1464 (find `oldestKeptId` via newest-`maxCount` select, delete `id < oldestKeptId`).
- `getPacketLogSourceIds(): Promise<string[]>` — `selectDistinct({ sourceId })`, filter Boolean.
- `deleteAllPackets(sourceId?: string): Promise<number>` — copy meshcore L1502.

> **packetId 0/null edge:** grouping and `getReceptions` use the group key defined in §3.
> `getReceptions` filters on the literal stored `packetId`. For `packetId > 0` (virtually all
> real mesh packets) this is exact. `packetId` 0/null rows each form their own group (via the
> `-id` fallback key) and report `gatewayCount = 1`; a `getReceptions(sourceId, 0, fromNode)`
> call would over-match all zero-id rows for that node. This is an accepted, documented
> limitation — see §6.

### 2.7 `src/services/database.ts` (EDIT — wire the repo)

- Import `MqttPacketLogRepository` (near L40 with the other repo imports).
- Field (near L468): `public mqttPacketLogRepo: MqttPacketLogRepository | null = null;`.
- Getter (near L650, mirroring `get meshcore()`):
  ```ts
  get mqttPacketLog(): MqttPacketLogRepository {
    if (!this.mqttPacketLogRepo) throw new Error('Database not initialized');
    return this.mqttPacketLogRepo;
  }
  ```
- Instantiate in `init` alongside `meshcoreRepo` (near L893):
  `this.mqttPacketLogRepo = new MqttPacketLogRepository(drizzleDb, this.drizzleDbType);`.

### 2.8 `src/server/constants/settings.ts` (EDIT)

Add after L98:
```ts
  'mqtt_packet_log_enabled',
  'mqtt_packet_log_max_count',
  'mqtt_packet_log_max_age_hours',
```

### 2.9 `src/server/services/mqttPacketLogService.ts` (NEW)

Copy `meshcorePacketLogService.ts` structure. Differences:
- `DEFAULT_MAX_COUNT = 5000` (epic: higher cap; each row = one reception), `DEFAULT_MAX_AGE_HOURS = 24`.
- Settings keys `mqtt_packet_log_{enabled,max_count,max_age_hours}`.
- `runCleanup()`, `getMaxCount()`, `getMaxAgeHours()`, `stop()`, `clearPackets(sourceId?)`,
  `getGroupedPackets`, `getGroupedPacketCount`, `getReceptions`, `getGateways` — thin passthroughs
  to `databaseService.mqttPacketLog.*`.

**Enabled flag with a short TTL cache** (MQTT can be high-throughput; avoid a settings read per
copy):
```ts
private enabledCache: { value: boolean; expires: number } | null = null;
private readonly ENABLED_TTL_MS = 5000;

async isEnabled(): Promise<boolean> {
  const now = Date.now();
  if (this.enabledCache && now < this.enabledCache.expires) return this.enabledCache.value;
  const value = (await databaseService.getSettingAsync('mqtt_packet_log_enabled')) === '1';
  this.enabledCache = { value, expires: now + this.ENABLED_TTL_MS };
  return value;
}
/** Test seam — clears the TTL cache so a just-written setting is observed immediately. */
resetEnabledCache(): void { this.enabledCache = null; }
```

**The ingestion entry point — `logEnvelope`** (single method the hook calls; owns the
enabled-gate, the row build, and the best-effort insert so `mqttIngestion.ts` stays a one-liner):
```ts
async logEnvelope(sourceId: string, envelope: ServiceEnvelopeShape, result: MqttIngestionResult): Promise<void> {
  try {
    if (!envelope.packet) return;                 // nothing to log
    if (!(await this.isEnabled())) return;         // no-op when disabled (cached)
    const row = buildMqttPacketLogRow(sourceId, envelope, result);
    if (!row) return;                              // reason 'no-packet' w/ no packet
    await databaseService.mqttPacketLog.insertPacket(row);
  } catch (err) {
    logger.error('❌ Failed to log MQTT packet:', err);   // best-effort; never throw into ingest
  }
}
```

**`buildMqttPacketLogRow(sourceId, envelope, result)` — exported pure function** (same module,
so it is unit-testable in isolation and free of DB/enabled concerns):
```ts
export function buildMqttPacketLogRow(
  sourceId: string, envelope: ServiceEnvelopeShape, result: MqttIngestionResult,
): DbMqttPacket | null {
  const p = envelope.packet;
  if (!p) return null;
  const now = Date.now();
  const num = (v: unknown) => (typeof v === 'number' ? v >>> 0 : null);
  const fromNode = num(p.from);
  const toNode = num(p.to);
  const wasEncrypted = !!(p.encrypted && p.encrypted.length > 0);
  const decoded = p.decoded;                       // inner may have synthesized this on server-decrypt
  const portnum = typeof decoded?.portnum === 'number' ? decoded.portnum : null;
  const gatewayId = envelope.gatewayId ?? null;
  return {
    sourceId,
    packetId: num(p.id),
    fromNode, fromNodeId: fromNode !== null ? nodeNumToId(fromNode) : null,
    toNode, toNodeId: toNode !== null ? nodeNumToId(toNode) : null,
    channel: typeof p.channel === 'number' ? p.channel : null,
    channelId: envelope.channelId ?? null,
    gatewayId, gatewayNodeNum: parseGatewayNodeNum(gatewayId),
    timestamp: now,
    rxTime: typeof p.rxTime === 'number' && p.rxTime > 0 ? p.rxTime * 1000 : null,
    rxSnr: typeof p.rxSnr === 'number' ? p.rxSnr : null,
    rxRssi: typeof p.rxRssi === 'number' ? p.rxRssi : null,
    hopLimit: typeof p.hopLimit === 'number' ? p.hopLimit : null,
    hopStart: typeof p.hopStart === 'number' ? p.hopStart : null,
    portnum,
    portnumName: portnum !== null ? meshtasticProtobufService.getPortNumName(portnum) : null,
    encrypted: wasEncrypted ? 1 : 0,
    decryptedBy: wasEncrypted && decoded ? 'server' : null,
    ingestOutcome: mapOutcome(result),
    payloadSize: decoded?.payload?.length ?? (p.encrypted?.length ?? null),
    payloadPreview: buildPreview(portnum, decoded?.payload),
    createdAt: now,
  };
}
```
- `parseGatewayNodeNum(id)`: `id?.startsWith('!')` → `parseInt(id.slice(1), 16)`, return `Number.isNaN(n) ? null : n >>> 0`; else null.
- `mapOutcome(result)`: `result.ingested` → `'ingested'`; else by `result.reason`:
  `'encrypted'→'encrypted'`, `'geo-filtered'→'geo-filtered'`, `'unsupported-portnum'→'unsupported-portnum'`,
  `'decode-error' | 'no-decoded' | 'no-packet' | undefined → 'decode-error'`.
- `buildPreview(portnum, payload)`: **only** for `portnum === PortNum.TEXT_MESSAGE_APP` and a
  present payload → `Buffer.from(payload).toString('utf8').slice(0, 256)`; otherwise `null`.
  (Lightweight: no protobuf re-decode. Position/telemetry summaries deferred to a later phase.)

Export `default new MqttPacketLogService();`.

### 2.10 `src/server/mqttIngestion.ts` (EDIT — the hook, least-invasive wrapper)

`ingestServiceEnvelope` has ~15 early-return paths; the outcome is only known at each return.
**Do not** touch those returns. Instead rename the existing function to an inner and add a thin
wrapper that logs once from the single return point:

1. Rename the current `export async function ingestServiceEnvelope(...)` →
   `async function ingestServiceEnvelopeInner(input: MqttIngestionInput): Promise<MqttIngestionResult>`
   (drop `export`). Its body is unchanged, including the in-place `packet.decoded` synthesis on
   server-decrypt (L145–159) — the wrapper reads that mutated packet afterward.
2. Add the wrapper:
   ```ts
   export async function ingestServiceEnvelope(input: MqttIngestionInput): Promise<MqttIngestionResult> {
     const result = await ingestServiceEnvelopeInner(input);
     // Fire-and-forget: never make ingest await the packet-log write, never throw.
     void mqttPacketLogService.logEnvelope(input.sourceId, input.envelope, result);
     return result;
   }
   ```
   Import `mqttPacketLogService` at the top of the module.

This logs **every** gateway copy exactly once — including `encrypted`, `geo-filtered`,
`unsupported-portnum`, and `decode-error` — with no double-logging and no change to the two
callers (`mqttBrokerManager.ts` L272, `mqttBridgeManager.ts` L708). Because the log call reads
`packet.decoded` **after** inner ran, server-decrypted copies correctly record `decryptedBy:'server'`
and their portnum/preview.

### 2.11 `src/server/routes/mqttPacketRoutes.ts` (NEW)

`const router = Router({ mergeParams: true });`. Import `ok, fail`; `requireAuth, optionalAuth,
requirePermission`; `mqttPacketLogService`; `databaseService`; `logger`. Local
`auditMqttEvent(req, action, details)` copied from `auditMeshcoreEvent` (resource `'configuration'`).

- **`GET /`** — grouped list.
  `optionalAuth()`, `requirePermission('packetmonitor','read',{ sourceIdFrom:'params.id' })`.
  Parse: `offset` (≥0); `limit` = client `limit` if finite>0 else `maxCount`, clamped to
  `[1, MQTT_PACKET_MAX_LIMIT=1000]`; `gateways` = `req.query.gateways` CSV → non-empty trimmed
  array or undefined; `portnum` (finite int or undefined); `since` (accept s or ms: if `<1e12`, ×1000);
  `encrypted` = `'1'|'true'` → true, `'0'|'false'` → false, else undefined.
  ```ts
  const q = { sourceId, gateways, portnum, since, encrypted, limit, offset };
  const [packets, total, enabled, maxCount, maxAgeHours] = await Promise.all([
    mqttPacketLogService.getGroupedPackets(q),
    mqttPacketLogService.getGroupedPacketCount(q),
    mqttPacketLogService.isEnabled(),
    mqttPacketLogService.getMaxCount(),
    mqttPacketLogService.getMaxAgeHours(),
  ]);
  ok(res, { packets, total, offset, limit, enabled, maxCount, maxAgeHours });
  ```
  Catch → `fail(res, 500, 'MQTT_PACKETS_FETCH_FAILED', 'Failed to fetch packets')`.
- **`GET /gateways`** — same read guards. `ok(res, { gateways: await mqttPacketLogService.getGateways(sourceId) })`.
  Catch → `fail(res, 500, 'MQTT_GATEWAYS_FETCH_FAILED', ...)`.
- **`GET /receptions?packetId=&fromNode=`** — same read guards. Parse both as ints; if either is
  not finite → `fail(res, 400, 'MISSING_PACKET_KEY', 'packetId and fromNode are required')`.
  `ok(res, { receptions: await mqttPacketLogService.getReceptions(sourceId, packetId, fromNode) })`.
  Catch → `fail(res, 500, 'MQTT_RECEPTIONS_FETCH_FAILED', ...)`.
- **`DELETE /`** — `requireAuth()`, `requirePermission('packetmonitor','write',{ sourceIdFrom:'params.id' })`.
  `const deleted = await mqttPacketLogService.clearPackets(sourceId);`
  `auditMqttEvent(req, 'mqtt_packets_cleared', { sourceId, deleted });`
  `ok(res, { deleted })`. Catch → `fail(res, 500, 'MQTT_PACKETS_CLEAR_FAILED', ...)`.

`export default router;`

> **Source-type check — decision: do NOT check.** Mirrors `meshcoreRoutes`. The `packetmonitor`
> permission is already per-source scoped, and requiring a live/connected MQTT manager would
> hide **retained rows** for a temporarily disconnected or reconfigured MQTT source. A non-MQTT
> source simply has no rows → empty results, which is harmless. Avoids a `sourcesRepository`
> dependency in the route.

### 2.12 `src/server/server.ts` (EDIT — mount)

Near L651 imports: `import mqttPacketRoutes from './routes/mqttPacketRoutes.js';`
Near L767 (right after the meshcore mount):
```ts
apiRouter.use('/sources/:id/mqtt/packets', mqttPacketRoutes);
```

---

## 3. Grouped query — exact Drizzle/SQL across all three backends (riskiest part)

Verified against the repo's existing patterns (`neighbors.ts` L287, `telemetry.ts` L975): Drizzle's
`.select({ col: sql<T>`...` })` + multi-column `.groupBy(...)` compiles for the SQLite
(`better-sqlite3`), PG (`node-postgres`), and MySQL (`mysql2`) drivers this repo uses.

**Group key (packetId 0/null edge):**
```ts
const t = this.tables.mqttPacketLog;
const groupKey = sql`COALESCE(NULLIF(${t.packetId}, 0), -${t.id})`;
```
- Real packet (`packetId > 0`) → groups by `packetId`.
- `packetId` 0 or NULL → `NULLIF(...,0)` is NULL → `COALESCE` falls back to `-id` (negative,
  cannot collide with positive packetIds; `id` is unique) → each such row is its own group.
`COALESCE`, `NULLIF`, and unary negation are ANSI SQL and identical on all three backends.

**`getGroupedPackets`:**
```ts
const conditions = this.buildGroupedConditions(q);           // sourceId always present
const rows = await this.db
  .select({
    packetId:       sql<number | null>`MAX(${t.packetId})`,
    fromNode:       t.fromNode,                                // in GROUP BY → ONLY_FULL_GROUP_BY-safe
    fromNodeId:     sql<string | null>`MAX(${t.fromNodeId})`,
    toNode:         sql<number | null>`MAX(${t.toNode})`,
    toNodeId:       sql<string | null>`MAX(${t.toNodeId})`,
    channel:        sql<number | null>`MAX(${t.channel})`,
    channelId:      sql<string | null>`MAX(${t.channelId})`,
    portnum:        sql<number | null>`MAX(${t.portnum})`,
    portnumName:    sql<string | null>`MAX(${t.portnumName})`,
    encrypted:      sql<number>`MAX(${t.encrypted})`,          // integer 0/1 → MAX works on PG
    ingestOutcome:  sql<string>`MAX(${t.ingestOutcome})`,
    payloadSize:    sql<number | null>`MAX(${t.payloadSize})`,
    payloadPreview: sql<string | null>`MAX(${t.payloadPreview})`,
    gatewayCount:   sql<number>`COUNT(DISTINCT ${t.gatewayId})`,
    receptionCount: sql<number>`COUNT(*)`,
    firstHeard:     sql<number>`MIN(${t.timestamp})`,
    lastHeard:      sql<number>`MAX(${t.timestamp})`,
  })
  .from(t)
  .where(and(...conditions))
  .groupBy(t.sourceId, t.fromNode, groupKey)                  // sourceId+fromNode+key
  .orderBy(sql`MAX(${t.timestamp}) DESC`)
  .limit(q.limit ?? 100)
  .offset(q.offset ?? 0);
return this.normalizeBigInts(rows) as unknown as MqttGroupedPacket[];
```

**MySQL `ONLY_FULL_GROUP_BY` compliance:** every selected expression is either an aggregate
(`MAX`/`MIN`/`COUNT`) or a `GROUP BY` member (`fromNode`). `sourceId` and `groupKey` appear in
`GROUP BY` but are not selected — legal. `ORDER BY MAX(timestamp)` uses an aggregate — legal.
Representative text/int columns (channelId, portnumName, payloadPreview, portnum, channel,
toNode, encrypted, ingestOutcome, payloadSize) are wrapped in `MAX()`; within one packet group
these values are identical across receptions, so `MAX` is a correct representative. `encrypted`
being an **integer 0/1** (not a boolean) is what makes `MAX(encrypted)` valid on PostgreSQL,
which has no `MAX(boolean)` — this is why §2.1/§2.3 mandate the integer type.

**`getGroupedPacketCount`** — count of groups via a subquery (portable; `COUNT(DISTINCT expr1, expr2)`
is not):
```ts
const conditions = this.buildGroupedConditions(q);
const grouped = this.db
  .select({ k: sql`1` })
  .from(t)
  .where(and(...conditions))
  .groupBy(t.sourceId, t.fromNode, groupKey)
  .as('grouped');
const res = await this.db.select({ count: sql<number>`COUNT(*)` }).from(grouped);
return Number(res[0]?.count ?? 0);
```

**`getReceptions`** (per-gateway detail):
```ts
const rows = await this.db.select().from(t)
  .where(and(eq(t.sourceId, sourceId), eq(t.fromNode, fromNode), eq(t.packetId, packetId)))
  .orderBy(asc(t.timestamp), asc(t.id));
return this.normalizeBigInts(rows) as unknown as DbMqttPacket[];
```

**`getGateways`:**
```ts
const rows = await this.db
  .select({
    gatewayId: t.gatewayId,                                   // in GROUP BY
    gatewayNodeNum: sql<number | null>`MAX(${t.gatewayNodeNum})`,
    receptionCount: sql<number>`COUNT(*)`,
    lastHeard: sql<number>`MAX(${t.timestamp})`,
  })
  .from(t)
  .where(and(eq(t.sourceId, sourceId), isNotNull(t.gatewayId)))
  .groupBy(t.gatewayId)
  .orderBy(sql`MAX(${t.timestamp}) DESC`);
return this.normalizeBigInts(rows) as unknown as MqttGateway[];
```

All raw `sql`` `` lives inside the repository (ESLint-permitted there); the service and routes
stay raw-SQL-free.

---

## 4. Test plan (exact files + cases)

### 4.1 `src/server/migrations/121_mqtt_packet_log.test.ts` (NEW)
Model on `119_add_theme_tilesets.test.ts`.
- SQLite: `migration.up(db)` twice on a fresh `:memory:` DB → no throw (idempotent); assert the
  table exists and an insert of a full row round-trips.
- PostgreSQL: `runMigration121Postgres({ query: vi.fn().mockResolvedValue({ rows: [] }) })` → assert
  called with `CREATE TABLE IF NOT EXISTS` + the three `CREATE INDEX IF NOT EXISTS` statements.
- MySQL: mocked pool/conn (`getConnection`→`{ query, release }`); first `information_schema.TABLES`
  returns `[[], []]` (absent) → `CREATE TABLE` runs; second run returns a row (present) → create
  skipped. Assert `conn.release()` called both times.

### 4.2 `src/db/repositories/mqttPacketLog.perSource.test.ts` (NEW)
Model on `meshcorePacketLog.perSource.test.ts` (`createTestDb`, `new MqttPacketLogRepository(t.db,'sqlite')`).
Seed rows for `source-a` and `source-b`. Assert isolation for **every** query:
`getGroupedPackets`, `getGroupedPacketCount`, `getReceptions`, `getGateways`, `getPacketCount`,
`deletePacketsOlderThan`, `trimPacketsToCount`, `deleteAllPackets`, `getPacketLogSourceIds`.
Each asserts source-A operations never see/affect source-B rows.

### 4.3 `src/db/repositories/mqttPacketLog.grouping.test.ts` (NEW)
Grouping correctness (SQLite via `createTestDb`):
- **Multi-gateway collapse:** insert 3 receptions of the same `(packetId=100, fromNode=X)` from
  gateways `!gw1/!gw2/!gw3` with distinct timestamps/snr → `getGroupedPackets` returns exactly 1
  group with `gatewayCount=3`, `receptionCount=3`, `firstHeard=min`, `lastHeard=max`, and
  representative portnum/channelId matching the receptions.
- **Distinct packets stay separate:** two different packetIds from the same fromNode → 2 groups.
- **Gateway filter narrows:** `getGroupedPackets({ gateways:['!gw1'] })` → group's `gatewayCount=1`
  (only the matching reception counts); a packet heard only by `!gw2` is absent.
- **portnum / since / encrypted filters** each narrow as expected.
- **packetId 0/null edge:** three rows with `packetId=0` (and three with `packetId=null`) from the
  same fromNode → each becomes its **own** group (6 groups), each `gatewayCount=1` — they do NOT
  collapse into one. `getGroupedPacketCount` matches the group count returned by `getGroupedPackets`.
- **`getGateways`:** returns distinct gateways with correct `receptionCount`, `lastHeard`, and
  parsed `gatewayNodeNum`.
- **`normalizeBigInts`:** returned `packetId`/`fromNode`/`gatewayNodeNum`/timestamps are JS `number`.

### 4.4 `src/server/routes/mqttPacketRoutes.permissions.test.ts` (NEW)
Use `createRouteTestApp({ mount: app => app.use('/sources/:id/mqtt/packets', mqttPacketRoutes) })`
(canonical: `sourceRoutes.permissions.test.ts`). Seed rows directly via
`databaseService.mqttPacketLog.insertPacket`. Cases:
- Anonymous with no `packetmonitor:read` grant on the source → 401/403 on `GET /`.
- `limited` **granted** `packetmonitor:read` on `sourceA` → `GET /`, `/gateways`, `/receptions`
  return 200; the response `data.packets` reflects only that source's rows.
- Grant on `sourceA` but request `sourceB` → denied (per-source scoping).
- `GET /receptions` without `packetId`/`fromNode` → 400 `MISSING_PACKET_KEY`.
- `DELETE /` without `packetmonitor:write` → denied; **with** write grant → 200, rows cleared, and
  an audit row written (assert via `databaseService` audit query or spy).
- Response envelope shape: success uses `{ success: true, data: {...} }` (from `ok`).

### 4.5 `src/server/mqttPacketLogService.ingestHook.test.ts` (NEW)
Drive `ingestServiceEnvelope` (import from `mqttIngestion.js`) and assert the hook logs every copy
with the right outcome. Spy on `mqttPacketLogService.logEnvelope` **or** on
`databaseService.mqttPacketLog.insertPacket`. `beforeEach`: set `mqtt_packet_log_enabled='1'` and
call `mqttPacketLogService.resetEnabledCache()`. Cases:
- **ingested** (a decoded TEXT_MESSAGE_APP copy) → one row, `ingestOutcome='ingested'`,
  `encrypted=0`, `portnumName='TEXT_MESSAGE_APP'`, `payloadPreview` = the text.
- **encrypted** (packet with `encrypted` bytes, no decoded, decryption disabled/failing) → row with
  `ingestOutcome='encrypted'`, `encrypted=1`, `decryptedBy=null`, `portnum=null`.
- **geo-filtered** (bbox filter set, non-POSITION packet from an unknown sender) → row with
  `ingestOutcome='geo-filtered'` and portnum populated (decode happened before the geo gate).
- **unsupported-portnum** (e.g. a portnum with no ingest case) → `ingestOutcome='unsupported-portnum'`.
- **server-decrypted** (encrypted bytes + a matching PSK so inner synthesizes `packet.decoded`) →
  `encrypted=1`, `decryptedBy='server'`, `ingestOutcome='ingested'`.
- **multi-gateway:** two envelopes, same packet, different `gatewayId` → two rows, each with its
  own `gatewayId`/`gatewayNodeNum`.
- **disabled:** with `mqtt_packet_log_enabled` unset and cache reset → `insertPacket` **not** called.

### 4.6 `src/server/services/mqttPacketLogService.buildRow.test.ts` (NEW, optional but recommended)
Unit-test `buildMqttPacketLogRow` + `mapOutcome` + `parseGatewayNodeNum` + `buildPreview` in
isolation (no DB): each outcome mapping, gatewayId parsing (`'!433e0f28'`→number, malformed→null),
rxTime≤0→null, preview only for TEXT.

---

## 5. Work packages (for Sonnet implementers)

Dependency order: **WP1 → WP2 → {WP3, WP4 in parallel}**. WP3 and WP4 both depend on WP2
(repository + DatabaseService getter) but not on each other.

### WP1 — Schema, migration, registration, settings keys  *(sequential, first)*
Files: `121_mqtt_packet_log.ts`, `121_mqtt_packet_log.test.ts`, `schema/mqttPacketLog.ts`,
`activeSchema.ts` (4 spots), `schema/index.ts`, `migrations.ts` (import + register),
`constants/settings.ts` (3 keys).
**Acceptance:** migration test green (idempotent, 3 backends); `buildActiveSchema('sqlite'|'postgres'|'mysql').mqttPacketLog` resolves; `npm test src/db/migrations.test.ts src/db/activeSchema.test.ts` green; typecheck green.

### WP2 — Repository + DatabaseService wiring + repo tests  *(sequential, after WP1)*
Files: `repositories/mqttPacketLog.ts`, `services/database.ts` (import/field/getter/init),
`mqttPacketLog.perSource.test.ts`, `mqttPacketLog.grouping.test.ts`.
**Acceptance:** all repo tests green including the packetId-0/null edge and multi-gateway collapse;
`databaseService.mqttPacketLog` returns the repo after init; `lint:ci` green (raw SQL only inside
the repo); typecheck green.

### WP3 — Service + ingestion hook + tests  *(after WP2; parallel with WP4)*
Files: `services/mqttPacketLogService.ts` (incl. exported `buildMqttPacketLogRow`), edit
`mqttIngestion.ts` (rename inner + wrapper + import), `mqttPacketLogService.ingestHook.test.ts`,
`mqttPacketLogService.buildRow.test.ts`.
**Acceptance:** hook logs every copy exactly once with correct `ingestOutcome`/`encrypted`/
`decryptedBy`; disabled = no-op; existing `mqttIngestion.test.ts` still green (wrapper is
transparent to its assertions); TTL cache honored; typecheck + `lint:ci` green.

### WP4 — Routes + server mount + route tests  *(after WP2; parallel with WP3)*
Files: `routes/mqttPacketRoutes.ts`, edit `server.ts` (import + mount),
`mqttPacketRoutes.permissions.test.ts`.
**Acceptance:** all four endpoints enforce per-source `packetmonitor` read/write; `ok/fail`
envelopes with the SCREAMING_SNAKE codes above; DELETE writes an audit row; grouped list carries
`{ packets, total, offset, limit, enabled, maxCount, maxAgeHours }`; typecheck + `lint:ci` green.

**Final gate (any WP owner):** full `npm test` (0 failures — confirm `success:true` via JSON
reporter, not the rtk summary line), `npm run lint:ci` exit 0, `npm run build`/typecheck clean.

---

## 6. Open questions / risks

1. **packetId 0/null detail lookup (accepted limitation).** Grouping is correct for these rows
   (each is its own group via the `-id` key), but `getReceptions(sourceId, 0, fromNode)` over-matches
   all zero-id rows for that node. Real mesh packets essentially always carry a nonzero `id`, so
   this only affects degenerate frames. Phase 2's detail view calls `getReceptions` with the
   group's `packetId`+`fromNode`; for the rare 0/null group it may show sibling zero-id rows.
   **Decision:** ship as-is; documented here. A future refinement could return the group's `MIN(id)`
   as an optional detail key.
2. **`gatewayCount` under a gateway filter reflects only selected gateways** (filter is in the
   WHERE clause). This matches the epic's "show only packets heard by the selected gateways" and is
   the intended semantics; Phase 2 UI should label the count accordingly. Not a blocker.
3. **`payloadPreview` is TEXT-only in Phase 1.** Position/telemetry summaries are explicitly
   deferred (epic allows "optional"). Column exists; a later phase can enrich `buildPreview`
   without a migration.
4. **No source-type validation on routes** (see §2.11) — intentional, to keep retained rows
   readable while a source is disconnected. Confirm acceptable with the epic owner if strictness is
   later desired.

No blocking unknowns — every mechanism above was verified against current code in the worktree.
