# Walkabout Coverage Epic (#5891): Phase 3 Spec — Coverage import

Status: draft for maintainer review (2026-11-25). Branch `feature/walkabout-p3-5891`
from `origin/main` at `49248b588` (P1 #6570 and P2 #6572 merged).

**The ask (#5891 Part 2):** accept a GeoJSON or CSV file that MeshMonitor
exported; check its schema and every row; reject with a clear message; tag
imported rows with where they came from so the map shows them apart and a
filter can hide them; prove it with a round trip (export, import on a clean
DB, the map shows the same points).

**Scope in one line:** P3 imports **Coverage Report** files (the only export
that exists). Walkabout sessions have no export today; adding export and import
for them is Q1, recommended as a follow-up (P3b).

MeshMonitor sends nothing for this phase.

---

## 1. Reuse inventory (read first)

| What | Where | How P3 uses it |
|---|---|---|
| Export builders + column contract | `src/utils/coverageExport.ts` (`CSV_COLUMNS`, `buildCoverageCsv`, `buildCoverageGeoJson`, `guardFormulaInjection`) | The import contract. WP0 exports the column list as `COVERAGE_EXPORT_COLUMNS` so the importer checks the same list (drift test). The round-trip test feeds the real builders' output to the importer. |
| Export UI | `src/components/Analysis/CoverageExportButtons.tsx`, placed in `CoverageReport.tsx:702` | The Import button sits beside it in the same toolbar row. |
| Reception table + repo | `src/db/schema/coverageReceptions.ts`, `src/db/repositories/coverageReceptions.ts` (`recordReception`, `getReceptions`, `getReceivers`, `getSenderSummary`, `purgeOlderThan`, `exportSurveyReceptions`, `deleteForSource`, `deleteAll`) | Imported rows live in this table with a new `importId` column. Every read path (map, receivers, senders, summary, gaps, grid, export) works on them unchanged. |
| Unique key | `cov_rx_path_uniq (sourceId, receiverId, senderId, packetKey, pathKey)` (migration 172) | Row-level dedupe on re-import and overlapping files, for free. |
| `insertIgnore` | `src/db/repositories/base.ts:260` | **Not** reused for batches: on MySQL it try/catches the whole statement, so one duplicate in a multi-row insert loses the batch. WP2 adds a batch-safe variant (§3.5). |
| Retention purge seam | `CoverageReceptionsRepository.purgeOlderThan(cutoff, exemptions)` called by `coverageRetentionService.runCleanup` | Gains `importId IS NULL`, so imports are kept until deleted. |
| Backup filtered exporter | `FILTERED_EXPORTERS.coverage_receptions` in `systemBackupService.ts:62` → `exportSurveyReceptions(windows)` | Also exports rows with `importId IS NOT NULL`, paged (ids dropped, same PG sequence reason). §3.6. |
| Position gates | `buildPositionFilter`, `buildMeshCorePositionFilter`, `loadNodesBySource`, `loadMeshCoreNodesBySource` (`src/server/utils/positionVisibility.ts`), `loadSourcePermissions` | A resolved imported node gets exactly these gates. Both filters return `false` for a node with no row on the source (admins too), so an **unresolved** imported node needs the new rule in §2.5. |
| Sender/receiver id parsing | `parseSenderParam` (`src/server/utils/coverageSenderParam.ts`), `nodeNumToId`, `isMeshCorePubKeyId`, `parseMeshCorePathKey`, `meshtasticPathKey`, `formatCoverageNodeId` (`src/utils/coverage.ts`) | Row validation and label fallback. |
| Fix grouping | `groupReceptionsIntoFixes` (`src/utils/coverage.ts`) | What the map draws; the round-trip test compares its output. |
| Raw upload pattern | `geojsonRoutes.ts:48` (`express.raw({ type: '*/*', limit })` + `X-Filename`), client `GeoJsonLayerManager.tsx:29` (`useCsrfFetch`, `application/octet-stream`) | Same pattern. `octet-stream` means the global `express.json` (10 MB in prod, 100 KB in the route harness) never parses the body, so the harness limit does not matter. |
| Long-request guard | `extendRequestTimeout` (`src/server/middleware/requestTimeout.ts:58`, #5494) | On the import POST (120 s). |
| Source protocol | `isAnyMeshCoreSourceType` (`src/utils/nodeTypeCategory.ts:318`) on `sources.type` (DB row, not the manager: a stopped source can still take an import) | Picks the target protocol. |
| Per-source router + grants | `walkaboutRoutes.ts` (`canRead`/`canWrite` with `sourceIdFrom: 'params.id', requireSourceId: true`), `WALKABOUT_READ_GRANT`/`WALKABOUT_WRITE_GRANT` | Same gates (`nodes:read` list, `nodes:write` import/delete; Q3). |
| UUID PK precedent | `coverage_surveys.id`, `coverage_walkabout_sessions.id` | `coverage_imports.id` is a UUID (PG restore sequence trap). |
| Source delete cascade | `sourceRoutes.ts:1933` (walkabout block) | Add the import cleanup next to it. |
| Purge cascade | `database.ts:4114` (`purgeAllNodesAsync` → `coverageReceptionsRepo.deleteForSource`/`deleteAll`) | Keeps imported rows (Q6). |
| UI pieces | `Modal`, `SearchableSelect`, `UiIcon`, `reports-btn` classes, `useReadableWalkaboutSources` pattern, `CoverageSurveyBar` (window-setting precedent) | Import dialog, imports list, "Show on map". |
| Migration helpers | `addColumnIfMissing*` (full column DDL, PG quoted), `createTableIfMissingMysql`, `createIndexIfMissingMysql` | Migration 249. |

**Searched and not found:** no CSV file parser exists (`meshIssuesRoutes.parseCsvFilter` splits a query param only), so WP1 writes a small RFC 4180 reader. No walkabout export exists (no download/export in `Walkabout*.tsx` or `walkaboutApi.ts`).

**Measured** with the real builders (10 000 rows, mixed protocols): CSV 3.2 MB, GeoJSON 11.4 MB (pretty-printed; all-MeshCore rows run ~12.7 MB). A 10k-row GeoJSON is over the 10 MB JSON limit, which settles the raw-upload choice.

---

## 2. Design decisions

### 2.1 What is importable: Coverage Report exports only (Q1)

The only exporter is the Coverage Report's. Walkabout data never leaves the server
raw (P2 sends cells, never points), so importing walkabout means first designing an
export, its privacy rules (hidden-node drop at session level, P2's hidden-count
rule), and a second row model (samples + credited receptions). That doubles the
phase. The batch table carries a `kind` column (`'coverage_report'` now) so P3b
can add `'walkabout'` without a migration. Recommended in Q1.

### 2.2 Where rows live: same table, plus a batch table

Imported rows go into `coverage_receptions` with a nullable `importId`. A new
per-source table `coverage_imports` holds one row per imported file.

A separate rows table would avoid the five side effects below, but every read
(`getReceptions` with its `(receivedAt, id)` cursor, `getReceivers`,
`getSenderSummary`) would need a UNION or a second paginated stream that the
client merges with its 10-page cap, and the sender/receiver pickers would need
it too. The same table costs five small, testable changes instead:

| Side effect | Fix |
|---|---|
| `purgeOlderThan` deletes old `receivedAt` (imports are old on arrival) | Add `isNull(importId)` to the purge WHERE. |
| Backup exports only survey windows; restore clears the table | The filtered exporter also pages out `importId IS NOT NULL` rows (§3.6). |
| Re-importing on the instance that made the export collides with live rows | Accept: those rows are already there (counted `duplicates`); they still age out. The UI says "save a survey to keep live data" (Q7). |
| MySQL `insertIgnore` loses a whole multi-row batch on one duplicate | New `insertImportedRows` uses `.ignore()` on MySQL (drizzle 0.45 has `MySqlInsertBuilder.ignore()`), `onConflictDoNothing()` on SQLite/PG. Test with a duplicate mid-batch on all three backends. |
| Purge nodes calls `deleteForSource`/`deleteAll` | Purge keeps imported rows (Q6): new `{ keepImported: true }` option. Source delete still removes everything. |

### 2.3 Which source owns imported rows

The importer picks a **target source** (route param `:id`). There is no virtual
"imported" scope: per-source scoping and per-source grants are hard rules, and a
virtual scope would need its own permission model. The file's `sourceId` and
`sourceName` are provenance only and are **never** trusted as a target. A
multi-source export collapses into the one target; two origin rows that differ
only by origin source dedupe to one (same physical reception).

Target protocol: `isAnyMeshCoreSourceType(source.type)` → `meshcore`;
`reticulum` → 400 `IMPORT_SOURCE_UNSUPPORTED`; anything else → `meshtastic`. Rows
whose `protocol` differs from the target are **skipped and counted**
(`skipped.protocolMismatch`), not errors: they are valid rows that belong
elsewhere. If no rows remain → 400 `IMPORT_NO_MATCHING_ROWS`.

### 2.4 Identity

- Meshtastic `senderId`/`receiverId` must be `!xxxxxxxx`; `senderNodeNum` /
  `receiverNodeNum` are re-derived from it (never null for Meshtastic imports, so
  the old "null nodeNum is always kept" carve-out never applies).
- MeshCore ids must be 64 hex; stored lowercased (as the recorder does).
- `packetId` = `Number(packetKey)` for Meshtastic; `rxTime`, `transportMechanism`
  null (not exported).
- **Names are not imported.** `senderName`, `receiverName`, `sourceName` are
  untrusted text from a file; storing them needs new columns, a redaction-catalogue
  entry and injection care, and a name for a node that resolves on the target is
  already known. Resolved nodes show their live names; unresolved nodes show
  `formatCoverageNodeId(id)`.
- `distanceKm` is ignored (derived on export).
- A node **resolves** when the target source has a `nodes` row with that
  `nodeNum` (Meshtastic) or a `meshcore_nodes` row with that public key (MeshCore).
  Resolution is decided at read time, not stored, so a node that appears later
  resolves then.

### 2.5 Privacy: who sees imported rows

A file can only be written into a source the user can **write**, and its rows
reach only readers of that source through the existing `/receptions` scope
(`resolvePermittedSourceIds`, resource `nodes`). For each imported row
(`importId != null`):

1. Sender **resolves** on the row's source → the existing gate, unchanged
   (`hideFromMap`, MQTT consent, private override, channel `viewOnMap` /
   MeshCore `viewOnMap`). An import can never show a hidden or private node that
   lives on the target.
2. Sender **does not resolve** → visible when the caller is an admin or holds
   the source's base map grant: `nodes:viewOnMap` on a MeshCore source (the
   grant that already governs MeshCore positions there), `channel_0:viewOnMap`
   on a Meshtastic source. `nodes:viewOnMap` is not offered for Meshtastic
   sources in the permissions editor (`UsersTab.tsx:1041`, `showNodesViewOnMap`),
   so it cannot be the Meshtastic grant; the row's own `channel` is the origin's
   slot number and means nothing on the target, so the primary channel's map
   grant stands in. This is Q2. Without some such rule, imported rows on a clean
   DB vanish for everyone (both filters return `false` with no node row), and
   the round-trip exit test fails.
3. Receiver coordinates: same two cases on `receiverNodeNum` / `receiverId`; a
   failed check nulls the pair, as today.
4. Imported rows never get cross-source flags (`senderIsOwnSource` false), and
   `crossSourceOnly=true` excludes them. Their origin is a file, not our radio.

Live rows keep today's rule exactly: an orphaned live row (node pruned) still
drops.

The exported file is the trust boundary. An admin's export can hold nodes the
admin could see; once it is a file, the importing operator decides. The import
endpoint reveals nothing new: it reports counts only (`inserted`, `duplicates`).
A duplicate count could confirm that a live row exists, but only if the uploader
already knows its exact `(receiverId, senderId, packetKey, pathKey)`, which
needs a 32-bit packet id and path; we accept that.

### 2.6 Validation (all-or-nothing)

The server parses and checks the whole file, then writes. Any error → 400 with
up to 20 errors (`{ row, field, message }`, `row` = CSV record line or GeoJSON
feature index, 1-based) and nothing written.

**Format detection:** extension `.csv` / `.geojson` / `.json`, and the first
non-BOM, non-space byte (`{` → GeoJSON). A mismatch → `IMPORT_UNSUPPORTED_FILE`.

**CSV:** strip a UTF-8 BOM; accept CRLF or LF; RFC 4180 quoting with embedded
commas, quotes and newlines. The header must equal `COVERAGE_EXPORT_COLUMNS`
labels in order (the exporter's documented positional contract), else
`IMPORT_SCHEMA_MISMATCH` naming the first differing column. Empty cell = null.
Text cells: a leading `'` before a formula trigger (`= + - @ \t \r`) is
removed (inverse of `guardFormulaInjection`). Key fields are regex-checked, and
none of their formats can start with a trigger, so the reversal only touches the
ignored name fields.

**GeoJSON:** `type: 'FeatureCollection'`; a `meshmonitor` object member must
exist (our marker; else `IMPORT_NOT_MESHMONITOR`). `LineString` features with
`properties.kind === 'likely_gap'` are skipped (`skipped.gapFeatures`). Every
other feature must be a `Point` whose properties hold every
`COVERAGE_EXPORT_COLUMNS` key (unknown extra keys ignored, so a later exporter
can add keys); `geometry.coordinates[0..1]` must equal `longitude`/`latitude`
(within 1e-9). `meshmonitor.truncated === true` → accepted, reported as
`sourceTruncated` so the UI can say "the exporter loaded only part of its range".
WP0 adds `format: 'meshmonitor-coverage-report'` and `version: 1` to the
exporter's `meshmonitor` member; the importer accepts files without them (all
exports so far) and rejects a different `format` or a `version` above 1.

**Row rules:**

| Field | Rule |
|---|---|
| `protocol` | `meshtastic` or `meshcore` |
| `receiverKind` | `local` or `mqtt_gateway` |
| `senderId`, `receiverId` | Meshtastic `^![0-9a-f]{8}$` (case-insensitive, stored lowercase); MeshCore 64 hex |
| `packetKey` | Meshtastic decimal `0..4294967295`; MeshCore `^[0-9A-Fa-f]{16}$`, stored uppercase |
| `pathKey` | Meshtastic `^r(\d{1,3}\|-):h(\d{1,2}\|-)$`; MeshCore `parseMeshCorePathKey` non-null |
| `latitude` / `longitude` | finite, `[-90, 90]` / `[-180, 180]`; then the recorder's own position guard: WP1 checks which test the coverage recorders apply (`isBogusPosition` in `src/utils/nullIsland.ts` or none) and uses the same one, so the importer rejects nothing the recorder would store |
| `receiverLatitude` / `receiverLongitude` | both empty or both valid as above |
| `altitude` | empty or finite, `|x| ≤ 100 000` |
| `precisionBits` | empty or integer 0..32 |
| `snr` | empty or finite `[-50, 50]` |
| `rssi` | empty or integer `[-200, 20]` (0 is a real value since fw 2.8) |
| `hopsAway` | empty or integer 0..63 |
| `hopStart`, `hopLimit` | empty or integer 0..7 |
| `relayNode` | empty or integer 0..255 |
| `channel` | empty or integer ≥ 0, ≤ 2³¹−1 |
| `receivedAtMs` | integer, `≥ 2020-01-01` and `≤ now + 5 min` |
| `receivedAt` | ISO; `Date.parse(receivedAt) === receivedAtMs` |
| others | ignored (`senderName`, `sourceId`, `sourceName`, `receiverName`, `distanceKm`) |

**Not "monotonic".** The issue asks for monotonic timestamps. The exporter
writes rows in load order (newest first, page by page), and a spreadsheet user
may re-sort before saving, so order proves nothing. We check each timestamp's
range and the ISO/ms agreement instead.

### 2.7 Dedupe and batches

- **File level:** SHA-256 of the raw bytes. Unique `(sourceId, fileSha256)`. A
  repeat → 409 `IMPORT_DUPLICATE_FILE` with the existing import's id and name.
  This also makes a browser's re-sent POST (#5494 shape) harmless.
- **Row level:** the existing unique key. Overlapping files insert only new rows.
- **Write order:** insert the batch row (`status: 'importing'`) first, so a
  concurrent duplicate POST hits the unique index; insert rows in chunks of 500;
  update counts and `status: 'complete'`. On error, delete the batch's rows then
  the batch row (best effort; no cross-backend transaction). A crash mid-import
  leaves an `importing` batch, listed as "Incomplete" with a Delete button; no
  boot sweep.
- **Delete:** `DELETE` removes the batch's rows (`sourceId` + `importId`) then
  the batch. Rows that the import skipped as duplicates were never its rows, so
  live data is untouched.

### 2.8 Retention, backup, purge, source delete

- Retention: imported rows are kept until their import is deleted (same rule as
  walkabout sessions).
- Backup: `coverage_imports` (full table) + imported rows (via the filtered
  exporter, without `id`). Restore keeps working as today.
- Purge nodes: keeps imported rows and batches (Q6).
- Source delete: removes the source's imported rows and batches. **Trap:** the
  source DELETE handler (`sourceRoutes.ts:1874`) calls `purgeAllNodesAsync(id)`,
  the same function that will now keep imported rows. So
  `coverageImports.deleteForSource` deletes the source's `importId IS NOT NULL`
  reception rows itself, then the batches; the handler calls it after the purge.
  Otherwise a deleted source leaves imported rows behind forever (no source, no
  retention).

### 2.9 Upload

- `POST /api/sources/:id/coverage/imports`, body = raw bytes,
  `Content-Type: application/octet-stream` (required; anything else → 415
  `IMPORT_BAD_CONTENT_TYPE`, so the JSON parser never sees it),
  `X-Filename: encodeURIComponent(file.name)`.
- `express.raw({ type: 'application/octet-stream', limit: COVERAGE_IMPORT_MAX_BYTES })`
  on the route; a 413 from the parser is converted to `fail(413, 'IMPORT_TOO_LARGE')`
  by a route-level error handler.
- Filename: `decodeURIComponent` (failure → 400), basename only, control chars
  stripped, trimmed, ≤ 200 chars, must end `.csv`/`.geojson`/`.json`.
- Parsing in memory on the server (no streaming): the byte cap bounds memory
  (~4× the file size transient), and the geojson upload route does the same.
- `extendRequestTimeout(120_000)`.

### 2.10 UI

- **Coverage Report toolbar:** an `Import` button next to the export buttons,
  shown when the user holds `nodes:write` on at least one coverage-capable
  source. It opens `CoverageImportDialog`: file picker (`.csv,.geojson,.json`),
  target source (`SearchableSelect`, writable sources only, protocol shown),
  Import. The result shows inserted / duplicate / skipped counts and the
  `sourceTruncated` note; errors show as a list (first 20).
- **Imported filter:** a three-way chip "Imported: Show / Hide / Only" (default
  Q4). It sends `imported=include|exclude|only` to `/receptions`, `/senders` and
  `/receivers`.
- **Imports panel** (collapsible, below the survey bar, signed-in only): per
  readable source in the report's source set, newest first: filename, source,
  imported at, date span, inserted/duplicate counts, status. Actions: **Show**
  (sets a custom window `[firstReceivedAt, lastReceivedAt]` and `importId=<id>`,
  like a survey selection; changing the window by hand clears it) and **Delete**
  (confirm `Modal`, write grant only).
- **Map:** a fix whose receptions are all imported draws with a dashed outline
  (`dashArray: '3,3'`, colours from existing tokens); a mixed fix stays solid.
  The popup tags each imported reception "Imported". Legend row: "Dashed = imported".
  Grid view: no distinction (cells mix data).
- **Receiver filter:** a receiver seen only in imports gets an "imported" tag.
- **Anonymous viewers:** see imported rows per §2.5 and the filter chip, but no
  Import button and no imports panel (the list route needs a login).

---

## 3. File-by-file

### 3.1 Migration 249 — `src/server/migrations/249_create_coverage_imports.ts` (+ `.test.ts`, `.pgmysql.test.ts`)

Next free number on `origin/main` is **249** (248 is walkabout). Recheck
`origin/main` and open PRs (#6451 adds none today) before committing. Use the
`migration` skill. `settingsKey: 'migration_249_create_coverage_imports'`.

**`coverage_imports`** (PER-SOURCE):

| Column | SQLite | PG | MySQL | Notes |
|---|---|---|---|---|
| `id` | TEXT PK | TEXT PK | VARCHAR(36) PK | `crypto.randomUUID()` |
| `sourceId` | TEXT NN | TEXT NN | VARCHAR(64) NN | target source |
| `kind` | TEXT NN | TEXT NN | VARCHAR(24) NN | `'coverage_report'` (P3b: `'walkabout'`) |
| `format` | TEXT NN | TEXT NN | VARCHAR(8) NN | `'csv'` / `'geojson'` |
| `filename` | TEXT NN | TEXT NN | VARCHAR(200) NN | sanitised |
| `fileSha256` | TEXT NN | TEXT NN | VARCHAR(64) NN | lowercase hex |
| `status` | TEXT NN | TEXT NN | VARCHAR(12) NN | `'importing'` / `'complete'` |
| `importedBy` | INTEGER | INTEGER | INT | users.id, never sent to the client |
| `importedAt` | INTEGER NN | BIGINT NN | BIGINT NN | unix ms |
| `rowCount` | INTEGER NN | INTEGER NN | INT NN | data rows in the file |
| `insertedCount` | INTEGER NN | INTEGER NN | INT NN | |
| `duplicateCount` | INTEGER NN | INTEGER NN | INT NN | |
| `skippedCount` | INTEGER NN | INTEGER NN | INT NN | protocol mismatch + gap features |
| `firstReceivedAt` | INTEGER | BIGINT | BIGINT | min `receivedAt` of inserted rows |
| `lastReceivedAt` | INTEGER | BIGINT | BIGINT | max |
| `sourceTruncated` | INTEGER NN DEFAULT 0 | BOOLEAN NN DEFAULT false | TINYINT(1) NN DEFAULT 0 | |

Indexes: UNIQUE `cov_imp_source_sha_uniq (sourceId, fileSha256)`,
`cov_imp_source_imported_idx (sourceId, importedAt)`. MySQL inline in the
`createTableIfMissingMysql` DDL.

**`coverage_receptions.importId`**: SQLite `addColumnIfMissing(db, 'coverage_receptions', 'importId', 'importId TEXT')`;
PG `addColumnIfMissingPostgres(client, 'coverage_receptions', 'importId', '"importId" TEXT')`;
MySQL `addColumnIfMissingMysql(pool, 'coverage_receptions', 'importId', '`importId` VARCHAR(36) NULL')`
(full column DDL, per the helpers' contract). Nullable, no default: instant on
SQLite, PG and MySQL 8.

Index `cov_rx_import_idx` (one table scan to build; tiny where partial):
- SQLite: `CREATE INDEX IF NOT EXISTS cov_rx_import_idx ON coverage_receptions(importId) WHERE importId IS NOT NULL`
- PG: `CREATE INDEX IF NOT EXISTS cov_rx_import_idx ON coverage_receptions("importId") WHERE "importId" IS NOT NULL`
- MySQL: plain index via `createIndexIfMissingMysql` (no partial indexes; one scan at boot on a large MQTT table, accepted).

Register in `src/db/migrations.ts` after 248.

### 3.2 Schema

- **`src/db/schema/coverageImports.ts`** (new): `coverageImportsSqlite/Postgres/Mysql` per §3.1. Header comment lists the DDL-only indexes (project convention).
- **`src/db/schema/coverageReceptions.ts`**: add `importId` on all three (`text` / `pgText` / `myVarchar(36)`), with a comment: null = recorded live; set = imported, exempt from retention.
- **`src/db/schema/index.ts`**, **`src/db/activeSchema.ts`**: export + register `coverageImports`.

### 3.3 Table lists

- `src/server/services/systemBackupTables.ts` `BACKUP_TABLES`: `coverage_imports` **before** `coverage_receptions` (comment: user data; its rows ride the filtered exporter).
- `src/cli/migrationTables.ts`: `TABLE_ORDER` add `coverage_imports` next to the coverage tables; `SOURCE_SCOPED_TABLES` add it.
- Test DDL that must gain `importId`: the hand-written `coverage_receptions` DDL in `systemBackupService.test.ts` / `systemRestoreService.test.ts` (implementer greps), and `coverageReceptions.test.ts` + `coverageReceptions.multiBackend.test.ts` must run migration 249 after 172 (they build the table from 172 only; Drizzle selects every schema column, so PG/MySQL suites fail without it).

### 3.4 Types and constants (WP0)

**`src/types/coverageImport.ts`** (new):
```ts
export type CoverageImportKind = 'coverage_report';
export type CoverageImportFormat = 'csv' | 'geojson';
export type CoverageImportedMode = 'include' | 'exclude' | 'only';

export interface CoverageImportDto {
  id: string;
  sourceId: string;
  kind: CoverageImportKind;
  format: CoverageImportFormat;
  filename: string;
  status: 'importing' | 'complete';
  importedAt: number;
  importedByMe: boolean;           // never the user id
  rowCount: number;
  insertedCount: number;
  duplicateCount: number;
  skippedCount: number;
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  sourceTruncated: boolean;
}

export interface CoverageImportResult {
  import: CoverageImportDto;
  skipped: { protocolMismatch: number; gapFeatures: number };
}

export interface CoverageImportRowError { row: number; field: string | null; message: string }

/** One validated row, ready for the repository (sourceId/importId added by the service). */
export interface ParsedCoverageImportRow {
  protocol: 'meshtastic' | 'meshcore';
  receiverKind: 'local' | 'mqtt_gateway';
  receiverId: string; receiverNodeNum: number | null;
  receiverLatitude: number | null; receiverLongitude: number | null;
  senderId: string; senderNodeNum: number | null;
  packetKey: string; packetId: number | null; pathKey: string;
  latitude: number; longitude: number; altitude: number | null; precisionBits: number | null;
  snr: number | null; rssi: number | null;
  hopStart: number | null; hopLimit: number | null; hopsAway: number | null;
  relayNode: number | null; channel: number | null;
  receivedAt: number;
}

export type ParseCoverageImportResult =
  | { ok: true; format: CoverageImportFormat; rows: ParsedCoverageImportRow[]; gapFeatures: number; sourceTruncated: boolean }
  | { ok: false; code: 'IMPORT_UNSUPPORTED_FILE' | 'IMPORT_NOT_MESHMONITOR' | 'IMPORT_SCHEMA_MISMATCH'
      | 'IMPORT_INVALID_ROWS' | 'IMPORT_TOO_MANY_ROWS' | 'IMPORT_EMPTY'; message: string; errors: CoverageImportRowError[] };
```

**`src/types/coverage.ts`**: `CoverageReceptionDto.importId?: string | null`;
`CoverageReceiverDto.importedOnly?: boolean`; `CoverageSenderDto.importedOnly?: boolean`.
Optional, so existing test fixtures compile unchanged; absent reads as "live".
The server always sets them.

**`src/utils/coverageImport.ts`** (frontend-safe, `.js` relative imports), WP0 adds constants only:
```ts
export const COVERAGE_IMPORT_MAX_BYTES = 32 * 1024 * 1024;   // Q5
export const COVERAGE_IMPORT_MAX_ROWS = 10_000;              // Q5 (= export cap and client display cap)
export const COVERAGE_IMPORT_MAX_PER_SOURCE = 50;            // Q5, batches
export const COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE = 200_000;  // Q5, inserted rows across batches
export const COVERAGE_IMPORT_FILENAME_MAX = 200;
export const COVERAGE_IMPORT_MAX_ERRORS = 20;
export const COVERAGE_IMPORT_INSERT_CHUNK = 500;
export const COVERAGE_IMPORT_LIST_LIMIT = 200;
export const COVERAGE_IMPORT_EARLIEST_MS = Date.UTC(2020, 0, 1);
export const COVERAGE_IMPORT_FUTURE_SKEW_MS = 5 * 60_000;
export const COVERAGE_IMPORT_WRITE_GRANT = { resource: 'nodes', action: 'write' } as const;  // Q3
export const COVERAGE_IMPORT_READ_GRANT = { resource: 'nodes', action: 'read' } as const;
export const COVERAGE_EXPORT_FORMAT = 'meshmonitor-coverage-report';
export const COVERAGE_EXPORT_VERSION = 1;
```

**`src/utils/coverageExport.ts`** (WP0): rename `CSV_COLUMNS` → exported
`COVERAGE_EXPORT_COLUMNS` (`readonly`); add `format`/`version` to the GeoJSON
`meshmonitor` member. Existing `coverageExport.test.ts` must stay green (update
the one meta assertion).

### 3.5 Pure parser — `src/utils/csvParse.ts` + `src/utils/coverageImport.ts` (WP1)

```ts
// csvParse.ts — RFC 4180 reader. BOM-tolerant, CRLF/LF, quoted fields with
// embedded commas/quotes/newlines. Returns records with their starting line.
export function parseCsv(text: string): { records: string[][]; lines: number[] };

// coverageImport.ts
export function detectCoverageImportFormat(filename: string, text: string): CoverageImportFormat | null;
export function unguardFormulaInjection(value: string): string;   // inverse of guardFormulaInjection
export function validateCoverageImportRow(raw: Record<string, unknown>, nowMs: number):
  { row: ParsedCoverageImportRow } | { errors: Array<Omit<CoverageImportRowError, 'row'>> };
export function parseCoverageImport(filename: string, text: string, nowMs?: number): ParseCoverageImportResult;
export function coverageImportProtocolFor(sourceType: string): 'meshtastic' | 'meshcore' | null; // null = reticulum/unsupported
export function sanitizeImportFilename(raw: string): string | null;
```
- CSV cells arrive as strings; numbers parse with `Number()` on non-empty cells and must be finite (and integer where the table says so). GeoJSON values must already be the right JSON type (`null` allowed where the table allows empty).
- Stops collecting after `COVERAGE_IMPORT_MAX_ERRORS` but keeps the count; rows over `COVERAGE_IMPORT_MAX_ROWS` → `IMPORT_TOO_MANY_ROWS` before validating rows.
- Zero data rows → `IMPORT_EMPTY`.
- No DB, no `src/server` imports, so the dialog could pre-check on the client later (not in P3).

### 3.6 Repositories (WP2)

**`src/db/repositories/coverageImports.ts`** (new; every method takes `sourceId` and uses `withSourceScope`):
```ts
createImport(p: { id; sourceId; kind; format; filename; fileSha256; importedBy: number | null; importedAt; rowCount }): Promise<DbCoverageImport>
  // throws a typed CoverageImportDuplicateError on the (sourceId, fileSha256) unique violation (map per backend)
findByHash(sourceId, fileSha256): Promise<DbCoverageImport | null>
getImport(sourceId, id): Promise<DbCoverageImport | null>
listImports(sourceId, limit = COVERAGE_IMPORT_LIST_LIMIT): Promise<DbCoverageImport[]>   // importedAt DESC
countImports(sourceId): Promise<number>
completeImport(sourceId, id, p: { insertedCount; duplicateCount; skippedCount; firstReceivedAt; lastReceivedAt; sourceTruncated }): Promise<void>
deleteImport(sourceId, id): Promise<boolean>        // rows first (via coverageReceptions.deleteImportRows), then the batch
deleteForSource(sourceId): Promise<void>            // source delete: the source's importId IS NOT NULL reception rows, then every batch (§2.8 trap)
```
Coerce bigint columns with `Number()`; booleans per backend.

**`src/db/repositories/coverageReceptions.ts`** changes:
- `DbCoverageReception.importId: string | null`; `mapReception` maps it.
- `insertImportedRows(sourceId, importId, rows: ParsedCoverageImportRow[]): Promise<number>` → inserted count. Chunks of `COVERAGE_IMPORT_INSERT_CHUNK`. SQLite/PG `db.insert(t).values(chunk).onConflictDoNothing()`; MySQL `db.insert(t).ignore().values(chunk)` (`ignore()` comes before `values()` in drizzle 0.45); count via `getAffectedRows`.
- `deleteImportRows(sourceId, importId): Promise<number>`.
- `GetCoverageReceptionsArgs` / `GetCoverageReceiversArgs` / `GetCoverageSenderSummaryArgs` gain `imported?: CoverageImportedMode` (default `'include'`) and `importId?: string` (implies only that batch). `exclude` → `isNull(importId)`; `only` → `isNotNull(importId)`.
- `getReceivers` and `getSenderSummary` select `importedRows: SUM(CASE WHEN importId IS NULL THEN 0 ELSE 1 END)` and `liveRows` likewise (Drizzle `sql`, portable) so the route can gate and set `importedOnly`.
- `purgeOlderThan`: add `isNull(coverageReceptions.importId)`.
- `exportSurveyReceptions(windows)`: add `isNull(importId)`, so an imported row inside a survey window is not exported twice (the paged reader below exports it).
- `exportImportedReceptionsPage(afterId: number, limit: number): Promise<{ rows: Omit<DbCoverageReception,'id'>[]; lastId: number | null }>`: `importId IS NOT NULL AND id > afterId ORDER BY id LIMIT n`, all sources (backup is cross-source by design).
- `countImportedRows(sourceId): Promise<number>` for the per-source row cap.
- `deleteForSource(sourceId, opts?: { keepImported?: boolean })`, `deleteAll(opts?)`: `keepImported` adds `isNull(importId)`.

**`src/services/database.ts`**: `coverageImportsRepo` + getter `coverageImports`, init beside `coverageReceptionsRepo`. In `purgeAllNodesAsync` (line ~4114) pass `{ keepImported: true }` (Q6).

**`src/server/services/systemBackupService.ts`**: `exportTable` today awaits the
filtered exporter's whole array, then batches it. Imported rows (up to
`COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE` per source) must not sit in memory at once
on a Pi. Change the `FILTERED_EXPORTERS` value type to
`() => AsyncIterable<BackupRow[]>`; the `coverage_receptions` entry yields the
survey rows (as today, already bounded by the survey caps) and then imported
rows paged by keyset on `id` (`exportImportedReceptionsPage(afterId, BACKUP_BATCH_ROWS)`,
ids stripped after paging). So `exportSurveyReceptions` stays survey-only, and
the repository gains `exportImportedReceptionsPage`. Test: two pages, no row twice,
no `id` in output.

### 3.7 Server visibility helper (WP3) — `src/server/utils/coverageImportVisibility.ts` (new)

```ts
/** Wraps the two position filters with the §2.5 rule for imported rows. */
export function buildCoverageRowGate(args: {
  user: unknown;
  posFilter: (r: { sourceId: string; nodeNum: number }) => boolean;
  mcFilter: ((r: { sourceId: string; publicKey: string }) => boolean) | null;
  nodesBySource: Map<string, DbNode[]>;
  mcNodesBySource: Map<string, DbMeshCoreNode[]>;
  grants: SourcePermissions;
}): {
  senderVisible(row: { sourceId; protocol; senderId; senderNodeNum; importId }): boolean;
  receiverVisible(row: { sourceId; protocol; receiverId; receiverNodeNum; importId }): boolean;
};
```
Live rows (`importId == null`): exactly today's expressions (including the
Meshtastic `senderNodeNum == null` carve-out). Imported rows: resolved → same
filter; unresolved → `user.isAdmin || grants.can(baseMapGrant(sourceId), 'viewOnMap', sourceId)`
where `baseMapGrant` is `'nodes'` for a MeshCore source and `'channel_0'` for a
Meshtastic one (§2.5, Q2). The source type comes from the protocol of the row
(`isMeshCoreReceptionRow`), so no source lookup is needed.

**Grouped rows** (`/senders`, `/receivers` aggregates, which carry
`importedRows` and `liveRows` instead of one `importId`): resolved node → the
normal filter, whatever the mix. Unresolved node → visible only when
`importedRows > 0` and the imported rule passes (a live orphan's share is
dropped again per row by `/receptions`; the group's counts may include it,
accepted). `importedOnly = liveRows === 0`.
`/receptions`, `/senders`, `/receivers` switch to it. For `/receptions`, load
MeshCore nodes for MeshCore rows as today; imported Meshtastic rows need no new
load (`loadNodesBySource` already covers every permitted source).

### 3.8 Routes (WP3)

**`src/server/routes/coverageImportRoutes.ts`** (new), mounted in
`apiRouter.ts` next to walkabout: `apiRouter.use('/sources/:id/coverage/imports', coverageImportRoutes)`
(`Router({ mergeParams: true })`). All use `ok()` / `fail()`.

| Method + path | Gate | Behaviour |
|---|---|---|
| `GET /` | `requireAuth()` + `nodes:read` (`sourceIdFrom: 'params.id', requireSourceId: true`) | `ok(res, { imports: CoverageImportDto[] })`, newest first. |
| `POST /` | `requireAuth()` + `nodes:write` (same opts) + `extendRequestTimeout(120_000)` + content-type check + `express.raw` | §3.9. 201 `ok(res, CoverageImportResult)`. |
| `DELETE /:importId` | `requireAuth()` + `nodes:write` | Unknown or other-source id → 404 `IMPORT_NOT_FOUND`. `ok(res)`. Logs user, source, import id. |

Codes: `IMPORT_BAD_CONTENT_TYPE` 415, `IMPORT_TOO_LARGE` 413, `IMPORT_BAD_FILENAME` 400,
`IMPORT_UNSUPPORTED_FILE` 400, `IMPORT_NOT_MESHMONITOR` 400, `IMPORT_SCHEMA_MISMATCH` 400,
`IMPORT_INVALID_ROWS` 400 (+ `errors`, `errorCount`), `IMPORT_TOO_MANY_ROWS` 400,
`IMPORT_EMPTY` 400, `IMPORT_NO_MATCHING_ROWS` 400, `IMPORT_SOURCE_UNSUPPORTED` 400,
`SOURCE_NOT_FOUND` 404, `IMPORT_DUPLICATE_FILE` 409 (+ `importId`, `filename`),
`IMPORT_LIMIT_REACHED` 409, `IMPORT_NOT_FOUND` 404.

**`src/server/routes/coverageRoutes.ts`**: parse `imported` (`include|exclude|only`,
else 400 `INVALID_IMPORTED`) and `importId` (UUID regex, else 400 `INVALID_IMPORT_ID`)
on `/receptions`, `/senders`, `/receivers`; pass to the repository; swap the
inline gates for `buildCoverageRowGate`; set `importedOnly` (`liveRows === 0`);
imported rows get `senderIsOwnSource: false` and are dropped by `crossSourceOnly`.

**`src/server/routes/sourceRoutes.ts`** (delete handler, next to the walkabout
block ~1933, after `purgeAllNodesAsync`): `await databaseService.coverageImports.deleteForSource(id)`
(best effort, logged). It must remove the imported rows itself: the purge above
now keeps them (§2.8 trap). Test: delete a source with an import, assert zero
rows with that `sourceId` remain in both tables.

### 3.9 Import service — `src/server/services/coverageImportService.ts` (new, WP3)

```ts
export class CoverageImportError extends Error { constructor(public code: string, message: string, public status: number, public extra?: Record<string, unknown>) }
export async function importCoverageFile(p: {
  sourceId: string; userId: number | null; filename: string; body: Buffer; nowMs?: number;
}): Promise<CoverageImportResult>;
export function toCoverageImportDto(row: DbCoverageImport, userId: number | null): CoverageImportDto;
```
Order: source exists (`databaseService.sources.getSource`) → protocol via
`coverageImportProtocolFor` → `countImports < COVERAGE_IMPORT_MAX_PER_SOURCE` (409 `IMPORT_LIMIT_REACHED`) →
SHA-256 → `findByHash` (409) → decode UTF-8 (`TextDecoder('utf-8', { fatal: true })`,
failure → `IMPORT_UNSUPPORTED_FILE`) → `parseCoverageImport` → split by protocol
→ none left → `IMPORT_NO_MATCHING_ROWS` → `countImportedRows + rows ≤ COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE` (409 `IMPORT_LIMIT_REACHED`) → `createImport` (duplicate error → 409)
→ `insertImportedRows` → `completeImport` → DTO. Any error after `createImport`:
`deleteImport` then rethrow. No `dataEventEmitter`, no timers.

### 3.10 Frontend (WP4)

- **`src/services/coverageImportApi.ts`** (new): `fetchCoverageImports(sourceId)`, `deleteCoverageImport(sourceId, id)` via `ApiService` (read `body.data`); `uploadCoverageImport(csrfFetch, sourceId, file)` with `application/octet-stream` + `X-Filename: encodeURIComponent(file.name)`, parsing the envelope (`error`, `code`, `errors`).
- **`src/hooks/useCoverageImports.ts`** (new): `useCoverageImports(sourceIds)` (`useQueries`, key `['analysis','coverageReport','imports', sourceId]`), `useImportCoverageFile()` (uses `useCsrfFetch`), `useDeleteCoverageImport()`; on success invalidate the imports key and the whole `['analysis','coverageReport']` prefix (receptions/senders/receivers).
- **`src/hooks/useCoverageData.ts`** + `src/services/analysisApi.ts`: pass `imported` and `importId` through; add them to the query keys.
- **Receivers window (needed for old imports).** Today `CoverageReport.tsx:215` calls `useCoverageReceivers([])` with no window, so `/receivers` covers only the retention window. An import from last year then has no receivers in the list: no names, no markers, and a partial receiver selection (include-list encoding) silently drops its rows. Change `useCoverageReceivers(sources, opts?: { sinceMs?: number })` and `fetchCoverageReceivers` to send `since` when given; `CoverageReport` passes `sinceMs` only when the report window starts before the retention start (`now − retentionDays`, from the last receivers response), and `imported`. Keep the key stable: `sinceMs` is already in state (P1 refetch-loop lesson), never recomputed from `Date.now()` in render; extend `CoverageReport.queryStability.test.tsx`. The same fix covers surveys older than retention (a pre-existing gap).
- **`CoverageImportButton.tsx` + `CoverageImportDialog.tsx`** (+ `CoverageImport.module.css`, tests): §2.10. Writable sources = readable coverage sources filtered by `hasPermission('nodes','write',{sourceId})` and `coverageImportProtocolFor(type) != null`.
- **`CoverageImportsPanel.tsx`** (+ test): §2.10; Delete uses `Modal`.
- **`CoverageReport.tsx`**: state `imported` (default per Q4) and `selectedImportId`; place the button after `CoverageExportButtons`; the chip in the filter row (hidden in walkabout view); the panel under `CoverageSurveyBar`. Selecting an import clears a selected survey and vice versa.
- **`CoverageMap.tsx`**: dashed outline when every reception of a fix has `importId`; popup "Imported" tag; legend row.
- **`CoverageReceiverFilter.tsx`**: "imported" tag from `importedOnly`.
- **i18n:** every new key in `public/locales/en.json` (inline defaults are not enough, #5826 guard).
- **CSS:** module files only, `var(--color-*)` tokens, no hardcoded colours; run the semantic-token test.

### 3.11 Docs (orchestrator, after merge)

- `docs/features/coverage-report.md`: "Importing coverage data" section (what files, target source, dedupe, imported styling and filter, delete, limits, visibility of unresolved nodes).
- Epic doc phase log; CLAUDE.md needs no new global exception (`coverage_imports` is per-source).

---

## 4. Mesh impact checklist

1. **Airtime:** none. Import writes database rows; it sends no packet, on any source.
2. **Spam:** none. No `dataEventEmitter` events, no notifications, no automation
   triggers; imported rows never pass the RX path, so `cross_source_links`,
   heard-by and walkabout capture never see them. The only user-visible effect is
   rows on the Coverage Report.
3. **Timers:** none added. Retention gains an exclusion, not a timer; a settings
   save changes nothing here.

Server-side load: one import parses at most 32 MB and inserts at most 10 000 rows
in 20 chunks, behind `nodes:write` and the per-source caps (50 imports, 200 000 rows).

---

## 5. Test plan

Standard Vitest; PG and MySQL containers up for WP2/WP3 (they skip silently
otherwise; confirm with `numPendingTests`). Use `flock` and small runs per the
machine-wide test rule; CI runs the full suite.

**WP1 (pure):**
- `csvParse.test.ts`: BOM, CRLF/LF mix, quoted comma/quote/newline, empty trailing line, ragged row (error with line number).
- `coverageImport.test.ts`: every row rule (one failing case each, with field name); header mismatch names the column; `meshmonitor` marker missing; gap features skipped; Point/property coordinate mismatch; `truncated` surfaced; unknown `format`/`version` rejected, missing accepted; `unguardFormulaInjection` inverts `guardFormulaInjection` for each trigger; error cap at 20 with true count; `IMPORT_TOO_MANY_ROWS`; `IMPORT_EMPTY`; `sanitizeImportFilename` (path parts, control chars, length, extension).
- **Drift test:** importer's required keys deep-equal `COVERAGE_EXPORT_COLUMNS` keys and labels.
- **Unit round trip:** build DTOs (both protocols, every nullable field null in some row, negative SNR, rssi 0, names starting `=`/`-`/`@` and holding `,` `"` and newlines) → `buildCoverageCsv` and `buildCoverageGeoJson` (with gaps) → `parseCoverageImport` → each parsed row equals the DTO projected onto exported fields (node nums re-derived, `packetId` from `packetKey`).

**WP2 (repository, all three backends):**
- `249_create_coverage_imports.test.ts` / `.pgmysql.test.ts`: tables, column, indexes; run twice (idempotent).
- `coverageImports.multiBackend.test.ts` (isolated DBs, `isolationKey: 'covimp'`): CRUD, list order, unique hash → typed duplicate error, `deleteImport` removes only its rows, `deleteForSource`.
- `coverageReceptions.multiBackend.test.ts` (now runs 172 + 249): `insertImportedRows` with a duplicate in the middle of a chunk inserts the rest and returns the right count (the MySQL trap); `imported` modes and `importId` on all three reads; `importedRows`/`liveRows`; `purgeOlderThan` keeps imported rows; `exportSurveyReceptions` skips imported rows; `exportImportedReceptionsPage` pages all sources' imported rows by id without `id` in output; `deleteForSource(…, { keepImported: true })`.
- `coverageImports.perSource.test.ts`: every method on source A never touches source B rows.
- Backup: `systemBackupService.tables.test.ts` passes with `coverage_imports` classified; manifest test includes it; `migrationTables.test.ts` passes.

**WP3 (routes, `createRouteTestApp` harness, real SQLite):**
- `coverageImportRoutes.test.ts`: 401 anonymous; 403 `nodes:read`-only on POST/DELETE; write grant on source B cannot import into A (403) or delete A's import via `/sources/B/...` (404); bad content type 415; body over 100 KB succeeds (proves the raw parser, not the harness JSON limit); over `COVERAGE_IMPORT_MAX_BYTES` → 413 envelope (set a small limit via a test seam rather than sending 32 MB); duplicate file 409; per-source batch cap and row cap 409; reticulum target 400; protocol-mismatch rows skipped; all-invalid file writes nothing (no batch row left).
- `coverageImportRoutes.perSource.test.ts`: import on A; `/receptions` with a reader of B only shows nothing; the list on B does not show A's import.
- `coverageRoutes.imported.test.ts` (visibility): imported row whose sender is a `hideFromMap` node on the target → dropped for admin and user; unresolved sender → shown to admin and to a user with the base map grant on the source (`channel_0:viewOnMap` for a Meshtastic source, `nodes:viewOnMap` for a MeshCore one; test both, and that `nodes:viewOnMap` alone does NOT open a Meshtastic source), hidden from a reader without it and from anonymous without it; live orphan row still dropped; `crossSourceOnly` excludes imported rows; receiver coordinates nulled by the same rule; `/senders` and `/receivers` set `importedOnly`.
- **Exit round trip (end-to-end):** seed live receptions on harness source A (nodes present) → GET `/receptions` as admin → build CSV and GeoJSON with the real builders → fresh harness DB → POST each file into a source with **no nodes** → GET `/receptions` as a user with `nodes:read` + the base map grant (one Meshtastic and one MeshCore target source) → `groupReceptionsIntoFixes` on both lists → same fix keys, lat/lon, receivers per fix, best SNR (tolerance 1e-3 for PG `real`). Ignore `id`, `rxTime`, `transportMechanism` (not exported). Re-POST the CSV → 409; POST the GeoJSON after the CSV → `insertedCount 0`, `duplicateCount N`.
- Source delete removes imports + rows; purge nodes keeps them (`purgeRoutes.coverageCascade.test.ts` extended).
- Sentinel audit (`publicInstance.sentinelAudit.test.ts`) passes with `importId` / `importedOnly` added.

**WP4 (jsdom):**
- Dialog: lists writable sources only; shows error list from a 400; shows counts and the truncated note on success; disabled while uploading.
- Panel: Show sets the window and `importId`; Delete confirms; read-only users see no Delete.
- Report: chip changes the query key; anonymous sees no Import button or panel.
- Map: all-imported fix gets a dashed outline; mixed fix does not.
- Browser check in the dev container (real mouse): export, delete rows, import, compare the map; screenshot for the PR.

---

## 6. Work packages (Sonnet implementers)

### WP0 — skeleton (orchestrator commits before forking)

Owns: `src/types/coverageImport.ts`; DTO fields in `src/types/coverage.ts`;
constants in `src/utils/coverageImport.ts` (functions as `throw new Error('WP1')`
stubs with final signatures); `COVERAGE_EXPORT_COLUMNS` export + `format`/`version`
in `coverageExport.ts` (+ its test); `src/db/schema/coverageImports.ts`,
`importId` in `coverageReceptions.ts`, `index.ts`, `activeSchema.ts`; migration 249
(+ tests) and registry; `BACKUP_TABLES`, `TABLE_ORDER`, `SOURCE_SCOPED_TABLES`;
the 172→249 change in the two reception test files and the hand DDL in the
backup/restore tests; `coverageImports.ts` repository class with signature
stubs. Every later WP builds against the final schema.

### WP1 — parser and validator (pure)

`src/utils/csvParse.ts`, `src/utils/coverageImport.ts` bodies, their tests,
drift test, unit round trip. No DB. Parallel with WP2 and WP4.

### WP2 — repositories, backup, purge

`coverageImports.ts` bodies, `coverageReceptions.ts` changes, `database.ts`
wiring and purge option, `systemBackupService.ts` exporter, repository tests on
all three backends. Parallel with WP1 and WP4.

### WP3 — service, routes, visibility (after WP1 + WP2 merge)

`coverageImportService.ts`, `coverageImportRoutes.ts` + `apiRouter.ts` mount,
`coverageImportVisibility.ts`, `coverageRoutes.ts` changes, `sourceRoutes.ts`
delete cascade, every harness test incl. the end-to-end round trip.

### WP4 — UI (types only from WP0; merges last)

API client, hooks, dialog, panel, chip, map styling, receiver tag, `en.json`
keys, CSS modules, jsdom tests. Mock the API in tests; re-run after WP3 merges,
then the browser check.

**Order:** WP0 → (WP1 ∥ WP2 ∥ WP4) → WP3 → re-run WP4 → orchestrator docs,
`lint:ci` (filter `.claude/worktrees`), PG/MySQL containers up for the final run.

| File | WP0 | WP1 | WP2 | WP3 | WP4 |
|---|---|---|---|---|---|
| `src/types/coverageImport.ts`, `src/types/coverage.ts` | owns | import | import | import | import |
| `src/utils/coverageImport.ts` | constants + stubs | **bodies** | import | import | import |
| `src/utils/coverageExport.ts` | owns | import | — | test import | — |
| schema, migration 249, table lists | owns | — | import | — | — |
| `src/db/repositories/coverageImports.ts` | stubs | — | **bodies** | import | — |
| `src/db/repositories/coverageReceptions.ts`, `database.ts`, `systemBackupService.ts` | — | — | owns | import | — |
| server routes/services/utils | — | — | — | owns | — |
| `src/components/Analysis/*Import*`, hooks, services, `CoverageReport.tsx`, `CoverageMap.tsx`, `CoverageReceiverFilter.tsx`, `en.json` | — | — | — | — | owns |

---

## 7. Open questions (maintainer policy calls)

**Q1. Scope: walkabout sessions too?**
- (a) **Recommended:** P3 imports Coverage Report files only. Walkabout export +
  import becomes P3b (new export route with hidden-node rules, then import into a
  new session tagged with the same `coverage_imports` batch, `kind: 'walkabout'`).
- (b) Do both in P3 (adds ~2 work packages and a privacy design for raw
  walkabout points).

**Q2. Who sees imported rows whose node is not on the target source?**
- (a) **Recommended:** admins and users with the source's base map grant:
  `channel_0:viewOnMap` on a Meshtastic source, `nodes:viewOnMap` on a MeshCore
  source (`nodes:viewOnMap` cannot be granted on a Meshtastic source in the UI).
- (b) Admins only (others see only resolved nodes).
- (c) Nobody until the node appears on the source (the round-trip exit on a clean
  DB then fails).
Resolved nodes always get today's gates.

**Q3. Who may import and delete an import?**
- (a) **Recommended:** `nodes:write` on the target source, any such user may
  delete any import there (matches walkabout).
- (b) `nodes:write` to import; only the importer or an admin deletes.
- (c) Admin only.

**Q4. Are imported rows shown by default?**
- (a) **Recommended:** shown, dashed outline, chip to Hide or Only.
- (b) Hidden until the viewer picks Show.

**Q5. Limits.**
- (a) **Recommended:** 32 MB per file (a 10k-row GeoJSON is ~11-13 MB);
  10 000 rows per file (the export cap, and the most the report shows at once:
  `COVERAGE_MAX_PAGES` × 1000); 50 imports and 200 000 imported rows per
  source (bounds DB growth and backup size; backup pages them anyway).
- (b) Bigger: 20 000 rows per file for hand-merged files (one import then
  cannot be shown in full), 100 imports, 500 000 rows per source.
- (c) No per-source caps (DB grows without bound at a writer's hand).

**Q6. Does "Purge nodes" delete imported rows?**
- (a) **Recommended:** no; imports are user data kept until deleted (like
  walkabout sessions). Source delete still removes them.
- (b) Yes, as for live receptions and survey rows (P4b U6).

**Q7. Importing into the instance that made the export.**
Rows that are still live there dedupe against the live copy and still age out.
- (a) **Recommended:** accept; the dialog says "rows already recorded here were
  skipped; save a survey to keep live data".
- (b) Make imported copies separate (unique-key change on a large table, and the
  map shows each fix twice). Not recommended.

### Resolutions (maintainer + orchestrator, 2026-11-25) — binding

- **Q1:** import Coverage Report CSV/GeoJSON only; walkabout export + import is a follow-up (https://github.com/Yeraze/meshmonitor/issues/6573) (maintainer).
- **Q2:** points from nodes unknown on the target source are visible to admins and users with the source's base map permission (`channel_0:viewOnMap` on Meshtastic, `nodes:viewOnMap` on MeshCore); known nodes keep today's per-node rules (maintainer).
- **Q3:** `nodes:write` on the target source to import; any such user may delete any import there (maintainer).
- **Q4:** imported rows shown by default, dashed, with the Show/Hide/Only chip.
- **Q5:** 32 MB and 10k rows per file; 50 imports and 200k imported rows per source (maintainer).
- **Q6:** purge nodes keeps imported rows; source delete removes them (via `coverageImports.deleteForSource`).
- **Q7:** accepted — importing into the exporting instance skips rows it still holds live; the dialog says to save a survey to keep live data.
