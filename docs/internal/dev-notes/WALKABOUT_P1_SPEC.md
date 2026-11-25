# Walkabout Coverage Epic (#5891): Phase 1 Implementation Spec

Phase 1 = capture + storage. Plan and binding decisions:
`WALKABOUT_COVERAGE_EPIC.md`. Read that first, then this.

**One premise in the brief is false.** No per-source write grant gates saving
Coverage surveys: `coverageSurveyRoutes.ts` uses `requireAuth()` plus sender
visibility (P4b decision U2). See §1.6 and open question Q1. This spec puts
the walkabout grant behind one constant so the call can change in one line.

Sections: 1 reuse inventory · 2 file-by-file (incl. §2.10 freshness) ·
3 mesh impact · 4 tests · 5 work packages · 6 open questions.

---

## 1. Reuse inventory (read first)

### 1.1 Capture guards, hop maths, sender extraction

| Reuse | Where | Why |
|---|---|---|
| `evaluateMeshtasticDirectRf` guard order | `src/server/services/directRfContactRecorder.ts:115` | Template for the Meshtastic evaluator: local node known, not replayed, not own, `viaMqtt` checked on its own, RF transport, `isLiveReception` (120 s on `rx_time`), `isNodeDbReplayForPacketLog`. **Use these guards, not coverage's 600 s `isStaleCoverageRxTime`**: a fw 2.8 NodeDB replay on reconnect would otherwise be pinned to the phone's current spot. |
| `computeMeshtasticHopsAway` | `src/utils/coverage.ts:130` | Direct vs relayed by the bitfield rule (zero-hop arrives 0/0 with relay_node 0; tell from pre-2.3 fw by `decoded.bitfield` presence). |
| `computeMeshCoreHopsAway` | `src/utils/coverage.ts:301` | Flood: hop count. Direct-route with empty path: 0. Direct-route with a path: `null` → skip. |
| `isRfTransport`, `isNodeDbReplayForPacketLog` | `src/server/services/packetLogDedup.ts` | As above. |
| `resolveRadioPacketTransport`, `isViaMqtt` | `src/server/constants/meshtastic.ts` | As above. |
| `isLiveReception` | `src/server/utils/replayGuard.ts` | As above. |
| `decodeMeshCorePacket` | `src/utils/meshcorePacketDecode.ts:291` | Route type, path hops (oldest first), advert. |
| **`meshcoreSenderOf(rawHex)`** | `src/server/services/packetFlights.ts:116` | **The** MeshCore sender extraction: advert key, ANON_REQ full sender key (`dest(1) | key(32)`), 1-byte src hash for REQ/RESPONSE/TXT_MSG/PATH, null for GRP_TXT/GRP_DATA/ACK/TRACE/etc. Same rules as `deriveMeshCorePacketFields` (`src/utils/meshcorePacketDerived.ts`). Do not write a third copy. |
| `buildMeshCoreFlight` last-hop rule | `src/server/services/packetFlights.ts:148` | "Only a flood path lists the hops already taken": last hop = `path_hops[last]` only when `hopsUsed > 0`. Copy this rule. |
| `calculateMeshCorePacketHash` | `src/server/services/meshcoreObserverPacket.ts` | MeshCore `packetKey`. |
| `Ed25519SignatureVerifier.verifyAdvertisementSignature` | `@michaelhart/meshcore-decoder` (as `directRfContactRecorder.ts:241`) | A direct advert credits its key only once the signature verifies. |
| `nodeNumToId`, `isMeshCorePubKeyId`, `MESHCORE_PAYLOAD_ADVERT` | `src/utils/coverage.ts` | Canonical ids. |

### 1.2 Last-hop resolution

| Reuse | Where | Change |
|---|---|---|
| `resolveLastHopName` + `CLIENT_MUTE_ROLE` | `src/server/utils/lastHop.ts` | **Extend this file** with a pure `resolveUniqueRelayNode` (§2.6). It already matches the low byte and drops CLIENT_MUTE, but guesses on a tie, which we must not; so a sibling, not a flag. |
| `resolvePathHash(hashHex, knownKeys)` | `src/server/services/meshcoreTraceIngestService.ts:40` | Exactly "one match or nothing" for a MeshCore hash of any width. Import as-is. |
| `crossSourceCorrelation.classifyMeshCoreReception` | `src/server/services/crossSourceCorrelation.ts:327` | **Not reused**: it resolves hashes against *our own sources' radios* only. Cited so nobody reaches for it. |
| `loadNodesBySource` / `loadMeshCoreNodesBySource` | `src/server/utils/positionVisibility.ts:53,177` | Candidate lists (`nodes.getAllNodes(sourceId)`, `meshcore.getNodesBySource(sourceId)`). |

### 1.3 Ingest hook sites

| Site | Where | Why here |
|---|---|---|
| Meshtastic | `meshtasticManager.processMeshPacket`, right after `maybeRecordMeshtasticDirectRf(...)` (~line 7566) | Every packet the TCP radio hears, encrypted or not, outside the `packet_log_enabled` gate. Same spot and `replayed` flag as the cross-source and direct-RF recorders. |
| MeshCore | **top of `meshcoreManager.handleOtaPacket`** (~line 3554), beside `emitPacketFlight`, before the `meshcorePacketLogService.isEnabled()` gate | Both the companion `ota_packet` branch and the repeater `RAW:` path (`handleRepeaterRawPacket`, ~line 5111) call it. The `ota_packet` branch alone misses repeaters. |
| MQTT ingest | `mqttIngestion.ts`, `meshcoreMqttManager.ts` | **Not hooked.** See §1.5. |

### 1.4 Storage, backup, lifecycle precedents

| Reuse | Where | Use |
|---|---|---|
| `coverage_receptions` schema | `src/db/schema/coverageReceptions.ts` | Column style: camelCase on all backends, `real`/`pgDouble`/`myDouble` lat/lon, `pgBigint(..., { mode: 'number' })` ms times, MySQL `sourceId varchar(64)`. |
| `CoverageReceptionsRepository.recordReception` | `src/db/repositories/coverageReceptions.ts:270-298` | `insertIgnore(...)` then `return this.getAffectedRows(result) > 0`: the existing per-backend "was a row written" check (MySQL `insertIgnore` returns null on a duplicate). Copy it. |
| `coverage_surveys` | `src/db/schema/coverageSurveys.ts`, `src/db/repositories/coverageSurveys.ts`, migration 173 | UUID text PK for sessions; repo shape; `effectiveSurveyEndAt` (cap at read time, no timer); `coverageSurveys.multiBackend.test.ts`; `coverageSurveys.perSource.test.ts`. |
| `autoAnnounceService` persisted `lastAnnouncementTime` | `src/server/services/autoAnnounceService.ts` | **Considered, not copied.** It persists a last-fire time because it must *fire* on a schedule. Walkabout never fires; it only needs "is this session still open", which `startedAt + cap` answers at read time. The survey pattern (`effectiveSurveyEndAt`) is the closer fit and needs no timer to re-arm. |
| `withSourceScope`, `insertIgnore`, `getAffectedRows` | `src/db/repositories/base.ts` | Every repo method scopes by `sourceId`. |
| DatabaseService getter | `src/services/database.ts:681,847,1340` (`coverageSurveysRepo` / `get coverageSurveys`) | Same wiring. **Note:** CLAUDE.md says "`*Async` on DatabaseService"; every coverage repo since P1 is reached through a getter (`databaseService.coverageSurveys.x()`), all methods async. Follow the getter precedent. |
| `BACKUP_TABLES` | `src/server/services/systemBackupTables.ts:76-81` | Three tables after `coverage_receptions`, parents first. |
| `migrationTables.ts` | `src/cli/migrationTables.ts:83,204,234` | Copy list + `SOURCE_SCOPED_TABLES` (the `migrationTables.test` guard fails otherwise). |
| Source delete cleanup | `src/server/routes/sourceRoutes.ts:1903-1970` | Best-effort `deleteForSource` step, like `secretPurges`. **Not** `purgeAllNodesAsync` (`database.ts:4003`): that also backs "purge nodes" on a live source, and walkabout data is kept until deleted (Q4). |
| Startup wiring | `src/server/server.ts:566` (`coverageRetentionService.start()` after `waitForReady`) | Run `walkaboutService.init()` the same way. |

### 1.5 Sources that may run walkabout

Server check: `isMeshtasticManager(m) || isMeshCoreManager(m)` on
`sourceManagerRegistry.getManager(sourceId)` (`src/server/sourceManagerTypes.ts:52,107`).
Never a `source.type` string gate.

- **In:** `meshtastic_tcp`; `meshcore` (companion; repeater only when its build streams `RAW:` lines, else it captures nothing and the zero count shows it).
- **Out: every MQTT-fed source** (`mqtt_*`, `meshcore_mqtt*`). No local radio: each packet is a stranger's gateway hearing at a place we do not know, so tagging it with the phone's spot would be false. Same rule as Direct RF Contacts (`directRfContactRecorder.ts:13`).
- Also skipped on radio sources: any packet with `viaMqtt` / MQTT transport (its SNR is not our radio's), as Coverage does.

### 1.6 Permissions

| Reuse | Where |
|---|---|
| `requireAuth`, `requirePermission(resource, action, { sourceIdFrom: 'params.id', requireSourceId: true })` | `src/server/auth/authMiddleware.ts:410-455` |
| Per-source mount `/sources/:id/...` with `Router({ mergeParams: true })` | `src/server/routes/apiRouter.ts:194` (`mqttPacketRoutes`) |
| Frontend grant check + source list | `src/hooks/usePinSources.ts` (`useDashboardSources` + `useAuth().hasPermission(r, a, { sourceId })`) |

Surveys have no per-source write grant to copy. The per-source write grants
near Coverage are `settings:write` (gates `coverage_mqtt_enabled`,
`settingsRoutes.ts:394`) and `nodes:write` (node edits, position overrides).
**Default: write = `nodes:write`, read = `nodes:read`**, per source, behind
`requireAuth()`. `nodes:read` is what Coverage already uses for every read
(`resolvePermittedSourceIds(req, 'nodes')`). One constant (§2.1); Q1 flips one line.

### 1.7 Frontend

| Reuse | Where |
|---|---|
| Report card registry + deep link | `src/components/Analysis/AnalysisTab.tsx:38,102,248` |
| `Modal`, `SearchableSelect`, `UiIcon` | as imported in `CoverageSurveyBar.tsx:23-25` |
| TanStack hook pattern | `src/hooks/useCoverageSurveys.ts` |
| Fetchers through `ApiService`, read `body.data` | `src/services/analysisApi.ts` |
| Source picker shape | `src/components/map/PinSourcePicker.tsx` (copy the select; its copy talks about pins) |

**Placement decision:** a new **Reports → Walkabout** card (`report=walkabout`),
not a panel inside `CoverageReport`. On a phone the Coverage report loads the
receptions query, a Leaflet map and charts; a walker needs a light page that
stays open for two hours on battery and cellular data, and makes few requests
(§2.8 rate limit). P2 adds the hex map here and the "Walkabout sessions"
filter to Coverage.

### 1.8 Public instance

| Reuse | Where |
|---|---|
| `PUBLIC_INSTANCE_FIELD_CATALOGUE` | `src/server/utils/publicInstanceRedactor.ts:63` |
| Sentinel audit, `PARAM_DEFAULTS`, `ID_PREFIX_RULES` | `src/server/routes/publicInstance.sentinelAudit.test.ts:308`, `src/server/test-helpers/publicInstanceAudit.ts:773,795` |

**Decision:** every walkabout route has `requireAuth()`; anonymous viewers get
401, which the audit counts as "denied" (allowed). A walkabout is a person's
GPS trail, so it is never public. Field names still match the catalogue
(`latitude`, `longitude`, `*At`) as defence in depth. The audit walks every
GET and fails on an unresolved param; `:id` resolves via the `/api/sources/:id`
rule, but **`:sessionId` needs a `PARAM_DEFAULTS` entry**.

### 1.9 New subsystem justification

`walkaboutService` (§2.5) is new. Closest existing: `directRfContactRecorder`
(per-packet pure evaluator + hook) and `coverageSurveys` (live window, cap at
read time). Neither holds a live per-source GPS fix, so a small service owns
that map. It copies their shapes: pure `evaluate*` functions that return a
skip reason, `maybe*` wrappers that never throw, no `dataEventEmitter`.

---

## 2. File-by-file changes

### 2.1 WP0 (orchestrator commits first): constants, types, schema, skeletons

**`src/utils/walkabout.ts`** (new; frontend-safe, no `src/server` imports)

```ts
export const WALKABOUT_MAX_DURATION_MS = 2 * 3_600_000;   // hard cap
export const WALKABOUT_MAX_ACCURACY_M = 100;              // drop above
export const WALKABOUT_WARN_ACCURACY_M = 30;              // warn above
export const WALKABOUT_MIN_SAMPLE_SPACING_MS = 5_000;     // exact, on device fix timestamps, both sides
export const WALKABOUT_SAMPLE_FRESH_MS = 25_000;          // §2.10
export const WALKABOUT_MAX_SAMPLE_AGE_MS = 30_000;        // a fix older than this on arrival is dropped
export const WALKABOUT_POST_INTERVAL_MS = 10_000;         // client post cadence (§2.8)
export const WALKABOUT_MAX_SAMPLES_PER_POST = 4;          // 2 normal + catch-up after a failed post
export const WALKABOUT_HEARTBEAT_MS = 5_000;              // client forces a fix after this much silence
export const WALKABOUT_CLOCK_RESET_MS = 60_000;           // device timestamp this far backwards = phone clock reset
export const WALKABOUT_NAME_MAX = 120;
export const WALKABOUT_LIST_LIMIT = 200;
/** Per-source grants (Q1). Routes and UI both read these. */
export const WALKABOUT_WRITE_GRANT = { resource: 'nodes', action: 'write' } as const;
export const WALKABOUT_READ_GRANT = { resource: 'nodes', action: 'read' } as const;
export type WalkaboutEndReason = 'user' | 'cap';
/** startedAt + cap while open; else endedAt. */
export function walkaboutEndsAt(s: { startedAt: number; endedAt: number | null }): number;
export function isWalkaboutLive(s: { startedAt: number; endedAt: number | null }, nowMs: number): boolean;
```

**`src/types/walkabout.ts`** (new)

```ts
export interface WalkaboutSessionDto {
  id: string; sourceId: string; name: string | null;
  startedAt: number; endedAt: number | null; endsAt: number; isLive: boolean;
  endReason: WalkaboutEndReason | null;
  startedByMe: boolean;                   // never the user id
  sampleCount: number; receptionCount: number; nodeCount: number;  // nodeCount = distinct credited
  lastSampleAt: number | null;
}
export interface WalkaboutSampleInput {
  latitude: number; longitude: number; accuracyM: number;
  deviceFixAt: number;   // GeolocationPosition.timestamp (phone clock); used only for spacing
  ageMs: number;         // phone now − deviceFixAt at send time; skew-free
}
export interface WalkaboutSkipCounts { noFix: number; relayAmbiguous: number; relayUnknown: number; noSender: number; }
export interface WalkaboutSampleResult {
  accepted: number;
  dropped: { accuracy: number; spacing: number; stale: number; invalid: number };
  session: WalkaboutSessionDto;           // counts read from the DB (§2.5)
  skipped: WalkaboutSkipCounts;           // memory only, since this server start
}
```

**`src/db/schema/coverageWalkabout.ts`** (new) + export from `src/db/schema/index.ts` + `activeSchema.ts`. See §2.2.

**Skeletons** (so parallel WPs and jsdom mocks resolve; bodies throw `not implemented`):
`src/db/repositories/coverageWalkabout.ts` (class + §2.3 signatures, wired into
`DatabaseService` as `coverageWalkaboutRepo` / `get coverageWalkabout`),
`src/server/services/walkaboutService.ts` (singleton, §2.5 signatures),
`src/server/utils/walkaboutCredit.ts` (§2.6 signatures),
`src/services/walkaboutApi.ts` (§2.9 fetchers).

### 2.2 Schema (all three backends), migration 248

Next free number is **248** (registry ends at 247; no open PR adds 248 as of
2026-11-25). Re-check `origin/main` right before committing.

File `src/server/migrations/248_create_coverage_walkabout.ts`,
`settingsKey: 'migration_248_create_coverage_walkabout'`. SQLite/PG:
`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`; MySQL:
`createTableIfMissingMysql` with inline `INDEX` / `UNIQUE KEY`. Use the
`migration` skill. No FKs (as `coverage_receptions`); the repository deletes
children in order.

**`coverage_walkabout_sessions`**

| Column | SQLite | PG | MySQL | Notes |
|---|---|---|---|---|
| `id` | text PK | text PK | varchar(36) PK | `crypto.randomUUID()` (P4b PG-sequence lesson; opaque id). |
| `sourceId` | text NN | text NN | varchar(64) NN | |
| `name` | text | text | varchar(120) | Trimmed, ≤ 120; null = UI shows the date. |
| `startedAt` | integer NN | bigint NN | bigint NN | ms. The cap runs from this. |
| `endedAt` | integer | bigint | bigint | null = open. |
| `endReason` | text | text | varchar(16) | `'user'` \| `'cap'`. |
| `startedBy` | integer | integer | int | `users.id`; never sent to the client. |
| `createdAt`, `updatedAt` | integer NN | bigint NN | bigint NN | ms. |

Indexes: `cov_wk_sess_source_started_idx (sourceId, startedAt)`, `cov_wk_sess_ended_idx (endedAt)`.

**`coverage_walkabout_samples`**

| Column | SQLite | PG | MySQL | Notes |
|---|---|---|---|---|
| `id` | integer PK autoinc | serial PK | int autoinc PK | |
| `sessionId` | text NN | text NN | varchar(36) NN | |
| `sourceId` | text NN | text NN | varchar(64) NN | |
| `latitude`, `longitude` | real NN | double NN | double NN | |
| `accuracyM` | real NN | real NN | double NN | ≤ 100 by rule. |
| `deviceFixAt` | integer NN | bigint NN | bigint NN | Phone clock. Spacing only; survives restart. |
| `fixAt` | integer NN | bigint NN | bigint NN | Server clock: `receivedAt − ageMs`. Freshness only. |
| `receivedAt` | integer NN | bigint NN | bigint NN | Server ms. |

Indexes: `cov_wk_smp_session_fix_idx (sessionId, fixAt)`, `cov_wk_smp_source_idx (sourceId)`.

**`coverage_walkabout_receptions`**

| Column | SQLite | PG | MySQL | Notes |
|---|---|---|---|---|
| `id` | integer PK autoinc | serial PK | int autoinc PK | |
| `sessionId` | text NN | text NN | varchar(36) NN | |
| `sourceId` | text NN | text NN | varchar(64) NN | |
| `protocol` | text NN | text NN | varchar(16) NN | `'meshtastic'` \| `'meshcore'`. |
| `creditedKey` | text NN | text NN | varchar(80) NN | `!xxxxxxxx` or lowercased 64-hex key. |
| `creditedNodeNum` | integer | **bigint** | **bigint** | Meshtastic only; unsigned 32-bit. `Number()` on read. |
| `creditKind` | text NN | text NN | varchar(8) NN | `'direct'` \| `'relay'`. |
| `hopsAway` | integer | integer | int | |
| `packetKey` | text NN | text NN | varchar(80) NN | Meshtastic `${fromHex}:${packetId}`; MeshCore packet hash. |
| `snr` | real | real | double | −128 sentinel → null. |
| `rssi` | integer | integer | int | Explicit 0 kept. |
| `heardAt` | integer NN | bigint NN | bigint NN | Server ms. |
| `sampleId` | integer | integer | int | The sample used. |
| `latitude`, `longitude` | real NN | double NN | double NN | Copied from the sample: P2 aggregates one table. |
| `accuracyM` | real NN | real NN | double NN | Copied. |
| `sampleAgeMs` | integer NN | integer NN | int NN | `heardAt − sample.fixAt`; lets P2 tighten freshness for drives without new capture. |

Indexes: `UNIQUE cov_wk_rx_uniq (sessionId, packetKey, creditedKey)` (drops a
firmware double delivery; a copy via a different relayer is its own row),
`cov_wk_rx_session_heard_idx (sessionId, heardAt)`, `cov_wk_rx_source_idx (sourceId)`.

Registration:
- `src/db/migrations.ts`: `registry.register({ number: 248, ... })`.
- `systemBackupTables.ts` `BACKUP_TABLES`, after `'coverage_receptions'`:
  `'coverage_walkabout_sessions'`, `'coverage_walkabout_samples'`,
  `'coverage_walkabout_receptions'`. User data, kept until deleted, not
  secret; full-table dump. PG sequences are reset on restore since #5355, so
  serial ids are safe.
- `src/cli/migrationTables.ts`: all three after `coverage_receptions` in the
  copy list, and in `SOURCE_SCOPED_TABLES`.

### 2.3 Repository `src/db/repositories/coverageWalkabout.ts` — WP1

Every method takes `sourceId` and scopes with `withSourceScope`, except the
boot loader (cross-source by design; say so in its JSDoc).

```ts
createSession(p: { id: string; sourceId: string; name: string | null; startedAt: number; startedBy: number | null }): Promise<DbWalkaboutSession>
getSession(sourceId: string, id: string): Promise<DbWalkaboutSession | null>
getOpenSession(sourceId: string): Promise<DbWalkaboutSession | null>        // endedAt IS NULL, newest
listSessions(sourceId: string, limit = WALKABOUT_LIST_LIMIT): Promise<DbWalkaboutSessionWithCounts[]> // newest first
getOpenSessionsAllSources(): Promise<DbWalkaboutSession[]>                  // boot only
endSession(sourceId: string, id: string, endedAt: number, reason: WalkaboutEndReason): Promise<boolean> // WHERE endedAt IS NULL
deleteSession(sourceId: string, id: string): Promise<boolean>              // receptions, samples, then session
deleteForSource(sourceId: string): Promise<void>
insertSample(row: NewWalkaboutSample): Promise<DbWalkaboutSample>          // with id (PG returning / MySQL insertId / SQLite lastInsertRowid)
getLatestSample(sourceId: string, sessionId: string): Promise<DbWalkaboutSample | null> // by deviceFixAt
recordReception(row: NewWalkaboutReception): Promise<boolean>             // insertIgnore + getAffectedRows > 0
getCounts(sourceId: string, sessionId: string): Promise<{ samples: number; receptions: number; nodes: number; lastSampleAt: number | null }>
```

`listSessions` counts with grouped `COUNT` subqueries keyed by `sessionId` (no
counter columns to drift). Bigint columns: `Number()` on read.

### 2.4 Source delete — WP1

`sourceRoutes.ts` `DELETE /:id`, after the settings purge: best-effort
`try { await databaseService.coverageWalkabout.deleteForSource(id); walkaboutService.forgetSource(id); } catch (e) { logger.warn(...) }`.
**Not** in `purgeAllNodesAsync` (Q4).

### 2.5 `src/server/services/walkaboutService.ts` — WP2

Owns the live map and the session lifecycle. Routes stay thin.

```ts
interface LiveSession {
  id: string; sourceId: string; startedAt: number; startedBy: number | null;
  latest: { id: number; latitude: number; longitude: number; accuracyM: number; fixAt: number } | null;
  lastDeviceFixAt: number | null;
  skipped: WalkaboutSkipCounts;          // memory only
}
class WalkaboutService {
  private live = new Map<string, LiveSession>();   // key: sourceId (one open session per source)
  private ready: Promise<void>;                    // resolved by init(), success or failure
  init(nowMs = Date.now()): Promise<void>;
  startSession(sourceId: string, userId: number | null, name: string | null, nowMs?: number): Promise<DbWalkaboutSession>;
  stopSession(sourceId: string, sessionId: string, nowMs?: number): Promise<DbWalkaboutSession | null>;
  addSamples(sourceId: string, sessionId: string, userId: number | null, samples: WalkaboutSampleInput[], nowMs?: number): Promise<WalkaboutSampleResult>;
  deleteSession(sourceId: string, sessionId: string): Promise<boolean>;
  forgetSource(sourceId: string): void;
  getSkipped(sourceId: string, sessionId: string): WalkaboutSkipCounts | null;
  maybeCaptureMeshtastic(input: WalkaboutMeshtasticInput): void;   // sync; never throws; never awaited on the RX path
  maybeCaptureMeshCore(input: WalkaboutMeshCoreInput): void;
}
export class WalkaboutError extends Error {
  code: 'WALKABOUT_ALREADY_LIVE' | 'WALKABOUT_NOT_LIVE' | 'WALKABOUT_NOT_OWNER' | 'WALKABOUT_SOURCE_UNSUPPORTED' | 'WALKABOUT_NOT_FOUND';
  extra?: Record<string, unknown>;
}
export const walkaboutService = new WalkaboutService();
```

**Lifecycle rules**

- **Ready gate.** Every lifecycle method (`start/stop/addSamples/delete`)
  first `await this.ready`. `init()` resolves `ready` even when it fails
  (logged), so routes never hang. Capture before `ready` is a no-op: the map
  is empty, and a fix is needed anyway.
- **`init()`** (from `server.ts` after `waitForReady`): for each
  `getOpenSessionsAllSources()` row, if `now ≥ startedAt + cap` end it with
  `endedAt = startedAt + cap`, `endReason 'cap'`; else load it into the map
  with `latest` and `lastDeviceFixAt` from `getLatestSample` (so spacing
  survives a restart; `latest` is usually stale, which is harmless). A restart
  never starts, extends or re-arms anything: the cap still runs from the
  stored `startedAt`. Calling `init()` twice changes nothing more.
- **One open session per source** (not per user per source). The radio is
  one receiver; two phones on one source would each claim every packet, and
  the spot would depend on whose post landed last. `startSession`:
  1. capability check: `getManager(sourceId)` passes `isMeshtasticManager || isMeshCoreManager`, else `WALKABOUT_SOURCE_UNSUPPORTED` (connection not required);
  2. **cap check first**: a map entry or `getOpenSession(sourceId)` row past its cap is ended (`'cap'`) on the spot, so an expired session nobody noticed never blocks a new start;
  3. **claim synchronously** (set a placeholder in the map before the next `await`; memory: claim, never check-then-stamp), then confirm `getOpenSession(sourceId)` is null (covers a failed `init()`), else release and throw `WALKABOUT_ALREADY_LIVE` with `{ sessionId }`;
  4. insert; on failure release the claim.
- **Cap with no timer.** `isWalkaboutLive(s, now)` = `endedAt == null && now < startedAt + cap`.
  Every entry point (capture, `startSession`, `addSamples`, `stopSession`,
  reads) checks it. The first caller to see an open session past its cap
  ends it at `startedAt + cap` (fire-and-forget on the capture path) and
  drops it from the map.
- **`addSamples`**: only the user who started it (`WALKABOUT_NOT_OWNER`);
  admins may stop or delete, not post. Process samples in `deviceFixAt`
  order. Per sample: finite lat in [−90, 90], lon in [−180, 180], not (0, 0),
  `accuracyM` finite ≥ 0, `deviceFixAt` and `ageMs` finite (else `invalid`);
  `accuracyM > 100` → `accuracy`; `ageMs > 30 s` → `stale` (negative clamps
  to 0); **spacing on the device clock, exactly 5 s**:
  `d = deviceFixAt − lastDeviceFixAt`; `0 ≤ d < 5 000` → `spacing`;
  `−60 s < d < 0` → `spacing` (out of order); `d ≤ −60 s` → accept and rebase
  (the phone's clock was reset). Accepted: `fixAt = now − ageMs`, insert, make
  it `latest` if its `fixAt` is newer. The response reads counts with
  `getCounts` (DB truth, not in-memory tallies).
- **`deleteSession`**: live or ended; drop the map entry first so capture
  stops before rows go.

**Capture (both protocols).** `maybeCapture*` first does
`this.live.get(sourceId)`: an idle source pays one Map lookup per packet. Then:
past cap → end, stop; no `latest` or `now − latest.fixAt > WALKABOUT_SAMPLE_FRESH_MS`
→ `skipped.noFix++`, stop. Else run the pure evaluator (§2.6) with candidates
from a per-source cache (60 s TTL, filled lazily by the first packet that
needs it, never on a timer); verify an advert signature if asked; then
`recordReception` (fire-and-forget; `catch` → `logger.debug`).

### 2.6 Pure credit rules `src/server/utils/walkaboutCredit.ts` — WP2

```ts
export type WalkaboutSkip =
  | 'no-local-node' | 'replayed' | 'own-packet' | 'via-mqtt' | 'not-rf' | 'no-packet-id'
  | 'not-live' | 'nodedb-replay' | 'unknown-hops' | 'relay-none' | 'relay-unknown' | 'relay-ambiguous'
  | 'decode-failed' | 'no-sender' | 'direct-route-ambiguous' | 'own-advert';
export interface WalkaboutCredit { protocol: 'meshtastic' | 'meshcore'; creditedKey: string; creditedNodeNum: number | null; creditKind: 'direct' | 'relay'; hopsAway: number; packetKey: string; snr: number | null; rssi: number | null; }
export function evaluateWalkaboutMeshtastic(input: { localNodeNum: number | null; packet: MeshtasticDirectRfPacket & { relayNode?: number | null }; replayed: boolean; nowMs: number; candidates: LastHopCandidate[] }): { skip: WalkaboutSkip } | { skip: null; credit: WalkaboutCredit };
export function evaluateWalkaboutMeshCore(input: { localPubKey: string | null; event: { raw_hex?: string | null; snr?: number | null; rssi?: number | null }; knownKeys: string[] }): { skip: WalkaboutSkip } | { skip: null; credit: WalkaboutCredit; verifyAdvert?: DecodedAdvert };
```

Add to `src/server/utils/lastHop.ts`:

```ts
/** The one node whose low byte is `relayByte`, or null for 0 or ≥ 2 matches. Never guesses. */
export function resolveUniqueRelayNode(relayByte: number, candidates: LastHopCandidate[], exclude: number[]): { nodeNum: number | null; matches: number };
```
Filter: role ≠ CLIENT_MUTE; `nodeNum` not in `exclude` (the local node, and
the packet's `from`: a relayed copy's relayer is never its sender).

**Meshtastic, in order** (1–7 copy `evaluateMeshtasticDirectRf`):
1. local node unknown → `no-local-node`; 2. replayed (S&F / VN) → `replayed`;
3. `from` 0 or ours → `own-packet`; 4. `viaMqtt` or MQTT transport → `via-mqtt`;
5. not RF → `not-rf`; 6. no packet id → `no-packet-id`;
7. `!isLiveReception` → `not-live`; NodeDB replay → `nodedb-replay`;
8. `hopsAway = computeMeshtasticHopsAway(...)`; `null` → `unknown-hops` (pre-2.3 fw, no hop_start);
9. `hopsAway === 0` → credit `from`, `direct`;
10. `hopsAway > 0`: `relayNode` null or 0 → `relay-none` (fw stamped no relayer);
    `resolveUniqueRelayNode` 0 matches → `relay-unknown`, ≥ 2 → `relay-ambiguous`, 1 → credit it, `relay`.

Candidates (Q3): **all nodes on the source** (`nodes.getAllNodes(sourceId)`),
filtered only as above: the plain reading of "exactly one known node".

**MeshCore, in order.** Decode `raw_hex` (`decodeMeshCorePacket`); failure →
`decode-failed`. `hopsAway = computeMeshCoreHopsAway(routeType, hopCount)`;
`null` → `unknown-hops`. `sender = meshcoreSenderOf(raw_hex)` (§1.1).
`knownKeys` = every `meshcore_nodes` key on the source, minus our own.

Who transmitted the copy we heard depends on the route:

- **Flood / transport-flood**: each repeater appends its hash, so the path
  lists hops already taken. Empty path = the sender transmitted it; else the
  last path entry did.
- **Direct / transport-direct**: each repeater removes its own hash from the
  front before forwarding (firmware `Mesh::onRecvPacket`; WP2 confirms in the
  firmware source and notes the line). A non-empty path = in transit
  (`hopsAway null`, already skipped). An **empty path** = arrived, sent by
  either the origin or the last repeater, which the frame cannot tell apart.

| Case | Rule |
|---|---|
| Any route, ADVERT 0x04, `hopsAway 0` | Adverts are never direct-routed through repeaters (a zero-hop advert is sent direct with an empty path), so the sender transmitted it. Own key → `own-advert`. Else credit the key after `verifyAdvertisementSignature` passes (the service runs it; fail → not written). |
| Flood, empty path, non-advert | `sender` from `meshcoreSenderOf`: null → `no-sender` (GRP_TXT, GRP_DATA, ACK, TRACE, MULTIPART, CONTROL, RAW_CUSTOM). A 64-hex key (ANON_REQ) → credit only if it is in `knownKeys` exactly (the key is not signed), else `relay-unknown`. A 2-hex hash (REQ, RESPONSE, TXT_MSG, PATH) → `resolvePathHash(hash, knownKeys)`: 1 → credit, 0 → `relay-unknown`, ≥ 2 → `relay-ambiguous`. A sender equal to (or a prefix of) our own key → `own-packet`. |
| Direct, empty path, non-advert | `direct-route-ambiguous`. |
| Flood, `hopsAway > 0` | last path entry (1–3 bytes) → `resolvePathHash(lastHop, knownKeys)`: 1 → credit, `relay`; 0 → `relay-unknown`; ≥ 2 → `relay-ambiguous`. |

Candidate narrowing (repeaters and room servers only for the relay case) is Q3.

`packetKey` = `calculateMeshCorePacketHash(raw_hex)`. Our own TX: a companion
never relays, and repeater `RAW:` lines are receptions.

### 2.7 Manager hooks and startup — WP2

- `meshtasticManager.ts`, after `maybeRecordMeshtasticDirectRf(...)`:
  ```ts
  // Walkabout (#5891 P1): tag this hearing with the phone's latest fix. Receive-only.
  walkaboutService.maybeCaptureMeshtastic({ sourceId: this.sourceId, localNodeNum: this.localNodeInfo?.nodeNum ?? null, packet: meshPacket, replayed: context?.viaStoreForward === true || context?.virtualNodeRequestId != null });
  ```
- `meshcoreManager.ts`, first statement of `handleOtaPacket`:
  ```ts
  walkaboutService.maybeCaptureMeshCore({ sourceId: this.sourceId, localPubKey: this.localNode?.publicKey ?? null, event: data ?? {} });
  ```
- `server.ts`: `void (async () => { try { await databaseService.waitForReady(); await walkaboutService.init(); } catch (e) { logger.error(...) } })();` near the coverage retention start.

### 2.8 Routes `src/server/routes/walkaboutRoutes.ts` — WP3

`Router({ mergeParams: true })`, mounted in `apiRouter.ts` as
`apiRouter.use('/sources/:id/walkabout', walkaboutRoutes)`. Every route:
`requireAuth()` then
`requirePermission(G.resource, G.action, { sourceIdFrom: 'params.id', requireSourceId: true })`
with `G` from §2.1. Every session lookup is by `(params.id, sessionId)`, so a
session on another source is a 404. All responses use `ok()` / `fail()`.
CSRF is global; tests send the token.

| Method + path | Grant | Body → result | Errors |
|---|---|---|---|
| `GET /sessions` | read | `{ sessions: WalkaboutSessionDto[] }`, newest first, ≤ 200 | |
| `GET /sessions/live` (declare before `/:sessionId`) | read | `{ session: WalkaboutSessionDto \| null, skipped: WalkaboutSkipCounts \| null }` | |
| `GET /sessions/:sessionId` | read | `{ session, skipped }` (`skipped` only while live) | 404 `WALKABOUT_NOT_FOUND` |
| `POST /sessions` | write | `{ name? }` → `{ session }` | 400 `INVALID_WALKABOUT` (name > 120), 400 `WALKABOUT_SOURCE_UNSUPPORTED`, 409 `WALKABOUT_ALREADY_LIVE` + `{ sessionId }` |
| `POST /sessions/:sessionId/samples` | write + starter | `{ samples: WalkaboutSampleInput[] }` (1–4) → `WalkaboutSampleResult` | 400 `INVALID_WALKABOUT`, 403 `WALKABOUT_NOT_OWNER`, 404, 409 `WALKABOUT_NOT_LIVE` + `{ endedAt, endReason }` |
| `POST /sessions/:sessionId/stop` | write | `{ session }` | 404, 409 `WALKABOUT_NOT_LIVE` |
| `DELETE /sessions/:sessionId` | write | `{}` | 404 |

P1 returns **no coordinates and no credited-node lists**, only counts. P2's
hex endpoint will need node-visibility rules (`buildPositionFilter` /
`buildMeshCorePositionFilter` on credited nodes) and Q6.

Audit: `logger.info` on start, stop, delete (user id, source id, session id).

`src/server/test-helpers/publicInstanceAudit.ts`: add
`sessionId: '00000000-0000-4000-8000-000000000000'` to `PARAM_DEFAULTS`.

**Rate limit.** `apiLimiter` allows 1000 requests per 15 min per public IP
(`RATE_LIMIT_API`; private IPs exempt). A phone on cellular reaching a public
URL is not exempt, and the limiter's own comment puts a normal browser session
at ~900 requests per 15 min. So the walker must add little: the client posts
every **10 s with up to two fixes** (90 per 15 min), the sample response
carries counts and `endsAt` so the page never polls while walking, and the
Walkabout card mounts no other polling queries. On 429 the client keeps its
queue and retries after 30 s. WP5 measures the real request count off-LAN;
if it still nears 1000, see Q7.

### 2.9 Frontend — WP4

**`src/services/walkaboutApi.ts`**: `fetchWalkaboutSessions(sourceId)`,
`fetchLiveWalkabout(sourceId)`, `startWalkabout(sourceId, name?)`,
`postWalkaboutSamples(sourceId, sessionId, samples)`, `stopWalkabout(...)`,
`deleteWalkabout(...)`. Read `body.data`; surface `code`.

**`src/hooks/useWalkabout.ts`**: `useWalkaboutSessions(sourceId)` (key
`['walkabout', sourceId, 'sessions']`), `useLiveWalkabout(sourceId)` (once on
mount, no interval), `useStartWalkabout`, `useStopWalkabout`,
`useDeleteWalkabout` (invalidate the list key).

**`src/utils/walkaboutSampler.ts`** (pure, the testable core):
`createWalkaboutSampler()` with `offer(fix: { latitude, longitude, accuracy, timestamp })`
→ `'queued' | 'too-soon' | 'inaccurate'` (spacing on `timestamp`, exactly 5 s,
same rule as the server), `takeBatch(nowMs)` → `WalkaboutSampleInput[]` (≤ 4,
newest last, `deviceFixAt = timestamp`, `ageMs = nowMs − timestamp`), and
`requeue(batch)` after a failed post (keeps the newest 4).

**`src/hooks/useGeolocationWatch.ts`**:
- `window.isSecureContext === false` → `insecure`; no `navigator.geolocation` → `unavailable`; `PERMISSION_DENIED` → `denied`.
- `watchPosition(cb, err, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 })`, started only by a user tap (the browser consent prompt).
- **Standing still:** some browsers fire `watchPosition` only on movement. With no callback for `WALKABOUT_HEARTBEAT_MS`, call `getCurrentPosition` with `maximumAge: 2_000`. Without this a stop records nothing.
- **Screen lock:** the browser pauses geolocation while the screen is off or the tab is hidden. Track `visibilitychange`; on return report how long it was paused. Offer "Keep screen on" via `navigator.wakeLock.request('screen')` where supported; re-request on return to visible.

**`src/components/Analysis/WalkaboutReport.tsx`** (+ `.module.css`, test):
- Source picker: enabled sources with `type` `meshtastic_tcp` or `meshcore` and `hasPermission(WALKABOUT_WRITE_GRANT.resource, WALKABOUT_WRITE_GRANT.action, { sourceId })` (display filter only; the server enforces with manager predicates). Read-only users see the session list for sources they can read.
- Notices before Start (Start disabled): `insecure` → "Phone GPS needs HTTPS (or localhost). Open MeshMonitor over HTTPS to use Walkabout."; `denied` / `unavailable` → how to enable location.
- **Screen-lock notice in three places:** the Start modal, a standing line in the live panel ("Keep this page open and the screen on. Your phone stops sending GPS while the screen is locked."), and the on-return banner ("GPS paused for N min while the screen was off").
- Start `Modal`: "MeshMonitor sends nothing. Every packet this source's radio hears while you walk is tagged with your phone's position. Sessions stop after 2 hours." plus the screen-lock line. Stop button.
- Live panel: elapsed, auto-ends at, samples, receptions, current accuracy, skipped (no fix / relayer unknown or shared / no sender).
- Accuracy: > 30 m amber warning; > 100 m "waiting for a better fix" (not sent).
- Posting: every 10 s, `takeBatch` → `postWalkaboutSamples`; on network error or 429, `requeue`, retry in 30 s; on `WALKABOUT_NOT_LIVE` stop the watch and show "Session ended (2 h limit)" or "stopped".
- Reload: `useLiveWalkabout` returns a session with `startedByMe` → offer Resume; otherwise "Another user is walking this source" and no Start.
- Session list: name or date, duration, counts, Delete (`Modal` confirm). No map in P1.
- CSS module with `var(--color-*)` tokens and no fallback; `UiIcon` for icons; no emoji. Run the semanticTokens test (undefined tokens fail CI only).

**`AnalysisTab.tsx`**: `'walkabout'` in the type; a card (title "Walkabout",
description "Walk or drive with your phone; every packet this source hears is
mapped to where you are. Needs HTTPS."); `report=walkabout` deep link; hidden
for anonymous viewers.

**`public/locales/en.json`**: every `analysis.walkabout.*` key (inline defaults are not enough).

### 2.10 Freshness bound: 25 s

A reception uses the latest sample whose `fixAt` (server clock) is within
25 s of the server's receive time. Both sides are server-clock times; the
phone's clock enters only through `ageMs`, which the phone measures against
itself, and spacing uses the phone clock alone. No comparison crosses clocks.

Budget, worst case in a healthy session: newest fix in a post ≤ 5 s old
(5 s spacing, 5 s heartbeat when still) + it stays "latest" until the next
post 10 s later + ~1 s latency ≈ 16 s. 25 s leaves room for one slow post.

Error it allows, against an H3 res-9 cell (edge ~174 m, ~350 m across):

| Mode | Speed | Worst offset at 25 s |
|---|---|---|
| Walk | 1.4 m/s | 35 m (well inside a cell) |
| Cycle | 6 m/s | 150 m (within a cell) |
| City drive | 15 m/s | 375 m (one cell over) |
| Highway | 30 m/s | 750 m (two cells) |

Walking, the stated use, is clean. For drives, every row stores
`sampleAgeMs`, so P2 can filter (say ≤ 5 s) with no new capture. A tighter
bound now would drop most receptions between posts.

---

## 3. Mesh impact checklist (copy into the PR body)

1. **Airtime: zero.** MeshMonitor sends nothing. The phone posts GPS to the
   server over HTTP; capture reads packets the radio already heard.
2. **Spam: none.** No messages, DMs, traceroutes or admin packets. Nothing
   goes on `dataEventEmitter`, so no notifications, Apprise, MQTT publish or
   automation triggers, and no feedback loop. No mesh retries. HTTP: one post
   per 10 s per walker, one walker per source, under `apiLimiter`.
3. **Timers a save or restart could reset: none armed.** The 2 h cap is
   computed from the persisted `startedAt` at every check, not held in a
   timer. Boot ends overdue sessions at `startedAt + cap` and loads the rest
   with their stored `startedAt`, so a restart neither extends a session nor
   starts one. Spacing state is rebuilt from the newest stored sample's
   `deviceFixAt`, so a restart does not reset it either. There are no
   walkabout settings to save. The candidate cache uses a TTL on read.

The epic fixed the cap, accuracy and spacing numbers. Q5 and Q7 are the only
new limit questions.

---

## 4. Test plan (standard Vitest)

Run only the listed files, under the machine test lock (`flock`,
`--maxWorkers=2`); never the full suite locally (CI runs it). PG/MySQL suites
need containers on 5433/3307 and skip silently otherwise; confirm with
`numPendingTests`.

**Migration (WP1)**
- `src/server/migrations/248_create_coverage_walkabout.test.ts`: SQLite tables + indexes exist; re-run is a no-op.
- `248_create_coverage_walkabout.pgmysql.test.ts`: isolated DBs (`createIsolatedPostgresDatabase('cov_wk_mig')`, MySQL likewise); idempotent; UNIQUE index present.
- `systemBackupTables.test.ts` and `migrationTables.test.ts` pass (they fail until §2.2 registration is done).

**Repository (WP1)**
- `src/db/repositories/coverageWalkabout.test.ts` (SQLite): create/get/list order; `getOpenSession`; `endSession` touches open rows only; `deleteSession` removes children; `recordReception` true on insert, false on the duplicate; `getCounts` (distinct nodes); `getLatestSample` by `deviceFixAt`; `getOpenSessionsAllSources`.
- `coverageWalkabout.multiBackend.test.ts` (`isolationKey: 'covwk'`): the same on PG/MySQL, incl. `recordReception` false on a duplicate (MySQL catch path); UUID PK, bigint ms and `creditedNodeNum` > 2^31 round-trip as numbers.
- `coverageWalkabout.perSource.test.ts`: two sources; `getSession(B, idOnA)` null; `listSessions(A)` excludes B; `deleteForSource(A)` leaves all of B's rows.

**Credit rules (WP2), `src/server/utils/walkaboutCredit.test.ts`**
- Meshtastic: each skip in §2.6 order; direct (0/0 with bitfield) credits `from`; 0/0 without bitfield → `unknown-hops`; relayed with a unique relayer → credit it; relay byte 0 → `relay-none`; two nodes share the byte → `relay-ambiguous`; only CLIENT_MUTE / local / sender match → `relay-unknown`; `viaMqtt` on LoRa transport → `via-mqtt`; NodeDB replay → `nodedb-replay`; −128 SNR → null; RSSI 0 kept.
- MeshCore: flood with a unique last hop → relay credit; last hop shared by two keys → `relay-ambiguous`; 1-, 2- and 3-byte hash widths; direct route with a path → `unknown-hops`; **direct route, empty path, TXT_MSG → `direct-route-ambiguous`**; flood, empty path, TXT_MSG with a unique src hash → direct credit; flood, empty path, ANON_REQ with a known full key → credit, unknown key → `relay-unknown`; GRP_TXT and ACK → `no-sender`; zero-hop advert (direct and flood) returns `verifyAdvert`; own advert → `own-advert`; bad hex → `decode-failed`.
- `lastHop.test.ts` extended: `resolveUniqueRelayNode` 0/1/2 matches and exclusions.

**Service (WP2), `src/server/services/walkaboutService.test.ts`** (repo mocked with `mockResolvedValue`)
- Second `startSession` on a source → `WALKABOUT_ALREADY_LIVE`, including two calls in the same tick (sync claim); a different source is fine.
- **An open session past its cap does not block a new start**: it is ended `'cap'` and the start succeeds.
- `getOpenSession` returning a row the map lacks (failed init) → `WALKABOUT_ALREADY_LIVE`.
- **Before `init()` resolves**, `startSession` and `addSamples` wait for it; capture is a no-op; a rejected `init()` still releases them.
- MQTT manager → `WALKABOUT_SOURCE_UNSUPPORTED`.
- `addSamples`: accuracy 101 dropped, 100 kept; `deviceFixAt` 4 999 ms after the last → `spacing`, 5 000 → kept; 10 s backwards → `spacing`, 2 min backwards → kept (rebase); `ageMs` 31 s → `stale`; (0,0) → `invalid`; non-starter → `WALKABOUT_NOT_OWNER`; counts come from `getCounts`.
- Capture: no live session → repo never called; fix 26 s old → `skipped.noFix`, nothing written; fix 24 s old → written with copied lat/lon, `sampleId`, `sampleAgeMs`; advert with a bad signature not written; a rejecting repo never throws.
- Cap: at `startedAt + 2 h`, capture ends the session with `endedAt = startedAt + 2 h`, `'cap'`; `addSamples` → `WALKABOUT_NOT_LIVE`.
- **Restart sweep:** `init()` with one open row 3 h old and one 30 min old: the old one ends at `startedAt + 2 h` (not now); the young one is live with its stored `startedAt`, ends 90 min later, and its spacing baseline is the stored latest `deviceFixAt` (a sample 3 s after it is dropped). `init()` twice changes nothing more.

**Hooks (WP2)**: `processMeshPacket` and `handleOtaPacket` call the hook with
the packet-log setting **off**; the repeater RAW path reaches it (narrow new
test file if the manager suites are too heavy).

**Routes (WP3), `src/server/routes/walkaboutRoutes.test.ts`** (`createRouteTestApp`, real repo, CSRF token as `sourceRoutes.permissions.test.ts`)
- Anonymous → 401 on every route.
- `nodes:read` on A only: list A ok, B 403; cannot start.
- `nodes:write` on A only: start on A ok, on B 403.
- `ALREADY_LIVE` 409 with `sessionId`; samples from another write user → 403 `WALKABOUT_NOT_OWNER`; admin stops and deletes another user's session.
- 5 samples in a post → 400; envelopes `{ success, data }` / `{ success: false, error, code }`.
- `GET /sessions/live` is not swallowed by `/:sessionId`.
- `walkaboutRoutes.perSource.test.ts`: sessions on A and B; A's session under `/sources/B/...` → 404 on every route; no route under A returns or touches B's rows.
- Source delete removes A's walkabout rows; "purge nodes" on A leaves them (extend the `purgeRoutes.coverageCascade.test.ts` style).
- `publicInstance.sentinelAudit.test.ts` passes (routes "denied"; `sessionId` resolved).

**Frontend (WP4)**
- `walkaboutSampler.test.ts`: exact 5 s spacing on `timestamp`; > 100 m refused; batch ≤ 4 newest; `ageMs` / `deviceFixAt`; `requeue` keeps newest.
- `useGeolocationWatch.test.ts`: insecure, unavailable, denied states; heartbeat calls `getCurrentPosition` after 5 s of silence; hidden-time recorded; wake lock requested and re-requested (mock `navigator.geolocation`, `navigator.wakeLock`).
- `WalkaboutReport.test.tsx`: insecure notice disables Start; screen-lock line in the modal and live panel; > 30 m warning; Start → confirm → watch begins; posts every 10 s (fake timers); counts render from the response; 429 → retry after 30 s with the batch kept; `WALKABOUT_NOT_LIVE` stops the watch; Resume only when `startedByMe`; delete confirm; picker hides MQTT sources and sources without write.
- `useWalkabout.test.ts`: keys and invalidation.
- `AnalysisTab.test.tsx`: `?report=walkabout` opens the card; hidden for anonymous.
- `semanticTokens` test after adding the CSS module.

---

## 5. Work packages

Order: **WP0 → (WP1 ∥ WP2 ∥ WP4) → WP3 → WP5.** WP0 exists because jsdom
cannot `vi.mock` a module missing on disk, so parallel packages need the
files first. Each WP runs only its own test files under the lock, then
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` (must be
empty) and, for server files, `npx tsc --noEmit -p tsconfig.server.json`.
Relative imports in server code end in `.js`.

**WP0 — orchestrator, one commit before forking.** §2.1 files and skeletons
with final signatures; DatabaseService getter. *Accept:* `tsc` clean; no
behaviour change; skeleton methods throw.

**WP1 — storage (Sonnet).** Migration 248 + registry; repository bodies;
`BACKUP_TABLES`; `migrationTables.ts` (both lists); source-delete step.
Tests: migration (SQLite + PG/MySQL), repo SQLite + multiBackend + perSource,
backup / migrationTables guards.
*Accept:* listed tests green **with PG/MySQL containers up** and
`numPendingTests` 0 for these files; idempotent re-run; bigint round-trip;
duplicate reception returns false on all three backends.

**WP2 — capture + lifecycle (Sonnet).** `walkaboutCredit.ts`;
`resolveUniqueRelayNode`; `walkaboutService.ts` bodies; both manager hooks;
`server.ts` init. Mocks the repo, so it runs beside WP1. Confirms the MeshCore
direct-route path-strip rule in the firmware source (§2.6) and cites it in a
comment.
*Accept:* every §4 credit, service and hook case green; hooks are sync calls
(no new `await` on either RX path); no `dataEventEmitter` import in new
files; idle source costs one Map lookup (repo-not-called test).

**WP3 — routes (Sonnet), after WP1 and WP2 merge.** `walkaboutRoutes.ts` +
mount; audit `PARAM_DEFAULTS`; route, perSource and source-delete tests;
sentinel audit run.
*Accept:* §4 route cases green on the harness with the real repo; every
handler uses `ok`/`fail`; every route has `requireAuth` and
`requirePermission(..., { sourceIdFrom: 'params.id', requireSourceId: true })`
with the grant read only from `WALKABOUT_*_GRANT`.

**WP4 — frontend (Sonnet).** `walkaboutApi.ts` bodies, `useWalkabout.ts`,
`walkaboutSampler.ts`, `useGeolocationWatch.ts`, `WalkaboutReport.tsx` + CSS
module, `AnalysisTab.tsx` card, `en.json` keys. Mocks the API module.
*Accept:* §4 frontend tests green; no raw `fetch`; no hardcoded colours; no
emoji; semanticTokens green; works at 375 px wide with no sideways scroll.

**WP5 — orchestrator, after WP3 and WP4.** Merge; deploy the dev container
from the worktree; drive it on a phone over HTTPS (or Chrome DevTools sensor
override on localhost) against a live Meshtastic and MeshCore source; confirm
samples and receptions rise and an MQTT source cannot start. **Count requests
per 15 min from an off-LAN phone** (§2.8). Screenshot for the PR. Docs: a
Walkabout section in `docs/features/coverage-report.md` (HTTPS need, screen
lock, what "credited" means, sends nothing); epic phase log; CLAUDE.md
"Where things live" row.

---

## 6. Open questions for the orchestrator

- **Q1 — Permission (decide before WP3 merges).** The brief's "per-source
  write grant that gates saving surveys" does not exist; surveys use
  `requireAuth()` + sender visibility. This spec uses **`nodes:write`** to
  start/stop/sample/delete and **`nodes:read`** to view, per source, through
  `WALKABOUT_*_GRANT`. Alternatives: `settings:write` (gates
  `coverage_mqtt_enabled`), `packetmonitor` (the epic says "sources that feed
  the Packet Monitor"), or plain `requireAuth` + `nodes:read` like surveys.
- **Q2 — Where is the radio?** A row means "the source's radio heard node N
  while the phone was at X". That is coverage at X only if the radio travels
  with the phone (Pi + node in a pack or car). The issue reads both ways
  ("leave the Pi stationary" vs "they run MM on an rpi as the mobile
  device"). No schema change either way; UI copy here stays neutral. Should
  the Start modal say "carry the radio with you"?
- **Q3 — Relay candidates.** Plain reading: every node known on the source.
  On a busy Meshtastic mesh most low bytes collide, so many relayed packets
  will be skipped. Options: relay-capable roles only, heard in the last 24 h,
  or nodes in `direct_rf_contacts`; MeshCore relays limited to repeaters and
  room servers (advType 2/3). The resolver takes the list, so it is a filter change.
- **Q4 — "Purge nodes".** Spec: source delete removes walkabout data;
  "purge nodes" on a live source does not (kept until deleted). Coverage
  receptions are wiped by both. Confirm.
- **Q5 — Session count cap.** None here (a 2 h session is ≤ 1 440 samples
  plus a few thousand receptions, about 1–2 MB). Want a per-source cap (say
  200) or per-user (surveys use 50)?
- **Q6 — Who may see a track (P2, flag now).** P1 shows counts only. P2 will
  draw where the walker went: any `nodes:read` holder on the source, or the
  starter and admins only?
- **Q7 — Rate limit headroom.** If WP5's off-LAN count nears 1000 per 15 min,
  options are a dedicated higher limiter on the sample route, or telling
  public-URL users to raise `RATE_LIMIT_API`.

### Resolutions (orchestrator + maintainer, 2026-11-25) — binding

- **Q1:** `nodes:write` to start/stop/sample/delete, `nodes:read` to view, per source (maintainer).
- **Q2:** the radio must travel with the phone. The Start dialog says so plainly ("Carry the radio MeshMonitor is connected to; a radio left at home hears the same nodes wherever you walk"). Docs explain why (maintainer).
- **Q3:** relay candidates — Meshtastic: nodes on the source heard in the last 24 h, excluding role CLIENT_MUTE; MeshCore: repeaters and room servers (advType 2/3) only.
- **Q4:** confirmed — source delete removes walkabout data; purge nodes does not.
- **Q5:** no session cap.
- **Q6:** any `nodes:read` holder on the source may see a session and (P2) its track. The Start dialog notes the track is visible to readers of that source (maintainer).
- **Q7:** measure in WP5; decide then.
