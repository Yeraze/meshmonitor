# Transport Breakdown — Phase 2 Implementation Spec (#5101)

Branch `feature/5101-p2-transport-migrations`, off `origin/main` at `6d3388a7`
(Phase 1 merged, PR #5329). Binding decisions live in
`TRANSPORT_BREAKDOWN_EPIC.md`. Phase 1's helpers are in
`TRANSPORT_BREAKDOWN_P1_SPEC.md`. I checked every claim here against the tree.
Line numbers are approximate.

**Three migrations (169, 170, 171). No packets sent. No timers armed.** See §6.

**Revision 2 (2026-09-23):** updated for the user's answers to the §10
questions. Decisions are in §10. In short: best-effort reclassify of existing
record holders (new migration 171 + pure helper); `viaMqtt` wins for messages;
all three extra fixes approved; outbound messages stamped `INTERNAL (0)`.

---

## 0. Findings that change the plan

1. **Longest Active always shows the record holder.** The record is stored as
   a *second copy* of the segment row with `isRecordHolder = true`
   (`database.ts` ~5890 inserts `{ ...segment, isRecordHolder: true }`).
   `cleanupOldRouteSegments` spares flagged rows forever
   (`traceroutes.ts` ~506). `getLongestActiveRouteSegment` (~371) does not
   exclude flagged rows. So once a record exists, "Longest Active" returns the
   record copy, with its old "Last seen" date, for good. Phase 2 rewrites this
   query, so fixing it costs one predicate. **Approved: fix (§10.3).**
2. **MQTT sources never set a record holder.** `persistRouteSegments`
   (`mqttIngestion.ts` ~906-937) calls `insertRouteSegmentAsync` only. No
   `updateRecordHolderSegmentAsync`. Git history shows no reason; it was left
   out when MQTT ingest was built (f34f10e6). So every existing record holder
   came from a TCP source. An MQTT record would appear only if we add the call.
   **Approved: add it (§10.3).**
3. **`DELETE /api/route-segments/record-holder` without `sourceId` differs by
   backend.** SQLite goes through `clearRecordHolderSegmentSync(undefined)`,
   which clears **every source's** record. PG/MySQL go through
   `clearRecordHolderBySource(undefined)`, which throws in `withSourceScope`
   (500). The three route-segment routes also call `requirePermission('info', …)`
   with no `sourceIdFrom`, so a user granted `info:read` on source B can read
   source A's records (#3745 class). **Approved: scope and require (§10.3).**
4. **The TCP writer's segment loop is index-aligned with `snrTowards`.**
   `processTracerouteMessage` filters `route` and `snrTowards` in step
   (`meshtasticManager.ts` ~8398-8431), then builds
   `fullRoute = [toNum, ...route, fromNum]` (~8866). Segment `i`
   (`fullRoute[i] → fullRoute[i+1]`) arrives with raw SNR `snrTowards[i]`, the
   same pairing `buildLegHopLinks` uses. The TCP writer stores the forward leg
   only. The MQTT writer stores both legs. Every MQTT segment is MQTT anyway
   (record class MQTT; the sentinel rule can only yield MQTT).
5. **`messages` has hand-built test DDL that a full-row insert would break.**
   `notifications.test.ts` builds a PG/MySQL `messages` table that already
   lacks a dozen columns. It survives because `insertMessage` writes
   `spoofSuspected` only when set (`messages.ts` ~66, "#2584 … avoids touching
   the many hardcoded test fixtures"). The new column must follow the same
   rule: write it only when non-null.
6. **`classifyNodeTransport` would move messages from MQTT to RF.** It reads
   `transportMechanism` first, so LORA with `viaMqtt = true` is RF. Phase 1
   counts messages by `viaMqtt` alone. **Decision (§10.2): `viaMqtt` wins for
   messages**, via a new `classifyMessageTransport` (§4.3), so Phase 1's MQTT
   count does not shift.
7. **Side finding, out of scope:** `insertRouteSegment` / `insertRouteSegmentSync`
   (`traceroutes.ts` ~348, ~676) drop `fromLatitude`…`toLongitude`, although
   both writers pass them (#1862). No reader uses them today. File a
   follow-up; do not fix here.
8. **A pending-updated traceroute row has its endpoints swapped.** On PG/MySQL,
   `insertTracerouteAsync` (`database.ts` ~2244-2266) finds the pending
   request row (`fromNodeNum` = requester) and overwrites its route, SNR,
   `timestamp` and `transportMechanism` with the response's values, but keeps
   its endpoints. Directly inserted rows have `fromNodeNum` = responder. The
   migration 171 matcher must try both endpoint orientations. Either way the
   row's `timestamp` equals the segment's, because every writer stamps its
   segments with the traceroute's own timestamp (TCP `timestamp` ~8683, MQTT
   `nowMs`, bootstrap `traceroute.timestamp`). A **later** response for the
   same pending row would overwrite the route and push `timestamp` past the
   segment's, so rows newer than the segment are not evidence.
9. **Every outbound Meshtastic message write** (for §10.4):
   `sendTextMessage` (`meshtasticManager.ts` ~10143; all text/DM sends,
   auto-responder, auto-ack, welcome, automation, scheduled and bridge sends go
   through it), Virtual Node client sends (`processTextMessageProtobuf` ~6939
   with `context.virtualNodeRequestId`, set by `virtualNodeServer.ts` ~587),
   and the position-request system rows (`routes/v1/actions.ts` ~142/~201,
   `routes/meshRequestRoutes.ts` ~97/~179). No other code inserts into
   `messages` (grep of `insertMessage` and `insert(messages)`). MQTT sources
   write only received rows.

---

## 1. Reuse inventory

| Need | Reuse | Where |
|---|---|---|
| Class type | `NodeTransportClass` | `src/utils/nodeTransport.ts` |
| Mechanism → class (incl. `viaMqtt` fallback) | `classifyNodeTransport` | same, ~113 |
| MQTT-only source | `isMqttOnlySourceType` | same, ~34 |
| Mechanism constants (client-safe) | `TX_MQTT`, `TX_MULTICAST_UDP` | same, ~14-21 |
| Record class, sentinel-wins | `tracerouteTransportClass`, `hopTransportClass` | `src/utils/tracerouteTransport.ts` |
| Sentinel test | `isUnknownSnr` (scaled; raw/4) | `src/utils/tracerouteSegments.ts` ~43 |
| TCP packet → mechanism | `resolveRadioPacketTransport` | `src/server/constants/meshtastic.ts` ~271 |
| Server mechanism constants | `TransportMechanism.MQTT` | same, ~94 |
| packet_log class predicate | `PacketLogRepository.transportConditions` (private) | `src/db/repositories/packetLog.ts` ~75 — **extract** (below) |
| Source scoping | `withSourceScope`, `ALL_SOURCES` | `src/db/repositories/base.ts` ~244 |
| Message read gating | `resolveMessageReadAccess` | `src/server/utils/messageReadAccess.ts` |
| Counts endpoint | `GET /api/messages/counts` | `messageRoutes.ts` ~1140 |
| Inline split UI | `TransportBreakdown` | `src/components/TransportBreakdown.tsx` |
| i18n labels | `transport.rf/udp/mqtt` | `public/locales/en.json` ~5400 |
| Migration helpers | `addColumnIfMissing*`, `createIndexIfMissingMysql` | `src/server/migrations/helpers.ts` |
| Column-migration template | migration 160 (+ its `.pgmysql.test.ts`) | `src/server/migrations/160_*` |
| PG/MySQL fixtures | `createIsolatedPostgresDatabase` / `createIsolatedMysqlDatabase`, `createPostgresBackend(ddl, key)` | `src/db/repositories/test-utils.ts` |
| Route tests | `createRouteTestApp` | `src/server/test-helpers/routeTestApp.ts` |
| Envelope | `ok()` / `fail()` | `src/server/utils/apiResponse.ts` |

New things, and why:

- **`src/db/repositories/transportSql.ts`** exporting
  `transportClassCondition(column: SQL, cls: NodeTransportClass): SQL`. Two
  repositories now need the same "stored mechanism → class" predicate.
  `PacketLogRepository.transportConditions` keeps its signature and calls
  this for the class half. Mapping (identical to Phase 1): `5 → mqtt`,
  `6 → udp`, anything else incl. NULL → `rf`. That equals
  `classifyNodeTransport` with `viaMqtt` absent, which is exact for both
  tables: neither has a `viaMqtt` column, and every writer already folds
  `viaMqtt` into the stored mechanism.
- **`segmentTransportMechanism()`** in `tracerouteTransport.ts`: the value to
  store per hop. No existing function maps (record mechanism, raw hop SNR) to
  a stored integer.
- **`classifyMessageTransport()`** in `nodeTransport.ts`: the message rule
  (`viaMqtt` wins, §10.2). It differs from `classifyNodeTransport` on purpose,
  so the two sit side by side, each doc naming the other.
- **`src/utils/segmentTransportBackfill.ts`**: pure matching and collision
  logic for migration 171. Kept out of the migration so it is unit-tested
  without a database, and so all three dialects share one rule.
- **`RouteSegmentRecord.tsx` + module CSS**: one labelled record. The two
  cards would otherwise repeat the same JSX up to six times.
  `TransportBreakdown` renders a line of counts, not a record, so it does not
  fit.

---

## 2. Storage decision: `route_segments.transportMechanism INTEGER`

Store the **effective per-hop mechanism**: the traceroute record's mechanism,
or `MQTT (5)` when that hop's arrival SNR is the unknown-SNR sentinel.
Classify at read time.

Why an integer, not a class string:
- Every sibling stores the integer: `nodes.transportMechanism` (066),
  `traceroutes.transportMechanism` (160), `packet_log.transport_mechanism`.
  One vocabulary, one classifier (`classifyNodeTransport` /
  `transportClassCondition`). A class string would add a third.
- `= 5` and `= 6` are plain equality, so the new composite index serves the
  MQTT and UDP lookups directly.
- It keeps LORA vs LORA_ALT vs INTERNAL detail, at no cost.

Why not "record mechanism + a `hopSnrUnknown` flag": two columns and a
compound predicate on every query, to encode a rule (sentinel wins) that
`hopTransportClass` already fixes.

The trade-off: a sentinel hop stores `5` although no packet said "MQTT". The
column doc says so. It matches the class the map already gives that hop
(#5097).

NULL = pre-migration row = RF. Non-record rows age out within the retention
window, so this heals itself except for record holders, which migration 171 reclassifies where it can (§3).

---

## 3. Migrations

Three migrations. 169 and 170 are one column each, on unrelated tables with
different readers, and follow the one-column template of 160/168. 171 is a
bounded data step that reclassifies existing record holders (§10.1). WP1
writes all three, so the registry has one owner.

**Why 171 is its own migration rather than part of 169:**
- 169 stays pure DDL, the shape every column migration here has, and its test
  checks only schema.
- 171 is best-effort and must never block boot. Its own `settingsKey` lets
  the ledger (#4233) record it separately, and a bug in it cannot leave 169
  half-applied.
- 171 needs the column from 169. Registry order guarantees that; bundling
  would not make it any safer.

All DDL passes the **full column definition, name included** (memory note:
a type-only DDL fails past the duplicate-column guard).

### 169 — `src/server/migrations/169_route_segments_transport_mechanism.ts`

```ts
const LABEL = 'Migration 169';
const TABLE = 'route_segments';
const COLUMN = 'transportMechanism';
const INDEX = 'idx_route_segments_source_transport_distance';

// SQLite
addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER`);
db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON route_segments(sourceId, transportMechanism, distanceKm)`);

// PostgreSQL — runMigration169Postgres(client)
await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON route_segments("sourceId", "transportMechanism", "distanceKm")`);

// MySQL — runMigration169Mysql(pool)
await addColumnIfMissingMysql(pool, TABLE, COLUMN, `\`${COLUMN}\` INT`);
await createIndexIfMissingMysql(pool, TABLE, INDEX,
  `CREATE INDEX ${INDEX} ON route_segments(sourceId, transportMechanism, distanceKm)`);
```

File header must explain: effective per-hop value; sentinel → 5; NULL = RF;
why the index exists (below); no backfill here (record holders: migration 171); idempotent on all three.
`down` logs "not implemented".

**Index.** The Info tab polls both endpoints every 60 s, and each now runs one
query per class. `route_segments` reaches ~865k rows on a real install
(#4233). Without the index, `sourceId = ? AND transportMechanism = 6 ORDER BY
distanceKm DESC LIMIT 1` on a mesh with no UDP walks the distance index to
the end. With it, MQTT and UDP lookups are an index seek. RF
(`IS NULL OR NOT IN (5,6)`) still walks `idx_route_segments_distance`, but
stops at the first RF row, which is usually near the top. The record-holder
lookups filter `isRecordHolder = true` first (≤ 3 rows per source), which
`idx_route_segments_recordholder` already serves.

Cost: `ADD COLUMN` nullable with no default is metadata-only on PG, `INSTANT`
on MySQL 8, and O(1) on SQLite. The index build scans the table once, at boot,
like migration 113 did.

### 170 — `src/server/migrations/170_messages_transport_mechanism.ts`

```ts
// SQLite
addColumnIfMissing(db, 'messages', 'transportMechanism', `transportMechanism INTEGER`);
// PostgreSQL
await addColumnIfMissingPostgres(client, 'messages', 'transportMechanism', `"transportMechanism" INTEGER`);
// MySQL
await addColumnIfMissingMysql(pool, 'messages', 'transportMechanism', `\`transportMechanism\` INT`);
```

No index: the counts query already scans one source's rows through
`idx_messages_source_id` and groups them. Column name matches `viaMqtt` and
the sibling tables (camelCase in all three dialects, as `traceroutes` does).
NULL = pre-migration row = classify by `viaMqtt`.

### 171 — `src/server/migrations/171_reclassify_record_holder_transport.ts`

Best-effort: give each existing record holder the transport of the hop that
produced it, where the traceroute still exists.

**Pure helper — new `src/utils/segmentTransportBackfill.ts`** (no DB, no
dialect; unit-tested):
```ts
import { parseHopArray } from './tracerouteSegments.js';
import { segmentTransportMechanism } from './tracerouteTransport.js';
import { classifyNodeTransport, type NodeTransportClass } from './nodeTransport.js';

export const RECLASSIFY_WINDOW_MS = 10 * 60 * 1000;

export interface BackfillSegment { fromNodeNum: number; toNodeNum: number; timestamp: number }
export interface BackfillTraceroute {
  fromNodeNum: number; toNodeNum: number; timestamp: number;
  route: string | null; routeBack: string | null;
  snrTowards: string | null; snrBack: string | null;
  transportMechanism: number | null;
}
export type BackfillMatch =
  | { matched: true; transportMechanism: number | null; tracerouteTimestamp: number }
  | { matched: false };

/**
 * Find the traceroute that produced a stored segment, and derive the hop's
 * mechanism exactly as the live writer does (segmentTransportMechanism).
 *
 * Candidates: timestamp in [seg.timestamp - RECLASSIFY_WINDOW_MS, seg.timestamp].
 * Every writer stamps segments with the traceroute's own timestamp, so the
 * exact match is expected; the window only absorbs clock rounding. Rows NEWER
 * than the segment are ignored: a later response overwrites a pending row's
 * route (finding 8), so its route is no longer the one that made the segment.
 * Nearest (latest) candidate first.
 *
 * Per candidate, the directed pair (seg.from → seg.to) is searched in these
 * hop lists, each with its RAW SNR array index-aligned (hop i arrives with
 * snr[i]):
 *   forward  [toNodeNum, ...route, fromNodeNum]      + snrTowards   (direct-insert rows)
 *   forward' [fromNodeNum, ...route, toNodeNum]      + snrTowards   (pending-updated rows, finding 8)
 *   return   [fromNodeNum, ...routeBack, toNodeNum]  + snrBack      (MQTT return leg)
 *   return'  [toNodeNum, ...routeBack, fromNodeNum]  + snrBack
 * Unfiltered lists, as stored: MQTT keeps raw routes (placeholders included)
 * and TCP stores route/snr already filtered in step, so raw indexes align in
 * both. This also covers the old bootstrap writer, whose segments were
 * adjacent intermediate hops of the same list.
 *
 * First hit wins. Malformed JSON parses to [] (parseHopArray), so that
 * candidate simply does not match. A matched pre-#5097 traceroute (NULL
 * mechanism) still yields MQTT on a sentinel hop, else null (stays RF).
 */
export function matchSegmentTransport(
  segment: BackfillSegment,
  candidates: readonly BackfillTraceroute[],
): BackfillMatch

export interface RecordHolderRow {
  id: number; sourceId: string | null; distanceKm: number;
  timestamp: number; transportMechanism: number | null;
}
/**
 * Records are now one per (source, class). Group flagged rows by
 * (sourceId, classifyNodeTransport({ transportMechanism })) and return the
 * ids to UNFLAG: all but the longest per group (tie → newer timestamp,
 * then higher id). Pure; the migration applies the result.
 */
export function recordHolderIdsToDemote(rows: readonly RecordHolderRow[]): number[]
```

**Migration body** (same algorithm three times, only the IO differs; raw SQL
is allowed in `src/server/migrations/`):

1. `SELECT id, "sourceId", "fromNodeNum", "toNodeNum", timestamp FROM route_segments
   WHERE "isRecordHolder" = <true> AND "transportMechanism" IS NULL`
   (`<true>`: `1` on SQLite/MySQL, `true` on PG; unquoted identifiers on
   SQLite/MySQL). Served by `idx_route_segments_recordholder`; returns a few
   rows per source.
2. For each row, in its own `try/catch` (log `warn`, continue):
   `SELECT "fromNodeNum", "toNodeNum", timestamp, route, "routeBack", "snrTowards", "snrBack", "transportMechanism"
   FROM traceroutes WHERE <sourceId = ? | sourceId IS NULL> AND timestamp BETWEEN ? AND ?
   ORDER BY timestamp DESC LIMIT 50`. Served by `idx_traceroutes_timestamp`.
   Coerce BIGINT columns with `Number()`. Call `matchSegmentTransport`.
3. If `matched` and the mechanism is not null:
   `UPDATE route_segments SET "transportMechanism" = ?
   WHERE <sourceId = ? | IS NULL> AND "fromNodeNum" = ? AND "toNodeNum" = ?
   AND timestamp = ? AND "transportMechanism" IS NULL`.
   This stamps the record row **and** its unflagged twin (the original insert,
   still present while inside retention). Otherwise "Longest Active" would
   show the twin as RF while the record says MQTT. At most two rows, found via
   `idx_route_segments_from_to`. Unmatched rows stay NULL (= RF).
4. Re-read all flagged rows (`id, sourceId, distanceKm, timestamp,
   transportMechanism`, still a few per source). Call
   `recordHolderIdsToDemote`, then
   `UPDATE route_segments SET "isRecordHolder" = <false> WHERE id IN (…)`
   when the list is non-empty. A demoted row becomes an ordinary segment and
   ages out. Before this phase, `clearRecordHolderBySource` kept one flagged
   row per source, so a collision needs leftovers (e.g. NULL-source rows from
   the old SQLite clear-all path). The step costs nothing when there are none.
5. `logger.info` the counts: examined / reclassified (by class) / unmatched /
   demoted.

The outer body catches, logs `error` and returns. A best-effort data step
must not abort startup, and the ledger then records it as done. Correctness
never depends on it: unmatched rows read as RF, and the user can clear any
record per transport.

**How this avoids the #4233 bug class** (a migration that rebuilt 865k rows
on every boot):
- **Once.** The ledger (`migrationLedger.ts`) and the SQLite `settingsKey`
  check run it once per database.
- **Idempotent if re-run anyway** (a crash before the ledger write): step 1
  selects only flagged rows that are **still NULL**, and step 3 updates only
  `IS NULL` rows. A second run redoes the unmatched few and changes nothing
  else. Step 4 on an already-consistent table demotes nothing.
- **Bounded.** Every statement uses an index and is keyed to record-holder
  rows (a few per source) or to one exact (source, pair, timestamp).
  There is no full-table scan of `route_segments` or `traceroutes`, no
  `DELETE`, no `DROP`/`CREATE TABLE`, and no rebuild. The traceroute lookup is
  capped at `LIMIT 50` per row.

### Registry — `src/db/migrations.ts` (after 168, ~2732)

```ts
import { migration as routeSegmentsTransportMigration, runMigration169Postgres, runMigration169Mysql } from '../server/migrations/169_route_segments_transport_mechanism.js';
import { migration as messagesTransportMigration, runMigration170Postgres, runMigration170Mysql } from '../server/migrations/170_messages_transport_mechanism.js';

registry.register({ number: 169, name: 'route_segments_transport_mechanism',
  settingsKey: 'migration_169_route_segments_transport_mechanism', … });
registry.register({ number: 170, name: 'messages_transport_mechanism',
  settingsKey: 'migration_170_messages_transport_mechanism', … });
import { migration as reclassifyRecordHoldersMigration, runMigration171Postgres, runMigration171Mysql } from '../server/migrations/171_reclassify_record_holder_transport.js';
registry.register({ number: 171, name: 'reclassify_record_holder_transport',
  settingsKey: 'migration_171_reclassify_record_holder_transport', … });
```
`migrations.test.ts` is registry-derived; no edit.

### Backup/restore

`systemBackupService` / `systemRestoreService` copy rows by
`Object.keys(row)` (~382, ~459), so the new columns ride along. An old backup
restores with the column NULL, which reads correctly. No change.

---

## 4. File-by-file changes

### 4.1 Schema and types (WP1)

**`src/db/schema/traceroutes.ts`** — add to `routeSegmentsSqlite` /
`routeSegmentsPostgres` / `routeSegmentsMysql`:
```ts
// Effective meshtastic.MeshPacket.TransportMechanism of this hop (#5101):
// the traceroute record's mechanism, or MQTT (5) when the hop's arrival SNR
// was the unknown-SNR sentinel. NULL = pre-migration row → RF.
transportMechanism: integer('transportMechanism'),     // pgInteger / myInt
```

**`src/db/schema/messages.ts`** — add to all three:
```ts
// meshtastic.MeshPacket.TransportMechanism the message arrived on (#5101).
// NULL = pre-migration row → classify by viaMqtt. Outbound sends store INTERNAL (0).
transportMechanism: integer('transportMechanism'),     // pgInteger / myInt
```

**Types** — add `transportMechanism?: number | null;` to:
`DbRouteSegment` in `src/db/types.ts` (~239) **and** the duplicate in
`src/services/database.ts` (~281); `DbMessage` in `src/db/types.ts` (~128)
and `src/services/database.ts` (~187).

**Hand-written test DDL** (the only suites that build these tables by hand
**and** read them with a full `select()` or insert through the repository):

| File | Table | Add |
|---|---|---|
| `src/db/repositories/traceroutes.test.ts` `POSTGRES_CREATE` (~47) | `route_segments` | `"transportMechanism" INTEGER,` |
| same, `MYSQL_CREATE` (~86) | `route_segments` | `transportMechanism INT,` |
| `src/db/repositories/messages.transportCounts.multiBackend.test.ts` (~26, ~65, ~104) | `messages` (SQLite/PG/MySQL) | `transportMechanism INTEGER` / `"transportMechanism" INTEGER` / `transportMechanism INT` |

Checked and **unaffected**: `notifications.test.ts` (never full-selects
`messages`; safe given finding 5), migration suites 029/030/042/045/065/083/
103/123/150 (raw SQL on a pre-state, single migration), `database.extended.test.ts`
(self-contained fake), `traceroutes.test.ts` SQLite leg (built by
`createTestDb`, i.e. the real registry).

**Client contracts — `src/services/api.ts`** (WP1 owns these so WP4 and WP5
can build in parallel):
```ts
import type { NodeTransportClass } from '../utils/nodeTransport';

export interface RouteSegmentView {
  id: number; fromNodeNum: number; toNodeNum: number;
  fromNodeId: string; toNodeId: string;
  fromNodeName: string; toNodeName: string;
  distanceKm: number; timestamp: number;
  isRecordHolder: boolean | null;
  transportMechanism: number | null;   // null = pre-#5101 row (reads as RF)
  transport: NodeTransportClass;
}
/** Legacy top-level fields = the longest of the three; see §4.4. */
export interface RouteSegmentRecords extends RouteSegmentView {
  byTransport: Record<NodeTransportClass, RouteSegmentView | null>;
}

getLongestActiveRouteSegment(sourceId?: string | null): Promise<RouteSegmentRecords | null>
getRecordHolderRouteSegment(sourceId?: string | null): Promise<RouteSegmentRecords | null>
clearRecordHolderSegment(sourceId?: string | null, transport?: NodeTransportClass): Promise<unknown>
//   → DELETE /api/route-segments/record-holder?sourceId=…[&transport=…]

export interface MessageCounts {
  sourceId: string; total: number;
  byTransport: { rf: number; udp: number; mqtt: number };
}
```
The three route-segment methods keep their raw `fetch` (they are in
`services/`, not the lint-banned `components/`/`pages/`).

### 4.2 SQL layer (WP2)

**New `src/db/repositories/transportSql.ts`**
```ts
import { sql, type SQL } from 'drizzle-orm';
import type { NodeTransportClass } from '../../utils/nodeTransport.js';
import { TransportMechanism } from '../../server/constants/meshtastic.js';

/**
 * Class predicate over a stored TransportMechanism column that has no viaMqtt
 * companion (#5101): MQTT(5)→mqtt, MULTICAST_UDP(6)→udp, anything else incl.
 * NULL→rf. Equals classifyNodeTransport with viaMqtt absent. Used by
 * packet_log and route_segments. NOT for messages — they keep a viaMqtt
 * fallback and classify in TS (see MessagesRepository).
 */
export function transportClassCondition(column: SQL, cls: NodeTransportClass): SQL
```
`packetLog.ts` `transportConditions` (~75) replaces its `switch` with
`if (filter.transportClass) out.push(transportClassCondition(column, filter.transportClass));`.
Behaviour unchanged; `packetLog.transportClass.multiBackend.test.ts` proves it.

**`src/db/repositories/traceroutes.ts`**

- `insertRouteSegment` (~348) and `insertRouteSegmentSync` (~676): add
  `transportMechanism: segmentData.transportMechanism ?? null`. (Both suites
  that build `route_segments` by hand gain the column in WP1.)
- A private helper
  `private segmentClassWhere(cls?: NodeTransportClass): SQL | undefined` →
  `cls ? transportClassCondition(sql`${routeSegments.transportMechanism}`, cls) : undefined`.
- `getLongestActiveRouteSegment(sourceId?: SourceScope, transportClass?: NodeTransportClass)`
  — add the class clause. Also (finding 1, §10.3)
  `or(eq(routeSegments.isRecordHolder, false), isNull(routeSegments.isRecordHolder))`,
  with a comment explaining finding 1.
- `getRecordHolderRouteSegment(sourceId?: SourceScope, transportClass?: NodeTransportClass)`
  — add the class clause.
- `clearRecordHolderBySource(sourceId?: SourceScope, transportClass?: NodeTransportClass)`
  — add the class clause. Omitted class = all classes (today's behaviour).
- **New** (moves the compare-and-replace out of the facade so it can be tested
  on all three backends):
  ```ts
  /**
   * Per-(source, transport) all-time record (#5101). The class comes from the
   * segment's own transportMechanism (NULL → rf), so an MQTT-bridged link
   * can never unseat an RF record. Returns true when it set a new record.
   */
  async updateRecordHolderIfLonger(segment: DbRouteSegment, sourceId: SourceScope | undefined): Promise<boolean>
  // cls = classifyNodeTransport({ transportMechanism: segment.transportMechanism })
  // current = getRecordHolderRouteSegment(sourceId, cls)
  // if (!current || segment.distanceKm > current.distanceKm) {
  //   clearRecordHolderBySource(sourceId, cls); insertRouteSegment({ ...segment, isRecordHolder: true }, sourceId as string); return true }
  ```
  Not atomic (read → clear → insert), same as today. Writers run serially per
  source, so leave it.
- `getRecordHolderRouteSegmentSync(sourceId?, transportClass?)` and
  `clearRecordHolderSegmentSync(sourceId?, transportClass?)` (~698, ~720):
  same optional class filter, used only by the SQLite bootstrap below.

**`src/services/database.ts`** (route-segment facades)

- `updateRecordHolderSegmentAsync(segment, sourceId?)` (~5885): delegate to
  `traceroutesRepo.updateRecordHolderIfLonger`; keep the `🏆` debug log, now
  with the class. **Signature unchanged**, so WP3 does not depend on WP2.
- `clearRecordHolderSegmentAsync(sourceId?: string, transportClass?: NodeTransportClass)`
  (~5873): drop the SQLite `…Sync` branch; call
  `traceroutesRepo.clearRecordHolderBySource(sourceId, transportClass)` on
  every backend. (This makes SQLite throw on a missing `sourceId` like PG/MySQL
  already do. WP4's route guards that; see §10.3.)
- `updateRecordHolderSegmentSqlite` (~1358, the one-shot
  `route_segments_migration_v1` bootstrap): pass `'rf'` to the two sync calls.
  Bootstrap segments are written with NULL mechanism, so they are RF.

### 4.3 Messages repository (WP2)

**`src/db/repositories/messages.ts`**

- `insertMessage` (~35) and `insertMessageSqlite` (~410):
  ```ts
  // #5101: only when known, like spoofSuspected — keeps hand-built test
  // fixtures without the column working. `!= null` keeps an explicit 0.
  if (messageData.transportMechanism != null) values.transportMechanism = messageData.transportMechanism;
  ```
- `getMessageCountsByChannelAndTransport(sourceId, excludePortnums = [])` (~276):
  ```ts
  Promise<Array<{ channel: number; transportClass: NodeTransportClass; count: number }>>
  ```
  Select `channel`, `viaMqtt`, `transportMechanism`, `count()`; group by all
  three; classify each group in TS with
  `classifyMessageTransport({ transportMechanism: r.transportMechanism == null ? null : Number(r.transportMechanism), viaMqtt: r.viaMqtt == null ? null : Number(r.viaMqtt) === 1 })`;
  merge groups with the same `(channel, class)`. Classifying in TS, not SQL,
  keeps the rule in one tested function and leaves the dialect boolean
  handling where Phase 1 put it. At most channels × 3 × 8 groups.
- **New `classifyMessageTransport`** in `src/utils/nodeTransport.ts`, next to
  `classifyNodeTransport` (§10.2):
  ```ts
  /**
   * Transport class of a stored MESSAGE (#5101). Deliberately NOT
   * classifyNodeTransport: here viaMqtt WINS.
   *   viaMqtt true            → 'mqtt'
   *   else mechanism 6 (UDP)  → 'udp'
   *   else mechanism 5 (MQTT) → 'mqtt'
   *   else (NULL, 0 INTERNAL, 1-4 LoRa, 7 API) → 'rf'
   * A message that crossed MQTT anywhere on its way (viaMqtt) counts as MQTT
   * even when the last hop to us was LoRa. That keeps the message split equal
   * to Phase 1's viaMqtt-only count, with UDP carved out of RF. Node counts
   * instead use classifyNodeTransport (mechanism first, so a node heard over
   * RF is RF even if its packets were bridged), per the epic's #4240 decision.
   * The two answer different questions: "did this message rely on MQTT?" vs
   * "how did we hear this node?".
   */
  export function classifyMessageTransport(msg: { transportMechanism?: number | null; viaMqtt?: boolean | null }): NodeTransportClass
  ```
  Add a cross-reference line to `classifyNodeTransport`'s doc. Outbound rows
  (`INTERNAL`, §4.4) classify RF, the same as Phase 1 counted them.
- Facade `getMessageCountsByChannelAndTransportAsync` (`database.ts` ~1872):
  return type follows. Update its doc comment.

### 4.4 Ingest writers (WP3)

**`src/utils/tracerouteTransport.ts`** — add (written in **WP1**, because
migration 171's helper calls it; WP3 only uses it):
```ts
import { isUnknownSnr } from './tracerouteSegments.js';
import { TX_MQTT } from './nodeTransport.js';

/**
 * The transportMechanism to store on one route_segments row (#5101).
 * `rawArrivalSnr` is the RAW (x4) firmware value recorded at the hop's far
 * end — snrTowards[i] for segment i of [requester, ...route, responder].
 * Sentinel wins (see module doc): MQTT. Otherwise the record's own mechanism,
 * NULL passed through (reads as RF).
 */
export function segmentTransportMechanism(
  recordMechanism: number | null | undefined,
  rawArrivalSnr: number | undefined,
): number | null
```

**`src/server/meshtasticManager.ts`**

- Segment loop (~8866-8897): in the `segment` literal add
  ```ts
  // #5101: per-hop transport, so records are kept per (source, transport).
  transportMechanism: segmentTransportMechanism(tracerouteRecord.transportMechanism, snrTowards[i]),
  ```
  `snrTowards` (~8405) and `tracerouteRecord` (~8743) are in scope; see
  finding 4 for the index pairing. `updateRecordHolderSegmentAsync(segment, …)`
  is unchanged.
- Received-message literals — add `transportMechanism: resolveRadioPacketTransport(meshPacket),`
  next to `viaMqtt` at: `processTakPacket` GeoChat (~7140),
  `processTakV2Packet` GeoChat (~7272), and the traceroute message in
  `processTracerouteMessage` (~8689; excluded from counts, stamped for
  consistency). Add `transportMechanism?: number` to the local `TextMessage`
  type (~409). `resolveRadioPacketTransport` is already imported.
- `processTextMessageProtobuf` (~6939) serves both received messages and
  Virtual Node client sends:
  ```ts
  // #5101: a Virtual Node client's own send is outbound, not received.
  transportMechanism: context?.virtualNodeRequestId != null
    ? TransportMechanism.INTERNAL
    : resolveRadioPacketTransport(meshPacket),
  ```
  The `_dbchan` / `_radio` copies (~6981 / ~6997) inherit it by spread.
- **Outbound writes stamp `TransportMechanism.INTERNAL` (0)** (§10.4; full
  list in finding 9):
  - `sendTextMessage` (~10143): add `transportMechanism: TransportMechanism.INTERNAL`
    to the `message` literal. This one site covers user sends, DMs,
    auto-responder, auto-ack, auto-welcome, automation, scheduled and bridge
    sends, which all call it.
  - `src/server/routes/v1/actions.ts` (~142, ~201) and
    `src/server/routes/meshRequestRoutes.ts` (~97, ~179), the
    position-request system rows: same field. Import `TransportMechanism`
    from `../constants/meshtastic.js` (`../../constants/…` from `v1/`).
  - The repository writes the column when `!= null`, so an explicit 0 is
    stored (finding 5 rule). INTERNAL classifies RF, which is what Phase 1
    counted for these rows, so no count moves.

**`src/server/mqttIngestion.ts`**

- `persistRouteSegments(sourceId, fullRoute, timestamp)` (~906) — every
  segment gets `transportMechanism: TransportMechanism.MQTT`. Then (finding 2, §10.3)
  also `await databaseService.updateRecordHolderSegmentAsync(seg, sourceId);`
  after the insert, as the TCP writer does.
- `insertAndAnnounceMessage` (~187) is the one path for both MQTT message
  writers (text ~538, Store & Forward ~1128). Stamp there:
  ```ts
  // #5101: every message on this path arrived over MQTT.
  const row = msg.transportMechanism == null ? { ...msg, transportMechanism: TransportMechanism.MQTT } : msg;
  ```
  and insert/emit `row`.

MQTT sources insert no outbound rows (finding 9), so there is nothing to stamp
INTERNAL there. MeshCore (`meshcore_messages`), Reticulum and Dead Drop have their own tables
and never reach InfoTab (`main.tsx` routes MeshCore sources elsewhere). Out of
scope.

### 4.5 Routes (WP4)

**`src/server/routes/routeSegmentRoutes.ts`** — keep the **bare** success
bodies (`ApiService` does not unwrap `data`, and `null` means "no segment"
today). Errors move to `fail()`.

```
GET /api/route-segments/longest-active?sourceId=<id>
GET /api/route-segments/record-holder?sourceId=<id>
  requirePermission('info', 'read', { sourceIdFrom: 'query' })
  200 null                           when no class has a segment
  200 RouteSegmentRecords            otherwise:
      { ...longestOfTheThree, transport, fromNodeName, toNodeName,
        byTransport: { rf: View|null, udp: View|null, mqtt: View|null } }
  500 fail(res, 500, 'ROUTE_SEGMENT_FETCH_FAILED', …)

DELETE /api/route-segments/record-holder?sourceId=<id>[&transport=rf|udp|mqtt]
  requirePermission('info', 'write', { sourceIdFrom: 'query', requireSourceId: true })
  400 INVALID_TRANSPORT              transport present and not rf|udp|mqtt
  200 ok(res)                        transport omitted → all classes (legacy)
  500 fail(res, 500, 'RECORD_HOLDER_CLEAR_FAILED', …)
```

One helper serves both GETs:
```ts
async function buildRecords(
  sourceId: string | undefined,
  fetch: (scope: SourceScope, cls: NodeTransportClass) => Promise<DbRouteSegment | null>,
): Promise<RouteSegmentRecords | null>
```
It runs the three class queries in parallel, enriches each with node names
(today's `getNode(num, sourceId)` fallback to the id), sets
`transport = classifyNodeTransport({ transportMechanism })` and
`transportMechanism: row.transportMechanism ?? null`, and returns null when
all three are null. The top level is the entry with the largest
`distanceKm`: the same row today's unfiltered query returns, since the three
classes partition the rows. So legacy consumers see the same payload plus two
new keys. `sourceId` omitted keeps `ALL_SOURCES`, as today.

Consumers checked: `InfoTab.tsx` (WP5); `api.test.ts` ~797 (URL only);
`InfoTab.transportBreakdown.test.tsx` (mocks resolve `null`; still valid);
`routeSegmentRoutes.test.ts` (rewritten, below); `tests/api-exercise-test.sh`
~355-356 (GETs without `sourceId`, status only, as admin → still 200; no
DELETE); `PERMISSIONS_QUICK_REFERENCE.md` (paths unchanged). No embed,
Dashboard, v1 API or other shell test references these routes.

**`src/server/routes/messageRoutes.ts`** `GET /counts` (~1140):
```ts
const byTransport = { rf: 0, udp: 0, mqtt: 0 };
for (const row of rows) {
  if (!access.canReadChannel(row.channel)) continue;
  byTransport[row.transportClass] += row.count;
}
return ok(res, { sourceId, total: byTransport.rf + byTransport.udp + byTransport.mqtt, byTransport });
```

### 4.6 InfoTab UI (WP5)

**New `src/components/RouteSegmentRecord.tsx` + `RouteSegmentRecord.module.css`**
```tsx
export interface RouteSegmentRecordProps {
  segment: RouteSegmentView;
  /** Transport label shown; omit on MQTT-only sources. */
  transportLabel?: string;
  timeLabel: string;              // t('info.last_seen') or t('info.achieved')
  distanceUnit: …; timeFormat: …; dateFormat: …;
  showTrophy?: boolean;           // record card: <UiIcon name="trophy" />
  legacyNote?: string;            // shown when segment.transportMechanism === null
  onClear?: () => void;           // renders the Clear Record button
  clearLabel?: string;
  testId?: string;
}
export default function RouteSegmentRecord(props): React.ReactElement
```
Renders a small transport label, then distance / from / to / time as today.
CSS uses `var(--color-text-muted)` etc., **no fallbacks**. Replace the inline
`color: '#888'` in the moved markup. Export only the component
(react-refresh rule). `UiIcon` only, no emoji.

**`src/components/InfoTab.tsx`**
- `RouteSegment` local interface → import `RouteSegmentView`,
  `RouteSegmentRecords` from `../services/api`. State holds
  `RouteSegmentRecords | null` for both cards.
- Card body (both cards, order RF → UDP → MQTT):
  - `showTransport`: render one `RouteSegmentRecord` per non-null
    `byTransport[cls]`, labelled `t('transport.' + cls)`. Empty classes are
    hidden. All null → today's `info.no_active_routes` / `info.no_record_holder`.
  - `!showTransport` (MQTT-only): render the top-level record with no label.
  - Record card only: `legacyNote = t('info.record_legacy_transport_note')`
    when `transportMechanism === null`, and `onClear` when `isAuthenticated`.
- Clear flow: replace `showConfirmDialog: boolean` with
  `clearTarget: NodeTransportClass | 'all' | null`. The button on an RF
  record sets `'rf'`; on an MQTT-only source it sets `'all'`. The dialog body
  uses `info.clear_record_confirm_transport` (with the class label) or the
  existing `info.clear_record_confirm` for `'all'`. Confirm calls
  `apiService.clearRecordHolderSegment(activeSourceId, target === 'all' ? undefined : target)`,
  then **re-fetches** the segments (other classes must stay), then toasts.
  Keep the `useCallback` wrappers with complete deps; no new
  `exhaustive-deps` counts.
- Total Messages: pass
  `counts={{ rf: byTransport.rf, udp: byTransport.udp ?? 0, mqtt: byTransport.mqtt }}`
  (the `?? 0` guards a server one release behind).

**`public/locales/en.json`** (flat keys; other locales fall back):
```
"info.clear_record_confirm_transport": "Are you sure you want to clear the {{transport}} record holder? This action cannot be undone.",
"info.record_cleared_transport": "{{transport}} record holder cleared",
"info.record_legacy_transport_note": "Set before MeshMonitor recorded transport, and its traceroute is gone, so it counts as RF even if the link crossed MQTT.",
"info.route_record_label": "{{transport}} record"
```
`info.route_record_label` is the `aria-label` of each record block.

---

## 5. Source types

- **Meshtastic TCP**: full per-transport split in both cards and messages.
- **MQTT-only (`mqtt_bridge`, `mqtt_broker`)**: every segment and message is
  MQTT, so the split is hidden (`isMqttOnlySourceType`, as in Phase 1). The
  cards show one unlabelled record. It now gets an MQTT record (finding 2).
- **MeshCore**: InfoTab never mounts. No change.

---

## 6. Mesh impact checklist

1. **Airtime:** none. No packet is sent, requested or retried.
2. **Spam:** none. No new `dataEventEmitter` events, notifications or
   automation triggers. A new record fires nothing today and still fires
   nothing. MQTT-ingest record tracking (finding 2) is one DB read per stored
   segment, plus a write on a new record.
3. **Timers:** none added. The Info tab keeps its 60 s polls (still two
   route-segment requests). Each request now runs three indexed queries
   instead of one.
   Migration 171 runs once at boot, touches only the database, and sends
   nothing.

---

## 7. Test plan

Before trusting a local run in an agent worktree:
`git submodule update --init --recursive` and symlink `node_modules`. Start
the PG (5433) and MySQL (3307) containers from CLAUDE.md, or those suites
skip silently. Check `numPendingTests` in the JSON reporter, not the headline.

**Migrations (WP1)**
- `169_route_segments_transport_mechanism.test.ts` (SQLite, better-sqlite3
  in-memory, pre-169 `route_segments` DDL): `up` twice is a no-op the second
  time; `PRAGMA table_info` shows the column; `sqlite_master` shows the index;
  an existing row reads NULL.
- `169_route_segments_transport_mechanism.pgmysql.test.ts`: own database via
  `createIsolatedPostgresDatabase('m169')` / `createIsolatedMysqlDatabase('m169')`.
  Pre-state = the `route_segments` DDL from `traceroutes.test.ts`. Run twice;
  column present; index present (`pg_indexes` / `information_schema.STATISTICS`);
  Drizzle insert + select round-trips `transportMechanism: 6`; old row NULL.
- `170_messages_transport_mechanism.test.ts` and `.pgmysql.test.ts`: same
  shape. Pre-state = the `messages` DDL from
  `messages.transportCounts.multiBackend.test.ts`. Round-trip 0 as 0, not
  NULL.
- `src/services/api.test.ts`: `clearRecordHolderSegment('s1', 'mqtt')` hits
  `…/record-holder?sourceId=s1&transport=mqtt`; no transport → no param.
- New `src/utils/segmentTransportBackfill.test.ts` (pure):
  `matchSegmentTransport`:
  - direct-insert row (from = responder): pair found on the forward list,
    record 1 → 1, and a sentinel on that hop → 5;
  - pending-updated row (endpoints swapped) → found via `forward'`;
  - pair only on the return leg → uses `snrBack[i]`;
  - an endpoint pair (requester → first hop, last hop → responder) matches;
  - pre-#5097 row (NULL mechanism): sentinel → 5, no sentinel → `null` (matched, stays RF);
  - candidate newer than the segment → ignored; older than the window → ignored;
  - two candidates: the nearest (latest ≤) wins;
  - pair absent from every list → `{ matched: false }`;
  - malformed JSON (`'[1,2'`, `'null'`, `'{}'`, `null`) → no throw, no match;
  - placeholder hop `0xFFFFFFFF` in a raw MQTT route keeps SNR alignment.

  `recordHolderIdsToDemote`: one row per group → `[]`; two RF rows in one
  source → demote the shorter; RF + MQTT in one source → `[]`; same class
  across two sources → `[]`; NULL-source rows group together; distance tie →
  keep the newer.
- `171_reclassify_record_holder_transport.test.ts` (SQLite, `createTestDb`
  so 169 has run) and `.pgmysql.test.ts` (`createIsolatedPostgresDatabase('m171')`
  / `createIsolatedMysqlDatabase('m171')`, DDL for `traceroutes` +
  `route_segments` from `traceroutes.test.ts` incl. the new column and index).
  Seed per source:
  - an RF record whose traceroute has mechanism 1 → stamped 1, twin stamped 1;
  - a record whose hop has the sentinel → stamped 5; with an RF record already
    present in the same source, both stay flagged (different classes);
  - two NULL-source flagged rows that both resolve to RF → the shorter is
    demoted;
  - a record with no traceroute → stays NULL and flagged;
  - a traceroute row with malformed `route` → skipped without error.

  Then run the migration a **second** time: no row changes (compare a
  snapshot), no error. Assert it never touches unflagged rows of other pairs
  (count rows with non-NULL mechanism before/after), and that the row count of
  `route_segments` is unchanged (no delete/rebuild).

**Repository, all three backends (WP2)**
- `traceroutes.test.ts` (extend the shared suite, runs on every backend):
  insert persists `transportMechanism`; per class for
  `getRecordHolderRouteSegment` and `getLongestActiveRouteSegment` with
  mechanisms `[null, 0, 1, 5, 6, 7]` → rf/rf/rf/mqtt/udp/rf;
  `updateRecordHolderIfLonger`: a longer MQTT segment does not unseat the RF
  record and becomes the MQTT record; a shorter RF one does nothing; a longer
  RF one replaces only RF; `clearRecordHolderBySource(src, 'mqtt')` leaves RF;
  no class → clears all; longest-active ignores a flagged row that is
  longer than every unflagged one. Existing tests stay green.
- New `traceroutes.recordHolder.perSource.test.ts` (SQLite, `createTestDb`):
  sources A and B each with RF and MQTT records; update and clear on (A, rf)
  touch nothing else; `sourceId` `''`/`undefined` throws.
- `packetLog.transportClass.multiBackend.test.ts`: unchanged and green
  (proves the `transportSql.ts` extraction).
- `messages.transportCounts.multiBackend.test.ts` (rewrite expectations):
  matrix `transportMechanism ∈ {null, 0, 1, 5, 6, 7}` × `viaMqtt ∈ {null, false, true}`;
  each row's class equals `classifyMessageTransport` for that pair (parity), in particular (1, true) → mqtt and (6, true) → mqtt;
  groups merge per (channel, class); TRACEROUTE_APP excluded; `count` is a
  number on PG; insert with `transportMechanism` undefined stores NULL, 0
  stores 0.
- `messages.transportCounts.perSource.test.ts`: new shape; isolation holds.

**Ingest (WP3)**
- (WP1) `nodeTransport.test.ts`: `classifyMessageTransport` over the full
  matrix `{null, 0, 1, 5, 6, 7} × {null, false, true}`; `viaMqtt` true is
  mqtt for every mechanism, incl. 1 and 6; `(0, null)` → rf. Keep one case
  showing `classifyNodeTransport({1, true})` = rf, pinning the deliberate
  difference.
- (WP1) `tracerouteTransport.test.ts`: `segmentTransportMechanism` — raw `-128`
  → 5; normal SNR → record value; `undefined` SNR → record value; NULL record,
  no sentinel → null; UDP record + sentinel → 5.
- `meshtasticManager.traceroute-hops.test.ts` (extend): with record mechanism
  1 and `snrTowards` `[40, -128, 20]`, the stored segments carry `1, 5, 1` in
  order; `updateRecordHolderSegmentAsync` receives the same values;
  `viaMqtt`-only packet → every non-sentinel hop 5; explicit UDP → 6.
- New `meshtasticManager.messageTransport.test.ts` (template: Phase 1's
  `meshtasticManager.packetLogTransport.test.ts`): `insertMessage` receives
  `transportMechanism` 6 for UDP, 5 for `{transportMechanism: undefined, viaMqtt: true}`,
  1 for neither; the `_dbchan` copy carries the same value; a packet with
  `context.virtualNodeRequestId` → 0 (INTERNAL).
  Extend `meshtasticManager.atak.test.ts` / `atakV2.test.ts` GeoChat cases
  with `expect.objectContaining({ transportMechanism: 1 })`.
- Outbound: in the send-path test that already covers `sendTextMessage`'s
  insert (e.g. `meshtasticManager.deliveryEvents.test.ts`, or add a case to
  `messageTransport.test.ts`), assert `transportMechanism: 0`. Extend
  `src/server/routes/v1/actions.test.ts` and the `meshRequestRoutes` test
  (position request) to expect `transportMechanism: 0` on the inserted row.
- `mqttIngestion.test.ts`: forward and return segments carry 5; text and
  S&F messages carry 5; `updateRecordHolderSegmentAsync` called per
  stored segment. Add `updateRecordHolderSegmentAsync: vi.fn(async () => undefined)`
  to the `databaseService` mock in **all five** files that mock this module's
  DB: `mqttIngestion.test.ts` ~22, `mqttBridgeManager.test.ts` ~65,
  `mqttBrokerManager.test.ts` ~27, `mqttBrokerManager.restart.test.ts` ~34,
  `mqttPacketLogService.ingestHook.test.ts` ~27.

**Routes (WP4, `createRouteTestApp`; template `sourceRoutes.permissions.test.ts`)**
The harness does not clear `route_segments` or `messages`; delete seeded rows
in `afterEach` (`deleteAllRouteSegments(sourceA|B)`). Grants need a `sourceId`.
- **Rewrite** `routeSegmentRoutes.test.ts` onto the harness (it is being
  touched; the deprecated `vi.mock('../../services/database.js')` pattern
  goes). Cases: `null` when empty; shape (legacy fields = longest of the
  three, `transport`, `byTransport` with the empty class `null`); node-name
  enrichment and id fallback; `?sourceId=A` never returns B's rows; DELETE
  `transport=mqtt` keeps RF; no transport clears all; `transport=bogus` → 400
  `INVALID_TRANSPORT`; no `info:write` → 403; no `sourceId` on DELETE →
  400 `MISSING_SOURCE_ID`; `info:read` on B only → 403 for `?sourceId=A`.
- `messageRoutes.counts.test.ts` (extend): `udp` present; invariant
  `total === rf + udp + mqtt`; legacy row (mechanism NULL, `viaMqtt` true) →
  mqtt; mechanism 1 + `viaMqtt` true → mqtt (viaMqtt wins, §10.2); mechanism 0 + `viaMqtt` null → rf (outbound); mechanism 6 → udp; the
  existing permission cases unchanged.

**Components (WP5)**
- New `RouteSegmentRecord.test.tsx`: label shown/omitted; legacy note only
  for `transportMechanism === null`; clear button only with `onClear`.
- `InfoTab.transportBreakdown.test.tsx` (extend): message split shows UDP;
  a `byTransport` fixture with `rf` + `mqtt` renders two labelled records and
  no UDP block; all-null → no-data text; `sourceType: 'mqtt_bridge'` renders
  the top-level record unlabelled; clicking Clear on the MQTT record and
  confirming calls `clearRecordHolderSegment(sourceId, 'mqtt')` then refetches.
- `InfoTab.packetDistributionLayout.test.ts` must pass unchanged.

**Gates:** full Vitest suite with PG + MySQL up (`success: true`, skipped
count checked); `npx tsc --noEmit -p tsconfig.server.json` and the client
tsconfig; `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'`
empty. Dev deploy + Info tab screenshots (desktop and phone width) for the PR.

---

## 8. Work packages

File ownership is exclusive inside a wave. The contended files are
`src/services/database.ts`, `src/services/api.ts`, `meshtasticManager.ts`,
`mqttIngestion.ts` and `en.json`; the split below gives each one owner per
wave.

### Wave 1

**WP1 — Schema, migrations, shared helpers, contracts.** Medium.
Files: `src/db/schema/traceroutes.ts`, `src/db/schema/messages.ts`,
`src/db/types.ts`, `src/services/database.ts` (the two interface blocks
only), new `169_*` / `170_*` / `171_*` migrations + tests,
`src/db/migrations.ts`, `src/utils/tracerouteTransport.ts`
(`segmentTransportMechanism`) + test, `src/utils/nodeTransport.ts`
(`classifyMessageTransport`) + test, new `src/utils/segmentTransportBackfill.ts`
+ test, `traceroutes.test.ts` (DDL only),
`messages.transportCounts.multiBackend.test.ts` (DDL only),
`src/services/api.ts` (types + the three route-segment methods +
`MessageCounts`), `src/services/api.test.ts`.
The helpers land here because 171 calls `segmentTransportMechanism`, and WP2
and WP3 both consume them.
Accept: 169/170 idempotent on all three backends; 171 reclassifies, demotes
collisions, tolerates malformed JSON, and a second run changes nothing, on
all three backends (PG/MySQL suites ran, not skipped); no full-table scan or
rebuild in 171 (review the statements against §3); full suite green; `tsc`
clean.

### Wave 2 (parallel, after WP1)

**WP2 — SQL layer and repositories.** Medium.
Files: new `src/db/repositories/transportSql.ts`, `packetLog.ts`,
`traceroutes.ts`, `messages.ts`, `src/services/database.ts` (route-segment
and message-count facades, bootstrap helper), `traceroutes.test.ts`, new
`traceroutes.recordHolder.perSource.test.ts`,
`messages.transportCounts.multiBackend.test.ts`,
`messages.transportCounts.perSource.test.ts`.
Also `messageRoutes.ts` `/counts` loop (§4.5): the repo's return type changes
here, so the route must change in the same commit or `tsc` fails. Plus
`messageRoutes.counts.test.ts`.
Accept: one class predicate (`transportClassCondition`) serves packet_log and
route_segments; the parity and per-source tests pass on all backends;
Packet Monitor and packet-distribution tests unchanged and green.

**WP3 — Ingest writers.** Medium.
Files: `meshtasticManager.ts`, `mqttIngestion.ts`,
`src/server/routes/v1/actions.ts` (+ `actions.test.ts`),
`src/server/routes/meshRequestRoutes.ts` (+ `meshRequestRoutes.test.ts`),
`meshtasticManager.traceroute-hops.test.ts`, new
`meshtasticManager.messageTransport.test.ts`, `meshtasticManager.atak*.test.ts`,
the send-path test chosen in §7, the five MQTT test mocks listed in §7.
Depends only on WP1's types. `updateRecordHolderSegmentAsync` keeps its
signature, so WP3 does not wait for WP2.
Accept: every received Meshtastic message and every new segment carries a
mechanism; every outbound write stores INTERNAL (0); per-hop sentinel → 5; tests fail before
and pass after.

### Wave 3 (parallel, after WP2 and WP3)

**WP4 — Route-segment routes.** Small.
Files: `routeSegmentRoutes.ts`, `routeSegmentRoutes.test.ts` (rewrite).
Accept: shape per §4.5; legacy top-level fields equal the unfiltered longest;
permission cases per §10.3; `tests/api-exercise-test.sh` untouched and
still valid.

**WP5 — InfoTab UI.** Medium.
Files: `InfoTab.tsx`, new `RouteSegmentRecord.tsx` / `.module.css` /
`.test.tsx`, `InfoTab.transportBreakdown.test.tsx`, `public/locales/en.json`.
Builds against WP1's `api.ts` contract with mocked responses.
Accept: labelled per-transport records, empty classes hidden, MQTT-only
unlabelled; per-transport clear re-fetches and leaves other classes; UDP in
the message split; layout test green; no new lint-ratchet counts;
screenshots from a dev deploy.

Then update `TRANSPORT_BREAKDOWN_EPIC.md` (Phase 2 boxes + status log).

---

## 9. Risks

- **R1 — Reclassify finds little on old installs.** Traceroutes age out and
  are capped per node pair (`cleanupOldTraceroutesForPair`), so an old record
  often has no traceroute left. It stays RF. If it really crossed MQTT, it can
  block a genuine RF record until someone clears it. The legacy note (§4.6)
  says why, and per-transport Clear fixes it in one click. Report the
  migration's matched/unmatched counts in the PR from a real database.
- **R2 — Reclassify guesses the producing traceroute.** It trusts the latest
  traceroute at or before the segment's timestamp, within 10 min, that
  contains the pair. Writers stamp both with the same timestamp, so a wrong
  match needs two traceroutes on one source with the same hop pair inside
  that window. The worst case is a record filed under the wrong class, which
  Clear fixes.
- **R2b — `viaMqtt` wins for messages, but not for nodes.** A LoRa-delivered,
  MQTT-bridged message counts MQTT while its sender counts as an RF node. This
  is deliberate (§10.2) and documented in `classifyMessageTransport`. Say so
  in the PR so nobody "fixes" one to match the other.
- **R3 — Sentinel ≠ MQTT.** Relay-role and decrypt-failure hops also write
  the sentinel, so a genuine RF hop can land in MQTT. Same trade-off as the
  map (#5097) and the survey; documented in the column and helper.
- **R4 — Index build at boot** on large PG/MySQL `route_segments` tables
  (~865k rows seen): one scan, blocks writes to that table for its duration.
- **R5 — Test DDL drift.** Forgetting the column in `traceroutes.test.ts`
  PG/MySQL DDL fails every `route_segments` case there (full `select()`), not
  just the new ones.
- **R6 — Permission scoping tightens access (§10.3).** A non-admin who reads the Info tab of a source
  they have no `info:read` grant on will get 403 on these cards. That is the
  intended per-source model, but it is a visible change.

---

## 10. Decisions (user, 2026-09-23)

The first revision listed these as questions. The user's answers, and where
each lands in this spec:

1. **Existing record holders → best-effort reclassify** (not the first
   revision's recommendation). Migration 171 + `segmentTransportBackfill.ts`
   (§3). Rows with no matching traceroute stay NULL (RF). Collisions in one
   (source, class) keep the longest and demote the rest. The UI legacy note
   (§4.6) remains for the unmatched rows.
2. **Message classifier → `viaMqtt` wins** (not the first revision's
   recommendation): `viaMqtt` → mqtt; else 6 → udp; else 5 → mqtt; else rf.
   `classifyMessageTransport` (§4.3) documents why it differs from
   `classifyNodeTransport`. No MQTT → RF shift against Phase 1.
3. **All three extra fixes approved:** Longest Active excludes record copies
   (§4.2); MQTT sources set record holders (§4.4); route-segment permission
   scoping, `sourceIdFrom: 'query'` on the GETs and `sourceId` required on
   DELETE (§4.5).
4. **Outbound messages → stamp `INTERNAL (0)`** (not the first revision's
   recommendation). Every outbound write path (finding 9, §4.4). INTERNAL
   classifies RF. The repository still writes the column only when non-null
   (finding 5), and `!= null` keeps the 0.

---

## 11. Deferred

- `route_segments` position snapshot columns are never written (finding 7).
  Separate issue.
- Poll's third copy of the message-read predicate (from Phase 1).
- `/api/unified/*` gets no per-transport records (InfoTab is per-source).
- Exposing `transportMechanism` on `GET /api/messages` rows (e.g. a per-message
  transport badge). Not needed for counts.
