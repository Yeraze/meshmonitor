# MQTT `ok_to_mqtt` Violation Detection — Phase 1 Implementation Spec

**Epic:** `MQTT_OK_TO_MQTT_VIOLATIONS_EPIC.md` (issue #4114)
**Phase:** 1 — backend only, no user-visible change
**Branch / worktree:** `feature/mqtt-oktomqtt-violations` @ `../meshmonitor-mqtt-violations`
**Migration number:** **128** (verified: `src/db/migrations.ts` has exactly 127 `registry.register(...)` calls,
highest `number: 127` = `add_atak_contacts` at `src/db/migrations.ts:2017-2023`; `number: 128` is not taken.
`src/server/migrations/` contains nothing numbered ≥ 128.)

Structural template: `MQTT_PACKET_MONITOR_PHASE1_SPEC.md` (the epic that built `mqtt_packet_log`).
Implementers follow this document literally. Where it says "reuse", do not hand-roll.

---

## 1. Reuse inventory (MANDATORY — use or extend these; do NOT duplicate)

Everything below was located and read in this worktree. File:line references are verified against
the current tree.

### 1.1 The bit evaluator to EXTRACT (not reimplement)

| Symbol | Location | Notes |
|---|---|---|
| `MqttBridgeManager.evaluateOkToMqtt` | `src/server/mqttBridgeManager.ts:482-499` | **private**, `Promise<boolean>`, **fail-closed**. Plaintext: `(decoded.bitfield & 0x1) === 1`. Encrypted / bitfield-absent: falls through to `channelDecryptionService.tryDecrypt(enc, id, from, channelHash)`; `!result.success \|\| typeof result.bitfield !== 'number'` ⇒ `false`. Missing `enc`/`id`/`from` ⇒ `false`. |
| Its **only** caller | `src/server/mqttBridgeManager.ts:760-767` (inside `handleUplink`, `:752`) | Gated on `!this.config.ignoreOkToMqtt`; on `false` increments `this.uplinkOkToMqttDrops` (`:265`, surfaced at `:462`) and `return`s. |
| Config flag | `MqttBridgeConfig.ignoreOkToMqtt?: boolean` — `src/server/mqttBridgeManager.ts:141` (doc at `:131`) | |
| Existing tests that MUST stay green | `src/server/mqttBridgeManager.test.ts:163-167` (test-helper `bitfield?: number`, defaults to `1`), `:184`, `:214`, `:237`, `:1038-1101` (`bitfield: 0` ⇒ dropped, `bitfield: 1` ⇒ uplinked), `:1103-1141` (`ignoreOkToMqtt: true` ⇒ uplinked with `bitfield: 0`) | |

**Fail-closed is correct for uplink and wrong for detection.** Phase 1 extracts a tri-state core and
re-expresses the uplink gate as `state === 'yes'`, preserving byte-for-byte behavior. See §2(a).

### 1.2 Decrypt services (both already return `bitfield` — no change needed there)

| Symbol | Location |
|---|---|
| `DecryptionResult.bitfield?: number` | `src/server/services/channelDecryptionService.ts:18,34-39` |
| `isValidProtobuf` extracts + `>>> 0`-normalizes it | `src/server/services/channelDecryptionService.ts:275,302-315` |
| `attemptDecryptSingleChannel` propagates it | `src/server/services/channelDecryptionService.ts:350` |
| `channelDecryptionService.tryDecrypt(payload, packetId, fromNode, channelHash?)` | `src/server/services/channelDecryptionService.ts:363` |
| `channelDecryptionService.isEnabled()` | `src/server/services/channelDecryptionService.ts:94` |
| `PkiDecryptResult.bitfield?: number` | `src/server/services/pkiDecryptionService.ts:34,40`; populated at `:155` in `decodeData` |

**Verified:** `pkiDecryptionService` has exactly one non-test consumer in the whole tree —
`src/server/meshtasticManager.ts:4952` (the **TCP** path). **The MQTT ingest path never calls it**, so
there is no second bitfield-drop to fix in `mqttIngestion.ts`. Do not add a PKI branch to MQTT ingest
in Phase 1.

### 1.3 Packet-log service and its templates

| Symbol | Location | Notes |
|---|---|---|
| `buildMqttPacketLogRow(sourceId, envelope, result)` | `src/server/services/mqttPacketLogService.ts:203-244` | **Exported pure function.** Extend, do not fork. |
| `mapOutcome(result)` | `:158-177` | module-private; emits `'distance'` at `:167-168`. |
| `parseGatewayNodeNum(id)` | `:183-187` | module-private; `!id \|\| !id.startsWith('!')` ⇒ `null`; `parseInt(id.slice(1), 16)`, `NaN` ⇒ `null`, else `n >>> 0`. **This spec MOVES it to the shared util (§3.1) and imports it back.** |
| `buildPreview` | `:193-196` | untouched. |
| `logEnvelope(sourceId, envelope, result)` | `:109-123` | the single write path; never throws. |
| Settings TTL cache pattern | `:30-31`, `isEnabled()` `:76-84`, `resetEnabledCache()` `:87-89` | `ENABLED_TTL_MS = 5000`. Clone this shape for the new enable flag. |
| Retention sweep + **the one 15-min interval** | `CLEANUP_INTERVAL_MS = 15 * 60 * 1000` `:26`; `startCleanupScheduler()` `:37-45`; `runCleanup()` `:51-69`; `stop()` `:145-151` | **Do NOT add a second timer.** Extend `runCleanup()`. |
| Defaults | `DEFAULT_MAX_COUNT = 5000` `:27`, `DEFAULT_MAX_AGE_HOURS = 24` `:28` | |
| Template service | `src/server/services/meshcorePacketLogService.ts` | same shape; consult if unsure. |

### 1.4 `MqttPacketLogRepository` (`src/db/repositories/mqttPacketLog.ts`)

| Symbol | Location | Notes |
|---|---|---|
| `DbMqttPacket` | `:24-50` | extend with 3 fields (§3.2). |
| `MqttGroupedQuery` | `:53-61` | unchanged in Phase 1. |
| `MqttGroupedPacket` | `:64-82` | extend with 2 fields. |
| `MqttGateway` | `:84-89` | unchanged. |
| `insertPacket` | `:99-105` | requires `sourceId` (throws otherwise). |
| `buildGroupedConditions` | `:111-127` | shared WHERE builder. |
| `getGroupedPackets` | `:138-169` | **explicit 18-aggregate projection** + `groupBy(t.sourceId, t.fromNode, groupKey)` where `groupKey = COALESCE(NULLIF(packetId,0), -id)` (`:140`). A new column does **not** reach the list view without an explicit aggregate. |
| `getGroupedPacketCount` | `:177-189` | subquery-over-grouped; comment at `:174-175` records that MySQL rejects multi-arg `COUNT(DISTINCT a,b)`. |
| `getReceptions` | `:200-214` | bare `.select()` ⇒ new columns appear automatically. |
| `getGateways` | `:220-234` | `groupBy(t.gatewayId)` + `MAX()` aggregates — the shape to copy for the violation gateway summary. |
| `getPacketCount` | `:240-248` | |
| `deletePacketsOlderThan(timestamp, sourceId?)` | `:253-263` | |
| `trimPacketsToCount(sourceId, maxCount)` | `:269-289` | newest-`maxCount`-survive by `(timestamp desc, id desc)`, then delete `id < oldestKeptId`. **Copy this algorithm verbatim.** |
| `getPacketLogSourceIds()` | `:295-301` | |
| `deleteAllPackets(sourceId?)` | `:307-316` | |
| `normalizeBigInts` (inherited) | `src/db/repositories/base.ts:267` | applied to every read; **required** on the new repo too (PG/MySQL BIGINT). |

### 1.5 Migration helpers and DDL templates

`src/server/migrations/helpers.ts` — every idempotency helper, per dialect:

| Helper | Dialect | Mechanism |
|---|---|---|
| `addColumnIfMissing(db, table, column, ddl)` | SQLite | catches "duplicate column"; re-throws anything else (`:56-`) |
| `addColumnIfMissingPostgres(client, table, column, ddl)` | PostgreSQL | native `ADD COLUMN IF NOT EXISTS` |
| `addColumnIfMissingMysql(pool, table, column, ddl)` | MySQL | `information_schema.COLUMNS` pre-check |
| `createTableIfMissingMysql(pool, table, createDdl)` | MySQL | `information_schema.TABLES` pre-check |
| `createIndexIfMissingMysql(pool, table, indexName, createDdl)` | MySQL | `information_schema.STATISTICS` pre-check |
| — | SQLite / PostgreSQL | native `CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS`; no helper needed |

DDL templates:
- **New table**, all three dialects: `src/server/migrations/121_mqtt_packet_log.ts` — SQLite `:21-66`,
  PG `:70-108` (note: params typed `import('pg').PoolClient`, **no `any`, no eslint-disable**),
  MySQL `:112-163` (`information_schema.TABLES` pre-check + inline `INDEX` clauses).
- **Add column**, all three dialects: `src/server/migrations/125_add_xeddsa_signed_to_packet_log.ts`
  — the shape to copy, **except** type its PG/MySQL params as 121 does rather than reproducing 125's
  `any` + eslint-disable (the ESLint ratchet must not grow).
- Registry entry shape: `src/db/migrations.ts:2009-2023`.
- `src/db/migrations.test.ts` needs **no edit** — its assertions are registry-derived
  (`:16-19` count==max, `:29-32` contiguity, `:49-54` all three dialects present, `:71-74`
  `settingsKey` required for 002+).

### 1.6 Cross-source route plumbing (`src/server/routes/analysisRoutes.ts`)

| Symbol | Location | Notes |
|---|---|---|
| `router.use(optionalAuth())` | `:30` | already applied to the whole router. |
| `resolvePermittedSourceIds(req, resource = 'nodes')` | `:32-52` | admin ⇒ all enabled; else `checkPermissionAsync(user?.id ?? 0, resource, 'read', s.id)` per source. **Pass `'packetmonitor'`.** |
| `parseSourcesParam(raw)` | `:54-57` | CSV ⇒ `string[] \| null`. |
| `clampPageSize(raw)` | `:59-63` | default 500, max 2000. |
| `parseSinceMs(raw)` | `:65-68` | ms epoch, `>= 0`, default 0. |
| Intersection idiom | `:178-181` and repeated | `requested ? permitted.filter(id => requested.includes(id)) : permitted`. |
| Mount point | `src/server/server.ts:641` (import), `:794` `apiRouter.use('/analysis', analysisRoutes)` | ⇒ new paths live under `/api/analysis/...`. **No server.ts edit required.** |
| `AnalysisRepository` | `src/db/repositories/analysis.ts:258`; wired at `src/services/database.ts:658` (getter) and `:919` (construction) | Phase 1 adds a **new** repo, not methods here — see §2(d) justification. |
| `packetmonitor` is source-scoped | `src/server/constants/permissions.ts:7-14` (`SOURCEY_RESOURCES`) | every check needs a `sourceId`. |

### 1.7 Response envelope, source scoping, test harness

| Symbol | Location | Notes |
|---|---|---|
| `ok(res, data?)` | `src/server/utils/apiResponse.ts:15-17` | ⇒ `{ success: true, data }`. |
| `fail(res, status, code, message, extra?)` | `:31-39` | ⇒ `{ success: false, error, code, ...extra }`. |
| Frontend does **not** unwrap `data` | comment at `apiResponse.ts:6-10` | Phase 3 must read `body.data`. Restated in §2(e). |
| `withSourceScope(table, sourceId)` | `src/db/repositories/base.ts:244-` | throws unless a concrete `sourceId` or the `ALL_SOURCES` sentinel (`:33`) is passed. |
| `normalizeBigInts` | `src/db/repositories/base.ts:267` | |
| `this.tables` / `buildActiveSchema` | `src/db/repositories/base.ts:57,67`; `src/db/activeSchema.ts:168,273,454` | `mqttPacketLog` key registered at `activeSchema.ts:58-59` (imports), `:194` (interface), `:292/:350/:408` (SCHEMA_MAP). Mirror all five spots for the new table. |
| `createRouteTestApp(...)` | `src/server/test-helpers/routeTestApp.ts:135`; harness type `:63-119`; `sourceA`/`sourceB` `:72,74`; `admin`/`limited` `:76,78`; `grant(...)` `:96`; `loginAs`, `tokenFor`, `cleanup` `:266-301` | **New route tests MUST use this.** |
| `createTestDb()` | `src/server/test-helpers/testDb.ts` (used by `src/db/repositories/mqttPacketLog.perSource.test.ts:13,52-55`) | builds a `:memory:` SQLite from the migration registry. |
| Settings allowlist | `src/server/constants/settings.ts` — existing `mqtt_packet_log_*` keys at `:103-105` | |
| "SERVER_ONLY_SETTINGS" | **not a production constant** — it is a local allowlist inside `src/server/server.settings-persistence.test.ts:405-432` | It only guards keys that **SettingsTab sends**. Phase 1 adds no SettingsTab field, so **no edit is needed**. See §2(g) for the Phase 2/3 trap. |

### 1.8 Existing tests to extend (do not create parallel files)

`src/db/repositories/mqttPacketLog.perSource.test.ts`, `mqttPacketLog.grouping.test.ts`,
`src/server/services/mqttPacketLogService.buildRow.test.ts`,
`src/server/mqttPacketLogService.ingestHook.test.ts`, `src/server/mqttIngestion.test.ts`,
`src/server/mqttBridgeManager.test.ts`, `src/server/migrations/121_mqtt_packet_log.test.ts`.

### 1.9 Justification for the only genuinely new subsystem

**`mqtt_ok_to_mqtt_violations` table + repository.** The closest existing thing is `mqtt_packet_log`
itself. It cannot be reused because interview decision 4 requires **retention immunity** relative to
the packet log's 24 h / 5 000-row trim (`mqttPacketLogService.ts:27-28`), and Phase 3 needs a
weeks-long lookback. Adding a "don't trim me" flag to `mqtt_packet_log` would fork its retention
algorithm and defeat the count cap. A separate, far lower-volume table with its own sweep is the
smaller change. `AnalysisRepository` was also considered as a home for the queries and rejected: it
is not a `BaseRepository` subclass (`analysis.ts:258-260` holds its own `db`/`dbType`) and has no
`withSourceScope`/`normalizeBigInts`; a `BaseRepository` subclass is the correct base for a new
source-scoped table.

**`src/server/utils/okToMqtt.ts`.** New, but it is an *extraction* of `evaluateOkToMqtt`, not a new
mechanism — required because the same logic now has two callers with opposite failure semantics.

---

## 2. Design decisions (settled — implementers do not re-decide)

### 2(a) Shared tri-state evaluator: location and exact signature

**Location:** `src/server/utils/okToMqtt.ts` (NEW). It imports `ServiceEnvelopeShape` from
`../mqttPacketFilter.js` (which imports only `constants/meshtastic.js` — no cycle) and
`channelDecryptionService` from `../services/channelDecryptionService.js` (already imported by
`mqttBridgeManager`, so no new cycle).

```ts
export type OkToMqttState = 'yes' | 'no' | 'unknown';

/** Pure. `undefined`/`null`/non-number ⇒ 'unknown'; bit 0 set ⇒ 'yes'; clear ⇒ 'no'. */
export function readBitfieldOkToMqtt(bitfield: number | null | undefined): OkToMqttState;

/**
 * Envelope-level resolution, mirroring the original evaluateOkToMqtt control flow exactly:
 *  1. `packet.decoded.bitfield` is a number  → readBitfieldOkToMqtt(it)
 *  2. else, `packet.encrypted` + numeric `packet.id` + numeric `packet.from` present
 *     → await channelDecryptionService.tryDecrypt(enc, id, from, channelHashOrUndefined)
 *       → success && typeof bitfield === 'number' ? readBitfieldOkToMqtt(bitfield) : 'unknown'
 *  3. else → 'unknown'
 * NOTE: deliberately does NOT gate on channelDecryptionService.isEnabled() — the original
 * evaluator did not, and adding the gate would change uplink behavior.
 */
export async function resolveOkToMqttForEnvelope(envelope: ServiceEnvelopeShape): Promise<OkToMqttState>;

/** Fail-closed adapter for the uplink gate: only an explicit 'yes' permits republishing. */
export function allowsUplink(state: OkToMqttState): boolean; // state === 'yes'

/** Moved verbatim from mqttPacketLogService.ts:183-187. */
export function parseGatewayNodeNum(id: string | null | undefined): number | null;

export interface OkToMqttViolationEval {
  state: OkToMqttState;
  bitfield: number | null;          // raw Data.bitfield, null when unreadable
  fromNode: number | null;          // u32
  gatewayNodeNum: number | null;    // u32, parsed from envelope.gatewayId
  selfGateway: boolean;             // gateway is THIS source's own local gateway (§2(f.1))
  relayed: boolean;                 // both numeric AND different AND !selfGateway
  isViolation: boolean;             // state === 'no'      && relayed
  isSuspected: boolean;             // state === 'unknown' && relayed
}

/**
 * Synchronous, pure, allocation-light. Reads ONLY `envelope.packet.decoded.bitfield`,
 * `envelope.packet.from`, `envelope.gatewayId`. Never decrypts — by the time ingest calls
 * this, `ingestServiceEnvelopeInner` has already synthesized `packet.decoded` (§2(b)).
 *
 * `localGatewayNodeNum` is THIS source's own gateway node number. When the publishing
 * gateway matches it, the reception is neither a violation nor suspected. This is the
 * self-echo guard of §2(f.1) — it deliberately does NOT rely on the bridge's echo
 * suppression, which is not airtight. Omit/`null` only when the caller genuinely has no
 * local identity.
 */
export function detectOkToMqttViolation(
  envelope: ServiceEnvelopeShape,
  localGatewayNodeNum?: number | null,
): OkToMqttViolationEval;
```

**`MqttBridgeManager` refactor.** Replace the body of `evaluateOkToMqtt`
(`src/server/mqttBridgeManager.ts:482-499`) with a two-liner; keep the method, its name, its
`private` modifier, its `Promise<boolean>` signature, and its doc comment (amended to point at the
shared util and note that `unknown ⇒ drop`):

```ts
private async evaluateOkToMqtt(envelope: ServiceEnvelopeShape): Promise<boolean> {
  return allowsUplink(await resolveOkToMqttForEnvelope(envelope));
}
```

The call site at `:760-767` is **untouched** — `uplinkOkToMqttDrops` still increments on `false`.

**Behavioral equivalence proof (every existing case still holds):**

| Old code path | Old result | New: state → `allowsUplink` |
|---|---|---|
| `decoded.bitfield = 1` (`:485`) | `true` | `'yes'` → `true` — covers `mqttBridgeManager.test.ts:1085`, and `:184/:214/:237` default `bitfield: 1` |
| `decoded.bitfield = 0` (`:485`) | `false` | `'no'` → `false` — covers `:1038-1101` (`bitfield: 0` dropped, drop counter increments) |
| `decoded` present, `bitfield` absent, `encrypted` present | falls to `:489-498`, decrypt attempted | step 1 skipped (not a number) → step 2 decrypt attempted — **identical** |
| `decoded` present, `bitfield` absent, no `encrypted` | `:492` `return false` | step 3 → `'unknown'` → `false` |
| encrypted, decrypt fails or returns non-numeric bitfield (`:497`) | `false` | `'unknown'` → `false` |
| encrypted, decrypt yields `bitfield` (`:498`) | `(b & 1) === 1` | `readBitfieldOkToMqtt(b)` — identical |
| `ignoreOkToMqtt: true` (`:760`) | evaluator never called | unchanged — covers `:1103-1141` |

### 2(b) How `bitfield` survives the server-side decrypt path

**Minimal change**, `src/server/mqttIngestion.ts:190-205`: add `bitfield` to the inline cast type and
to the synthesized object literal. Nothing else.

```ts
(packet as {
  decoded?: {
    portnum?: number;
    payload?: Uint8Array;
    emoji?: number;
    replyId?: number;
    channelDatabaseId?: number;
    bitfield?: number;                 // ← ADD (#4114): the ok_to_mqtt bit must survive decrypt
  };
}).decoded = {
  portnum: r.portnum,
  payload: r.payload,
  emoji: r.emoji,
  replyId: r.replyId,
  channelDatabaseId: r.channelDatabaseId,
  bitfield: r.bitfield,                // ← ADD
};
```

No typing work downstream: `MeshPacketShape.decoded` already declares `bitfield?: number`
(`src/server/mqttPacketFilter.ts:47`).

**Why this is sufficient:** `ingestServiceEnvelopeInner` mutates `packet.decoded` **in place**, and
`logEnvelope` runs *after* it in the wrapper (`mqttIngestion.ts:587-589`). `buildMqttPacketLogRow`
already relies on exactly this (`decryptedBy: wasEncrypted && decoded ? 'server' : null`,
`mqttPacketLogService.ts:238`), so the synthesized `bitfield` is visible to the row builder and to
`detectOkToMqttViolation`.

**PKI path:** verified absent from MQTT ingest — `pkiDecryptionService`'s only non-test consumer is
`src/server/meshtasticManager.ts:4952` (TCP). **No change, and no new PKI branch, in Phase 1.**
(`PkiDecryptResult.bitfield` at `pkiDecryptionService.ts:40,155` is already correct if a future phase
wires it into the TCP packet log.)

### 2(c) Storage shape for the tri-state

**Decision: two columns on `mqtt_packet_log`, no text enum.**

| Column | SQLite | PostgreSQL | MySQL | Meaning |
|---|---|---|---|---|
| `bitfield` | `INTEGER` (nullable) | `INTEGER` (nullable) | `INT` (nullable) | Raw `Data.bitfield`. `NULL` = absent/unreadable = **unknown**. |
| `okToMqttViolation` | `INTEGER NOT NULL DEFAULT 0` | `INTEGER NOT NULL DEFAULT 0` | `INT NOT NULL DEFAULT 0` | 0/1 derived flag. |

**Why a nullable raw int and not a nullable boolean or a text enum:**

1. **Nullable boolean is unusable in the grouped projection.** `mqtt_packet_log.encrypted` is
   deliberately a raw 0/1 int specifically because *PostgreSQL has no `MAX(boolean)` aggregate*
   (`src/db/schema/mqttPacketLog.ts:46-50`, repeated at `:85` and `:117`). The Phase 2 badge needs
   `MAX(okToMqttViolation)` to survive `getGroupedPackets`' explicit projection, so the violation
   flag **must** be the same raw 0/1 int. Same reason MySQL `ONLY_FULL_GROUP_BY` is satisfied: it is
   an aggregate over a numeric column, not a bare selected column.
2. **The tri-state is derivable, so a third column would be redundant state that can diverge.**
   `bitfield IS NULL` ⇒ `unknown`; `bitfield & 1 = 1` ⇒ `yes`; else ⇒ `no`. Reconstructed in JS via
   `readBitfieldOkToMqtt(row.bitfield)`.
3. **Store the raw value, not just the derived bit.** `Data.bitfield` is a `uint32` with room for
   more flags; keeping the raw value costs one nullable int and makes any future bit readable from
   history with no migration. It is also the diagnostic the issue's reporter wants ("what did the
   originator actually set?").
4. `MAX(bitfield)` across a packet's gateway receptions is *semantically exact*, not a fudge: the
   bitfield is the **originator's** field, identical in every gateway's copy of the same packet. It
   is `NULL` only when *every* copy was unreadable.

Third column added in the same migration for interview decision 2:

| `topic` | `TEXT` | `TEXT` | `VARCHAR(512)` | Raw MQTT topic. Diagnostic. |

### 2(d) The durable violations table

**Table:** `mqtt_ok_to_mqtt_violations`. **Per-violating-reception rows, not a rolled-up counter.**

**Why rows, against the growth objection:** Phase 3 needs *both* a per-gateway summary *and*
drill-down to the individual violating packets over a user-chosen lookback of weeks. A counter
cannot produce the drill-down, and a counter plus a row table is strictly more code than a row table
with a `GROUP BY`. Unbounded growth is prevented by three independent mechanisms:
1. **Violations are rare by construction** — a row requires a gateway that (a) relays someone else's
   packet and (b) misreads its broker as private. On a healthy mesh the rate is zero; on an affected
   mesh it is one row per relayed packet per offending gateway, which is exactly the signal.
2. **Its own retention sweep** (below), independent of the packet log's.
3. **A dedupe unique index** that collapses re-ingest of the same reception.

**Confirmed violations only.** Rows are written **only** when `state === 'no' && relayed`. "Unknown"
receptions are deliberately **not** persisted here: on a busy public-broker source essentially every
relayed encrypted packet is `unknown`, which would make the table the same volume as the packet log
and destroy the retention-immunity argument. Interview decision 6's `includeUnknown` toggle is served
from `mqtt_packet_log` instead — see §2(e) and the caveat there.

**Columns** (three dialect definitions in `src/db/schema/mqttOkToMqttViolations.ts`):

| Column | SQLite | PostgreSQL | MySQL | Notes |
|---|---|---|---|---|
| `id` | `integer('id').primaryKey({autoIncrement:true})` | `pgInteger('id').primaryKey().generatedAlwaysAsIdentity()` | `mySerial('id').primaryKey()` | mirrors `mqttPacketLog` exactly |
| `sourceId` | `text` NOT NULL | `pgText` NOT NULL | `myVarchar(255)` NOT NULL | **per-source scoping** |
| `packetId` | `integer` | `pgBigint({mode:'number'})` | `myBigint({mode:'number'})` | u32; nullable |
| `fromNode` | `integer` | `pgBigint` | `myBigint` | originator, u32 |
| `fromNodeId` | `text` | `pgText` | `myVarchar(16)` | `!aabbccdd` |
| `gatewayId` | `text` | `pgText` | `myVarchar(32)` | publishing gateway |
| `gatewayNodeNum` | `integer` | `pgBigint` | `myBigint` | u32 |
| `channelId` | `text` | `pgText` | `myVarchar(64)` | envelope channel **name** |
| `portnum` | `integer` | `pgInteger` | `myInt` | |
| `portnumName` | `text` | `pgText` | `myVarchar(48)` | |
| `bitfield` | `integer` | `pgInteger` | `myInt` | always non-null and even on a confirmed row |
| `topic` | `text` | `pgText` | `myVarchar(512)` | raw MQTT topic |
| `rxTime` | `integer` | `pgBigint` | `myBigint` | ms |
| `timestamp` | `integer` NOT NULL | `pgBigint` NOT NULL | `myBigint` NOT NULL | server capture ms — ordering + retention |
| `createdAt` | `integer` NOT NULL | `pgBigint` NOT NULL | `myBigint` NOT NULL | |

**Indexes:**
- `idx_mqtt_v_source_ts (sourceId, timestamp)` — retention sweep + lookback range scans
- `idx_mqtt_v_source_gw_ts (sourceId, gatewayNodeNum, timestamp)` — gateway summary
- `idx_mqtt_v_dedupe` **UNIQUE** `(sourceId, packetId, fromNode, gatewayNodeNum)` — dedupe

**Primary key:** surrogate `id`. The natural key is the dedupe tuple, but it contains nullables, so
it is a unique index rather than a PK.

**Duplicate ingest of the same reception** (retained-frame replay, broker redelivery, both a broker
publish and a bridge downlink of the same envelope): the unique index makes the second insert a
**silent no-op**, via a dialect branch inside `insertViolation`:
- `sqlite` / `postgres`: `.onConflictDoNothing()`
- `mysql`: `.onDuplicateKeyUpdate({ set: { timestamp: sql`timestamp` } })` (Drizzle MySQL has no
  `onConflictDoNothing`; assigning a column to itself is the idiomatic no-op)

The first write wins, so `timestamp` records first observation. **Documented limitation:** rows with
`packetId` NULL/0 cannot dedupe (`NULL != NULL` in a unique index on all three dialects) — the same
accepted edge already documented for `getReceptions` (`mqttPacketLog.ts:191-199`). Real mesh packets
essentially always carry a nonzero id.

**Retention — own settings, existing timer.** `mqttPacketLogService.runCleanup()`
(`:51-69`) gains a second phase. **No new `setInterval`.**

```ts
// phase 2 of runCleanup(), after the packet-log trim:
const days = await this.getViolationRetentionDays();          // default 90
const vCutoff = Date.now() - days * 24 * 60 * 60 * 1000;
let vRemoved = await databaseService.mqttOkToMqttViolations.deleteViolationsOlderThan(vCutoff);
const vMax = await this.getViolationMaxCount();               // default 50000
for (const sid of await databaseService.mqttOkToMqttViolations.getViolationSourceIds()) {
  vRemoved += await databaseService.mqttOkToMqttViolations.trimViolationsToCount(sid, vMax);
}
```

Retention immunity is structural: a different table, a different cutoff (90 d vs 24 h), a different
cap (50 000/source vs 5 000/source). `mqttPacketLog.deleteAllPackets()` / `deletePacketsOlderThan()`
never touch it.

**Write gate is independent of `mqtt_packet_log_enabled`.** The packet log is opt-in because it
writes a row for *every* reception; violations are rare, so the volume argument does not apply, and
gating them behind the packet monitor would leave the Phase 3 report silently empty on most installs.
The violation write has its own kill switch, **default ON** (§2(g)). Concretely, `logEnvelope`
becomes:

```ts
async logEnvelope(sourceId, envelope, result, topic?, localGatewayNodeNum?): Promise<void> {
  try {
    if (!envelope.packet) return;
    const v = detectOkToMqttViolation(envelope, localGatewayNodeNum); // pure, cheap, no await
    const packetLogEnabled = await this.isEnabled();     // cached, 5 s TTL
    const wantViolation = v.isViolation && await this.isViolationLogEnabled(); // cached
    if (!packetLogEnabled && !wantViolation) return;     // fast path: nothing to write
    const row = buildMqttPacketLogRow(sourceId, envelope, result, topic, v);
    if (!row) return;
    if (wantViolation) {
      await databaseService.mqttOkToMqttViolations.insertViolation(buildViolationRow(row));
    }
    if (packetLogEnabled) {
      await databaseService.mqttPacketLog.insertPacket(row);
    }
  } catch (err) {
    logger.error('❌ Failed to log MQTT packet:', err);   // never throws — unchanged contract
  }
}
```

`buildViolationRow(row: DbMqttPacket): DbMqttOkToMqttViolation` is a new exported pure function in
`mqttPacketLogService.ts` — a straight field projection, so the two rows can never disagree.

**Forward-only by design — an empty report right after upgrade is EXPECTED, not a bug.**
Migration 128 performs **no backfill**, and it cannot: `bitfield` was never captured before this
change, so every pre-existing `mqtt_packet_log` row has `bitfield = NULL` and
`okToMqttViolation = 0`, and the violations table starts empty. Consequences the operator will see:

- Both `/api/analysis/mqtt-violations/*` endpoints return empty result sets until **new** MQTT
  traffic arrives after the upgrade.
- Historical rows are indistinguishable from genuine "unknown" — they are `bitfield IS NULL`, so
  with `includeUnknown=true` they would surface as *suspected* purely because they predate the
  feature. This is why suspected entries are labelled `kind: 'suspected'` and scoped to
  `suspectedWindowMs`; within a day of upgrade the packet log's own 24 h retention has flushed
  every pre-migration row, and the ambiguity self-resolves.
- No `UPDATE` pass is added to the migration. Backfilling would require re-deriving a bit that was
  never stored — impossible — so a backfill could only write a wrong value.

This matches the precedent set by migration 125 (`xeddsa_signed`, "No backfill: … historical rows
stay NULL (unknown)", `125_add_xeddsa_signed_to_packet_log.ts:17-19`). WP6 records it in the epic
doc so the user is not surprised.

### 2(e) Cross-source route surface

Two new handlers in **`src/server/routes/analysisRoutes.ts`** (NOT `mqttPacketRoutes.ts`, which is
per-source `/api/sources/:id/mqtt/packets`). The router is mounted at `/api/analysis`
(`server.ts:794`) and already has `optionalAuth()` applied (`analysisRoutes.ts:30`), so **no
`server.ts` edit**.

Both call `resolvePermittedSourceIds(req, 'packetmonitor')` and intersect with `?sources=` using the
existing idiom. An unpermitted / anonymous user gets a **200 with empty results**, matching every
other handler in this file — not a 403.

#### `GET /api/analysis/mqtt-violations/gateways`

Per-gateway summary. Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `sources` | CSV | all permitted | `parseSourcesParam` |
| `lookbackDays` | int 1..365 | 7 | ignored when `since` is supplied |
| `since` | ms epoch | derived from `lookbackDays` | `parseSinceMs` |
| `until` | ms epoch | `Date.now()` | new local `parseUntilMs` |
| `includeUnknown` | `'true'`/`'1'` | `false` | see caveat below |
| `sort` | `violationCount` \| `lastSeen` \| `distinctOriginators` \| `gatewayId` | `violationCount` | anything else ⇒ 400 |
| `dir` | `asc` \| `desc` | `desc` | anything else ⇒ 400 |
| `limit` | int | `clampPageSize` (500, max 2000) | |
| `offset` | int ≥ 0 | 0 | |

Success — `ok(res, {...})`, i.e. the wire body is `{ success: true, data: { ... } }`:

```jsonc
{ "success": true, "data": {
  "gateways": [{
    "gatewayId": "!433e0f28", "gatewayNodeNum": 1128729384,
    "violationCount": 42,          // confirmed (bit explicitly 0)
    "suspectedCount": 0,           // 0 unless includeUnknown=true
    "distinctOriginators": 7,
    "sourceIds": ["mqtt-main"],
    "firstSeen": 1753300000000, "lastSeen": 1753380000000
  }],
  "total": 3, "limit": 500, "offset": 0,
  "since": 1752780000000, "until": 1753387000000,
  "includeUnknown": false,
  "suspectedAvailable": true,      // false when mqtt_packet_log_enabled is off
  "suspectedWindowMs": 86400000,   // packet-log max age — the suspected horizon
  "sources": ["mqtt-main", "mqtt-eu"]
}}
```

#### `GET /api/analysis/mqtt-violations/packets`

Drill-down. Same params, plus `gateway` (a single `gatewayId`, optional) and
`sort ∈ { timestamp, fromNode, gatewayId }` (default `timestamp`).

```jsonc
{ "success": true, "data": {
  "violations": [{
    "id": 91, "kind": "confirmed",          // 'confirmed' | 'suspected'
    "sourceId": "mqtt-main", "packetId": 123456,
    "fromNode": 2864434397, "fromNodeId": "!aabbccdd",
    "gatewayId": "!433e0f28", "gatewayNodeNum": 1128729384,
    "channelId": "LongFast", "portnum": 1, "portnumName": "TEXT_MESSAGE_APP",
    "bitfield": 0, "topic": "msh/US/2/e/LongFast/!433e0f28",
    "rxTime": 1753379999000, "timestamp": 1753380000000
  }],
  "total": 42, "limit": 500, "offset": 0,
  "since": …, "until": …, "gateway": null, "includeUnknown": false,
  "suspectedAvailable": true, "suspectedWindowMs": 86400000,
  "sources": ["mqtt-main"]
}}
```

Errors — `fail(...)`, all introducing SCREAMING_SNAKE codes. **This is the complete list; §3.17
step 4 emits exactly these three 400s and nothing else:**
- `fail(res, 400, 'INVALID_SORT_FIELD', 'Unsupported sort field')`
- `fail(res, 400, 'INVALID_SORT_DIRECTION', 'Sort direction must be asc or desc')`
- `fail(res, 400, 'INVALID_RANGE', 'since must be <= until')`
- `fail(res, 500, 'MQTT_VIOLATIONS_FETCH_FAILED', 'Failed to fetch ok_to_mqtt violations')`

**`includeUnknown` caveat (load-bearing, Phase 3 must surface it).** Confirmed violations come from
`mqtt_ok_to_mqtt_violations` (weeks). Suspected entries (`bitfield IS NULL AND gatewayNodeNum
IS NOT NULL AND fromNode IS NOT NULL AND gatewayNodeNum <> fromNode`) are read from
`mqtt_packet_log`, so they are inherently limited to that table's retention window and require
`mqtt_packet_log_enabled`. The route reports `suspectedAvailable` and `suspectedWindowMs` so Phase 3
can render "suspected entries limited to the packet-monitor retention window (24 h)". When
`includeUnknown=false` (the default) the packet-log query is **not executed at all**.

**Frontend contract restated:** `ApiService.request()` returns the raw JSON body and does **not**
unwrap `data` (`src/server/utils/apiResponse.ts:6-10`). **Phase 3 must read `body.data`.**

### 2(f) The violation predicate, exactly

```
isViolation  ⇔  state === 'no'       AND  relayed
isSuspected  ⇔  state === 'unknown'  AND  relayed
selfGateway  ⇔  localGatewayNodeNum != null
                 AND  Number(gatewayNodeNum) === Number(localGatewayNodeNum)
relayed      ⇔  fromNode !== null  AND  gatewayNodeNum !== null
                 AND  Number(fromNode) !== Number(gatewayNodeNum)
                 AND  !selfGateway
```

All comparisons on `>>> 0`-normalized u32 values, coerced with `Number()` (PG/MySQL return BIGINT).

| # | Case | `state` | `relayed` | Outcome |
|---|---|---|---|---|
| 1 | bit = 1, gateway ≠ originator | `yes` | true | not a violation |
| 2 | bit = 1, gateway = originator | `yes` | false | not a violation |
| 3 | bit = 0, gateway ≠ originator | `no` | true | **CONFIRMED VIOLATION** — the whole feature |
| 4 | **bit = 0, gateway = originator (originator publishing its own packet)** | `no` | false | **NEVER a violation, regardless of the bit.** Firmware only enforces `ok_to_mqtt` when relaying *other* nodes' packets; a node uplinking its own traffic is expressing its own choice. Has a dedicated test. |
| 5 | plaintext, `bitfield` field simply unset | `unknown` | any | suspected iff relayed; never confirmed |
| 6 | encrypted, no `channel_database` PSK matched ⇒ no `decoded` | `unknown` | any | suspected iff relayed; never confirmed |
| 7 | encrypted, PSK matched, `bitfield` present | per bit | per gw | rows 1–4 apply |
| 8 | `gatewayId` null / absent | `unknown`-agnostic | **false** | nothing recorded — relaying cannot be proven |
| 9 | `gatewayId` malformed (no leading `!`, non-hex, `parseInt` ⇒ `NaN`) ⇒ `parseGatewayNodeNum` returns `null` | any | **false** | nothing recorded |
| 10 | `packet.from` not a number ⇒ `fromNode === null` | any | **false** | nothing recorded |
| 11 | `fromNode === 0` | any | compared normally (if `gatewayNodeNum` is also 0 ⇒ not relayed) | per comparison |
| 12 | broadcast (`to = 0xffffffff`) vs DM | irrelevant | — | predicate is `to`-agnostic; the bit is the originator's global preference, not a per-recipient one |
| 13 | MQTT-bridge **downlink** (`mqttBridgeManager.handleDownlink`, `:643`, ingest at `:698`) | evaluated identically | | **recorded** — a copy arriving from an upstream broker is precisely the evidence sought |
| 14 | Local-broker **publish** (`mqttBrokerManager.handlePublish`, `:256`, ingest at `:272`) | evaluated identically | | **recorded** |
| 15 | **MeshMonitor's own uplink echoing back** (esp. with `ignoreOkToMqtt` on, #4104) | per bit | **false** via `selfGateway` | **Never recorded — see §2(f.1). Enforced by an explicit guard, NOT by echo suppression.** |
| 16 | Pre-ingest-filter drops (topic/node/portnum pre-filter) | — | — | **out of scope** (epic decision 3) — never reach `ingestServiceEnvelope` |

#### 2(f.1) Self-echo: why an explicit guard, not the echo window

This is the one case that could make the feature accuse its own operator, so it is argued in full.

**Two independent facts, both verified in the tree:**

**Fact 1 — the bridge does not rewrite `gatewayId` on uplink, so a returning echo is attributed to
the *original* gateway, not to MeshMonitor.** `handleUplink` republishes `p.payload` **byte-for-byte**
(`mqttBridgeManager.ts:795`/`:800` — `publish(publishTopic, p.payload, p.retained)`); only the
*topic* is rewritten (`applyTopicRewrite`, `:772`). The per-gateway publisher dispatch reads
`extractGatewayNum(p.envelope.gatewayId)` (`:780`) but never mutates it. The local broker's zero-hop
re-encode likewise preserves it (`mqttBrokerManager.ts:250`, `gatewayId: decoded.gatewayId`). So even
on a missed echo, MeshMonitor's own node number is not what lands in `gatewayId` — the *upstream*
publisher's is.

**Fact 2 — the echo suppression is nevertheless NOT airtight, so it must not be load-bearing.**
`matchesEcho` (`mqttBridgeManager.ts:817-821`) matches on **exact topic-string equality AND
packetId**: `store.some(e => e.topic === topic && e.packetId === packetId)`. Entries are recorded
under the **post-rewrite** `publishTopic` (`:788`) with `ECHO_TTL_MS = 60_000` (`:232`) in a ring
bounded at `ECHO_MAX = 256` (`:233`) that evicts **oldest-first** when full (`:813`). Three concrete
miss modes:

1. **Topic rewrite / canonicalisation by the broker.** If the upstream broker republishes on a
   different topic than the one we published to (canonical `msh/<region>/2/e/<ch>/<gw>` paths,
   operator-configured `uplinkTopicRewrite`, or simply a downlink subscription on a different
   branch), `e.topic === topic` is false and the echo is **not** suppressed.
2. **Redelivery delayed past 60 s.** Retained-frame replay on reconnect and queued QoS-1 delivery
   after a network blip routinely exceed the TTL. This codebase already treats delayed replay as
   real (the `resolveLastHeardSec` replay guard, `mqttIngestion.ts:227`).
3. **Ring eviction under load.** At >256 uplinks inside the TTL window the oldest entries are
   `shift()`ed out before they expire, so a busy bridge loses echo entries early.

Additionally, **`mqttBrokerManager.handlePublish` has no echo suppression at all** (`:256-296`) —
there is no `matchesEcho` call on that path.

**Decision: add the explicit guard.** Per the "do not rely on it" rule, `detectOkToMqttViolation`
takes `localGatewayNodeNum` and sets `selfGateway`; a self-gateway reception is neither a violation
nor suspected. Fact 1 means the guard should essentially never fire in practice — which is exactly
what makes it a cheap, safe belt-and-braces check rather than a behavior change. It costs one integer
comparison per envelope and removes the entire class of "MeshMonitor flags itself" failure.

**Where `localGatewayNodeNum` comes from** — threaded through `MqttIngestionInput` exactly like
`topic`, because both call sites already know their own identity. No `sourceManagerRegistry` lookup
inside `mqttPacketLogService` (that would be a new coupling and a cycle risk):

| Call site | Value |
|---|---|
| `mqttBrokerManager.handlePublish` (`:272`) | `parseGatewayNodeNum(this.config.gateway.nodeId)` — `MqttBrokerConfig.gateway.nodeId`, `mqttBrokerManager.ts:30`, already used at `:150,163` |
| `mqttBridgeManager.handleDownlink` (`:698`) | `this.brokerGatewayNum` — `mqttBridgeManager.ts:283`, set from `localInfo.nodeNum >>> 0` at `:355`, reset to `null` at `:431` |

`null` is a legitimate value (broker not yet connected, no local node info). The guard then simply
does not apply and the predicate falls back to the plain `gatewayNodeNum !== fromNode` test — which
is still correct, and is where Fact 1 carries the load.

**If a self-echo is somehow still recorded** (guard `null` *and* echo window missed *and* a future
change starts rewriting `gatewayId`): the row is attributable and reversible — it names a specific
gateway with a specific `packetId` and `topic`, and the durable table's own retention will age it
out. It is not silently destructive. Test coverage: §4.5 and §4.2.

**How a violation surfaces on a grouped list row.** `getGroupedPackets`
(`mqttPacketLog.ts:138-169`) groups by `(sourceId, fromNode, COALESCE(NULLIF(packetId,0), -id))`,
collapsing every gateway's reception of one packet into one row. The new aggregate
`MAX(okToMqttViolation)` therefore means **"at least one gateway violated the bit for this packet"**
— exactly the Phase 2 badge semantic. Per-gateway attribution lives in `getReceptions` (`:200-214`),
a bare `.select()` that picks up the new columns with no projection change. `MAX(bitfield)` is added
alongside and is exact (see §2(c) point 4).

### 2(g) New settings keys

Added to `VALID_SETTINGS_KEYS` in `src/server/constants/settings.ts`, immediately after the existing
`mqtt_packet_log_*` block (`:103-105`):

| Key | Default (when unset/invalid) | Read by | Meaning |
|---|---|---|---|
| `mqtt_oktomqtt_violation_log_enabled` | **`'1'` (ON)** | `mqttPacketLogService.isViolationLogEnabled()` | kill switch for the durable violation write. Semantics: `=== '0'` ⇒ off; anything else (**including unset**) ⇒ on. Note this inverts the `mqtt_packet_log_enabled` convention (`=== '1'`) — deliberate, and must be commented at the constant and in the getter, because the feature must work on installs that never touched settings. |
| `mqtt_oktomqtt_violation_retention_days` | `90` | `getViolationRetentionDays()` | `parseInt`; must be finite and `> 0`, else default |
| `mqtt_oktomqtt_violation_max_count` | `50000` | `getViolationMaxCount()` | per-source cap; `parseInt`, finite and `> 0`, else default |

Both numeric getters follow `getMaxCount()`/`getMaxAgeHours()` verbatim
(`mqttPacketLogService.ts:91-101`); the boolean getter follows `isEnabled()` (`:76-84`) including a
5 s TTL cache and a `resetViolationEnabledCache()` test seam.

**Server-only check.** There is **no production `SERVER_ONLY_SETTINGS` constant** — it is a local
allowlist inside `src/server/server.settings-persistence.test.ts:405-432`, and it only guards keys
that **SettingsTab sends**. Phase 1 adds no SettingsTab field, so **no edit is required**, exactly as
the existing `mqtt_packet_log_*` keys are absent from it. **Trap for Phase 2/3:** if a UI toggle for
any of these three keys is added to `SettingsTab`, that test fails unless the key is either loaded by
`SettingsContext` *or* added to that allowlist. Record this in the epic doc.

**Cross-phase availability asymmetry — Phase 2's badge and Phase 3's report are gated differently.**
This is coherent but non-obvious, and Phase 2 must be told:

| Surface | Reads from | Gated on | Default install |
|---|---|---|---|
| Phase 3 Reports view | `mqtt_ok_to_mqtt_violations` | `mqtt_oktomqtt_violation_log_enabled` — **default ON** | **works** |
| Phase 2 Packet Monitor badge | `mqtt_packet_log` (via `getGroupedPackets`) | `mqtt_packet_log_enabled` — **default OFF** (opt-in, `mqttPacketLogService.ts:81`) | **badge never appears** |

So on an install that has never enabled the MQTT packet monitor, the Reports view can show
violations while the packet list shows no badge on any row — because there are no `mqtt_packet_log`
rows *at all*, not because the badge is broken. This follows directly from §2(d)'s decision to make
the durable write independent of the packet-log opt-in (the report would otherwise be empty on most
installs), and it is the right trade: the analysis surface works out of the box, the high-volume
reception log stays opt-in.

**Phase 2 requirement:** the packet-monitor empty state must explain that capture is opt-in and point
at `mqtt_packet_log_enabled` — otherwise a user who saw violations in Reports will read the missing
badge as a bug. The same asymmetry governs `includeUnknown` (§2(e)): suspected entries need the
packet log too, which is why the route returns `suspectedAvailable`. WP6 records this in the epic doc.

---

## 3. File-by-file changes

### 3.1 `src/server/utils/okToMqtt.ts` — **NEW**

Exports exactly the API in §2(a). Implementation notes:
- `readBitfieldOkToMqtt`: `typeof b !== 'number' || !Number.isFinite(b)` ⇒ `'unknown'`;
  `((b >>> 0) & 0x1) === 1 ? 'yes' : 'no'`.
- `resolveOkToMqttForEnvelope`: reproduce the `:482-499` control flow (see §2(a) table). Must **not**
  call `channelDecryptionService.isEnabled()`.
- `parseGatewayNodeNum`: moved verbatim from `mqttPacketLogService.ts:183-187`.
- `detectOkToMqttViolation`: sync; `bitfield = typeof d?.bitfield === 'number' ? d.bitfield >>> 0 : null`;
  `fromNode = typeof p?.from === 'number' ? p.from >>> 0 : null`;
  `gatewayNodeNum = parseGatewayNodeNum(envelope.gatewayId)`;
  `selfGateway = localGatewayNodeNum != null && gatewayNodeNum != null &&
  Number(gatewayNodeNum) === Number(localGatewayNodeNum)`; then §2(f)/§2(f.1). The JSDoc must state
  that `selfGateway` is the belt-and-braces guard and must **not** be removed in favour of the
  bridge's echo suppression (§2(f.1) Fact 2).
- No `any`. Full JSDoc citing firmware `MQTT::onSend` (MQTT.cpp:767-788) and issue #4114.

### 3.2 `src/db/schema/mqttPacketLog.ts` — **EDIT**

For each of the three table definitions, add three columns immediately after `payloadPreview` and
before `createdAt`:

```ts
// SQLite
/** Raw `Data.bitfield` (protobuf field 9). NULL = absent/undecryptable = ok_to_mqtt unknown (#4114). */
bitfield: integer('bitfield'),
/**
 * 0/1 integer, NOT a boolean column type — same load-bearing reason as `encrypted` above:
 * the grouped query does `MAX(okToMqttViolation)` and PostgreSQL has no MAX(boolean).
 * 1 ⇒ bit 0 was explicitly clear AND the publishing gateway is not the originator (#4114).
 */
okToMqttViolation: integer('okToMqttViolation').notNull().default(0),
/** Raw MQTT topic this reception arrived on. Diagnostic (#4114). */
topic: text('topic'),

// PostgreSQL
bitfield: pgInteger('bitfield'),
okToMqttViolation: pgInteger('okToMqttViolation').notNull().default(0),
topic: pgText('topic'),

// MySQL
bitfield: myInt('bitfield'),
okToMqttViolation: myInt('okToMqttViolation').notNull().default(0),
topic: myVarchar('topic', { length: 512 }),
```

**Also fix the stale doc comment at `:53`** — it omits `'distance'`, which both
`MqttIngestOutcome` (`src/db/repositories/mqttPacketLog.ts:20`) and `mapOutcome`
(`mqttPacketLogService.ts:167-168`) emit:

```ts
/** 'ingested' | 'encrypted' | 'ignored' | 'geo-ignored' | 'distance' | 'unsupported-portnum' | 'decode-error'. */
```

### 3.3 `src/db/schema/mqttOkToMqttViolations.ts` — **NEW**

Three exports — `mqttOkToMqttViolationsSqlite`, `…Postgres`, `…Mysql` — with the columns from §2(d).
Import style copied from `src/db/schema/mqttPacketLog.ts:1-3`. File-header comment: what the table is,
why it is separate from `mqtt_packet_log` (retention immunity, §1.9), and that it holds **confirmed
violations only**.

### 3.4 `src/db/schema/index.ts` — **EDIT**

Add `export * from './mqttOkToMqttViolations.js';` next to line 23.

### 3.5 `src/db/activeSchema.ts` — **EDIT (5 spots)**

Mirror the `mqttPacketLog` wiring exactly:
1. `:58-59` import block → add the three new table exports.
2. `:194` `ActiveSchema` interface → `mqttOkToMqttViolations: any;` reusing the existing
   `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4114 matches the existing
   ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6` comment form
   (the same disable already exists at `:193` for #4124).
3. `:292` sqlite map, 4. `:350` postgres map, 5. `:408` mysql map.

### 3.6 `src/server/migrations/128_mqtt_oktomqtt_violations.ts` — **NEW**

Two parts, both idempotent, no destructive rebuild, no backfill.

```ts
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing, addColumnIfMissingPostgres, addColumnIfMissingMysql,
  createTableIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 128';
const PL = 'mqtt_packet_log';
const V  = 'mqtt_ok_to_mqtt_violations';
```

**SQLite** (`export const migration = { up, down }`):

```sql
-- part A
ALTER TABLE mqtt_packet_log ADD COLUMN bitfield INTEGER                       -- addColumnIfMissing
ALTER TABLE mqtt_packet_log ADD COLUMN okToMqttViolation INTEGER NOT NULL DEFAULT 0
ALTER TABLE mqtt_packet_log ADD COLUMN topic TEXT
-- part B
CREATE TABLE IF NOT EXISTS mqtt_ok_to_mqtt_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceId TEXT NOT NULL,
  packetId INTEGER, fromNode INTEGER, fromNodeId TEXT,
  gatewayId TEXT, gatewayNodeNum INTEGER,
  channelId TEXT, portnum INTEGER, portnumName TEXT,
  bitfield INTEGER, topic TEXT, rxTime INTEGER,
  timestamp INTEGER NOT NULL, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_ts ON mqtt_ok_to_mqtt_violations(sourceId, timestamp);
CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_gw_ts ON mqtt_ok_to_mqtt_violations(sourceId, gatewayNodeNum, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mqtt_v_dedupe ON mqtt_ok_to_mqtt_violations(sourceId, packetId, fromNode, gatewayNodeNum);
```

`down(db)`: log-only, matching `125_…:43-45` ("column drops are destructive").

**PostgreSQL** — `export async function runMigration128Postgres(client: import('pg').PoolClient): Promise<void>`
(typed as migration 121 does — **no `any`, no eslint-disable**):

```ts
await addColumnIfMissingPostgres(client, PL, 'bitfield', '"bitfield" INTEGER');
await addColumnIfMissingPostgres(client, PL, 'okToMqttViolation', '"okToMqttViolation" INTEGER NOT NULL DEFAULT 0');
await addColumnIfMissingPostgres(client, PL, 'topic', '"topic" TEXT');
await client.query(`CREATE TABLE IF NOT EXISTS ${V} (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "sourceId" TEXT NOT NULL,
  "packetId" BIGINT, "fromNode" BIGINT, "fromNodeId" TEXT,
  "gatewayId" TEXT, "gatewayNodeNum" BIGINT,
  "channelId" TEXT, portnum INTEGER, "portnumName" TEXT,
  bitfield INTEGER, topic TEXT, "rxTime" BIGINT,
  "timestamp" BIGINT NOT NULL, "createdAt" BIGINT NOT NULL
)`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_ts ON ${V}("sourceId","timestamp")`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_gw_ts ON ${V}("sourceId","gatewayNodeNum","timestamp")`);
await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mqtt_v_dedupe ON ${V}("sourceId","packetId","fromNode","gatewayNodeNum")`);
```

**MySQL** — `export async function runMigration128Mysql(pool: import('mysql2/promise').Pool): Promise<void>`:

```ts
await addColumnIfMissingMysql(pool, PL, 'bitfield', 'bitfield INT');
await addColumnIfMissingMysql(pool, PL, 'okToMqttViolation', 'okToMqttViolation INT NOT NULL DEFAULT 0');
await addColumnIfMissingMysql(pool, PL, 'topic', 'topic VARCHAR(512)');
await createTableIfMissingMysql(pool, V, `CREATE TABLE ${V} (
  id SERIAL PRIMARY KEY,
  sourceId VARCHAR(255) NOT NULL,
  packetId BIGINT, fromNode BIGINT, fromNodeId VARCHAR(16),
  gatewayId VARCHAR(32), gatewayNodeNum BIGINT,
  channelId VARCHAR(64), portnum INT, portnumName VARCHAR(48),
  bitfield INT, topic VARCHAR(512), rxTime BIGINT,
  timestamp BIGINT NOT NULL, createdAt BIGINT NOT NULL,
  INDEX idx_mqtt_v_source_ts (sourceId, timestamp),
  INDEX idx_mqtt_v_source_gw_ts (sourceId, gatewayNodeNum, timestamp),
  UNIQUE KEY idx_mqtt_v_dedupe (sourceId, packetId, fromNode, gatewayNodeNum)
)`);
```

(Indexes are inline in the `CREATE`, per the helpers doc-block, so `createIndexIfMissingMysql` is
not needed here.)

### 3.7 `src/db/migrations.ts` — **EDIT**

Append after the 127 block (`:2009-2023`), following the recipe exactly:

```ts
// Migration 128: `ok_to_mqtt` violation detection (#4114) — adds bitfield /
// okToMqttViolation / topic to `mqtt_packet_log`, plus the retention-immune
// `mqtt_ok_to_mqtt_violations` history table.
import { migration as mqttOkToMqttViolationsMigration, runMigration128Postgres, runMigration128Mysql }
  from '../server/migrations/128_mqtt_oktomqtt_violations.js';   // (import at top, with the others)

registry.register({
  number: 128,
  name: 'mqtt_oktomqtt_violations',
  settingsKey: 'migration_128_mqtt_oktomqtt_violations',
  sqlite: (db) => mqttOkToMqttViolationsMigration.up(db),
  postgres: (client) => runMigration128Postgres(client),
  mysql: (pool) => runMigration128Mysql(pool),
});
```

`src/db/migrations.test.ts` needs **no edit**.

### 3.8 `src/db/repositories/mqttOkToMqttViolations.ts` — **NEW**

`export class MqttOkToMqttViolationsRepository extends BaseRepository`. Every read passes through
`this.normalizeBigInts(...)`.

```ts
export interface DbMqttOkToMqttViolation {
  id?: number;
  sourceId: string;                 // required on writes
  packetId?: number | null;
  fromNode?: number | null;
  fromNodeId?: string | null;
  gatewayId?: string | null;
  gatewayNodeNum?: number | null;
  channelId?: string | null;
  portnum?: number | null;
  portnumName?: string | null;
  bitfield?: number | null;
  topic?: string | null;
  rxTime?: number | null;
  timestamp: number;
  createdAt: number;
}

export type ViolationGatewaySort = 'violationCount' | 'lastSeen' | 'distinctOriginators' | 'gatewayId';
export type ViolationListSort    = 'timestamp' | 'fromNode' | 'gatewayId';

export interface ViolationRangeQuery {
  sourceIds: string[];              // explicit cross-source set; [] ⇒ empty result
  since: number;                    // ms epoch, inclusive
  until: number;                    // ms epoch, inclusive
  gatewayId?: string;
  limit?: number;
  offset?: number;
}

export interface MqttViolationGateway {
  gatewayId: string | null;
  gatewayNodeNum: number | null;
  violationCount: number;
  distinctOriginators: number;
  firstSeen: number;
  lastSeen: number;
}

class MqttOkToMqttViolationsRepository extends BaseRepository {
  async insertViolation(v: DbMqttOkToMqttViolation): Promise<void>;
  async getGatewaySummary(q: ViolationRangeQuery & { sort?: ViolationGatewaySort; dir?: 'asc'|'desc' }): Promise<MqttViolationGateway[]>;
  async getGatewaySummaryCount(q: ViolationRangeQuery): Promise<number>;
  async getGatewaySourceIds(q: ViolationRangeQuery): Promise<Array<{ gatewayId: string; sourceId: string }>>;
  async getViolations(q: ViolationRangeQuery & { sort?: ViolationListSort; dir?: 'asc'|'desc' }): Promise<DbMqttOkToMqttViolation[]>;
  async getViolationCount(q: ViolationRangeQuery): Promise<number>;
  async getRowCount(query?: { sourceId?: string }): Promise<number>;
  async deleteViolationsOlderThan(timestamp: number, sourceId?: string): Promise<number>;
  async trimViolationsToCount(sourceId: string, maxCount: number): Promise<number>;
  async getViolationSourceIds(): Promise<string[]>;
  async deleteAllViolations(sourceId?: string): Promise<number>;
}
```

Implementation rules:
- `insertViolation` throws `new Error('MqttOkToMqttViolationsRepository.insertViolation requires a sourceId')`
  when `!v.sourceId` (mirrors `insertPacket`, `mqttPacketLog.ts:100-102`). Dedupe branch:
  `this.dbType === 'mysql' ? …onDuplicateKeyUpdate({ set: { timestamp: sql\`timestamp\` } }) : …onConflictDoNothing()`.
- **Every cross-source method guards `if (q.sourceIds.length === 0) return [] / 0;`** before building
  an `inArray` (an empty `inArray` is a dialect-dependent hazard). Then
  `inArray(t.sourceId, q.sourceIds)`, `gte(t.timestamp, q.since)`, `lte(t.timestamp, q.until)`,
  optional `eq(t.gatewayId, q.gatewayId)`.
- Single-source methods (`getRowCount`, `trimViolationsToCount`, `deleteAllViolations`,
  `deleteViolationsOlderThan` with a `sourceId`) use `this.withSourceScope(t, sourceId)` /
  `eq(t.sourceId, sourceId)` exactly as `MqttPacketLogRepository` does.
- `getGatewaySummary`: `.groupBy(t.gatewayId)` with
  `gatewayNodeNum: sql\`MAX(${t.gatewayNodeNum})\``, `violationCount: sql\`COUNT(*)\``,
  `distinctOriginators: sql\`COUNT(DISTINCT ${t.fromNode})\``, `firstSeen: sql\`MIN(${t.timestamp})\``,
  `lastSeen: sql\`MAX(${t.timestamp})\``. **Single-argument `COUNT(DISTINCT …)` only** — MySQL rejects
  the multi-arg form (comment at `mqttPacketLog.ts:174-175`). `sourceId` must **not** be selected
  ungrouped (MySQL `ONLY_FULL_GROUP_BY`); the per-gateway `sourceIds` array is assembled by the route
  from `getGatewaySourceIds` (a `selectDistinct({ gatewayId, sourceId })` over the same filters).
  ORDER BY is built from the whitelisted `sort`/`dir`, never from raw user input.
- `getGatewaySummaryCount`: subquery-over-grouped, copied from `getGroupedPacketCount`
  (`mqttPacketLog.ts:177-189`).
- `trimViolationsToCount`: copy `trimPacketsToCount` (`:269-289`) verbatim, substituting the table.

### 3.9 `src/db/repositories/mqttPacketLog.ts` — **EDIT**

1. `DbMqttPacket` (`:24-50`) — add `bitfield?: number | null;`,
   `okToMqttViolation: number;  // 0 | 1`, `topic?: string | null;`.
2. `MqttGroupedPacket` (`:64-82`) — add `bitfield: number | null;  // representative (MAX) — exact:
   the field is the originator's` and `okToMqttViolation: number;  // MAX — 1 ⇒ at least one gateway violated`.
3. `getGroupedPackets` projection (`:143-161`) — add, **before** `gatewayCount`:
   ```ts
   bitfield: sql<number | null>`MAX(${t.bitfield})`,
   okToMqttViolation: sql<number>`MAX(${t.okToMqttViolation})`,
   ```
   (Both are aggregates ⇒ `ONLY_FULL_GROUP_BY`-safe and PG-safe. `topic` is deliberately **not**
   projected onto the grouped row — it is per-reception and reachable via `getReceptions`.)
4. Two new methods powering `includeUnknown` (§2(e)):
   ```ts
   /** Suspected ok_to_mqtt violations (#4114): relayed receptions whose bit was unreadable.
    *  Bounded by this table's retention window — see MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(e). */
   async getSuspectedViolations(q: {
     sourceIds: string[]; since: number; until: number; gatewayId?: string;
     limit?: number; offset?: number;
   }): Promise<DbMqttPacket[]>;
   async getSuspectedViolationGateways(q: { sourceIds: string[]; since: number; until: number }):
     Promise<Array<{ gatewayId: string | null; gatewayNodeNum: number | null;
                     suspectedCount: number; distinctOriginators: number;
                     firstSeen: number; lastSeen: number }>>;
   ```
   Predicate for both: `inArray(sourceId, sourceIds)` (with the empty-array guard),
   `isNull(t.bitfield)`, `isNotNull(t.gatewayNodeNum)`, `isNotNull(t.fromNode)`,
   `sql\`${t.gatewayNodeNum} <> ${t.fromNode}\``, `gte(t.timestamp, since)`, `lte(t.timestamp, until)`.

### 3.10 `src/db/repositories/index.ts` — **EDIT**

Add `export { MqttOkToMqttViolationsRepository } from './mqttOkToMqttViolations.js';` plus its
types, next to the `MqttPacketLogRepository` export (`:86`).

### 3.11 `src/services/database.ts` — **EDIT (3 spots)**

Mirroring `mqttPacketLogRepo` exactly:
1. `:485` neighbourhood — `public mqttOkToMqttViolationsRepo: MqttOkToMqttViolationsRepository | null = null;`
2. `:673-676` neighbourhood — getter:
   ```ts
   get mqttOkToMqttViolations(): MqttOkToMqttViolationsRepository {
     if (!this.mqttOkToMqttViolationsRepo) throw new Error('Database not initialized');
     return this.mqttOkToMqttViolationsRepo;
   }
   ```
3. `:922` neighbourhood —
   `this.mqttOkToMqttViolationsRepo = new MqttOkToMqttViolationsRepository(drizzleDb, this.drizzleDbType);`

(No `*Async` façade methods are added — the packet-monitor family is accessed through the repo
property, e.g. `databaseService.mqttPacketLog.getGroupedPackets(...)`, and this follows that.)

### 3.12 `src/server/mqttIngestion.ts` — **EDIT (3 spots)**

1. `MqttIngestionInput` (`:134-146`) — add two **optional** fields so no existing caller/test breaks:
   ```ts
   /** Raw MQTT topic this envelope arrived on. Diagnostic; persisted on the packet log (#4114). */
   topic?: string;
   /**
    * This source's OWN gateway node number, used by the self-echo guard so MeshMonitor can
    * never flag itself as a violating gateway (#4114, §2(f.1)). `null`/omitted when the
    * source has no local identity yet — the guard then simply does not apply.
    */
   localGatewayNodeNum?: number | null;
   ```
2. `:190-205` — the bitfield preservation of §2(b).
3. `:589` — `void mqttPacketLogService.logEnvelope(input.sourceId, input.envelope, result,
   input.topic, input.localGatewayNodeNum);`

### 3.13 `src/server/mqttBrokerManager.ts` — **EDIT (1 spot)**

At `:272-276`, add to the `ingestServiceEnvelope({ … })` object:
```ts
topic: msg.topic,
localGatewayNodeNum: parseGatewayNodeNum(this.config.gateway.nodeId),
```
`MqttBrokerConfig.gateway.nodeId` is declared at `:30` and already read at `:150,163`. Import
`parseGatewayNodeNum` from `./utils/okToMqtt.js`. Hoist the parse to a memoised private field if the
per-publish `parseInt` shows up in profiling — not required for correctness.

### 3.14 `src/server/mqttBridgeManager.ts` — **EDIT (2 spots)**

1. `:482-499` — the evaluator refactor of §2(a); add
   `import { allowsUplink, resolveOkToMqttForEnvelope } from './utils/okToMqtt.js';`.
2. `:698-702` — add to the `ingestServiceEnvelope({ … })` object:
   ```ts
   topic,                                        // handleDownlink(topic, …) param, in scope at :643
   localGatewayNodeNum: this.brokerGatewayNum,   // :283, set from localInfo.nodeNum at :355
   ```
   `brokerGatewayNum` is `null` before the broker reports local node info and is reset to `null` at
   `:431` — both are legitimate, see §2(f.1).

### 3.15 `src/server/services/mqttPacketLogService.ts` — **EDIT**

1. Delete the local `parseGatewayNodeNum` (`:183-187`); import it from `../utils/okToMqtt.js`.
2. `buildMqttPacketLogRow` (`:203-244`) — new signature and three new row fields:
   ```ts
   export function buildMqttPacketLogRow(
     sourceId: string,
     envelope: ServiceEnvelopeShape,
     result: MqttIngestionResult,
     topic?: string,
     evaluated?: OkToMqttViolationEval,   // pass the already-computed eval to avoid recompute
   ): DbMqttPacket | null
   ```
   ```ts
   const v = evaluated ?? detectOkToMqttViolation(envelope);   // caller always passes it
   // …
   bitfield: v.bitfield,
   okToMqttViolation: v.isViolation ? 1 : 0,
   topic: topic ?? null,
   ```
   The `evaluated` parameter is how the self-echo guard reaches the row: `logEnvelope` computes the
   eval **once** with `localGatewayNodeNum` and passes it in, so `buildMqttPacketLogRow`'s own
   fallback (which has no local identity) is only ever hit by direct unit-test calls.
3. New exported pure projection:
   ```ts
   /** Project a packet-log row onto the durable violation row. Same source of truth ⇒ they
    *  can never disagree. Caller has already established row.okToMqttViolation === 1. */
   export function buildViolationRow(row: DbMqttPacket): DbMqttOkToMqttViolation
   ```
   Copies `sourceId, packetId, fromNode, fromNodeId, gatewayId, gatewayNodeNum, channelId,
   portnum, portnumName, bitfield, topic, rxTime, timestamp, createdAt`.
4. `logEnvelope` (`:109-123`) — the body in §2(d). Signature gains
   `topic?: string, localGatewayNodeNum?: number | null`.
5. Settings: `isViolationLogEnabled()` + `resetViolationEnabledCache()` (clone `:76-89`, **but the
   default-on inversion of §2(g)**), `getViolationRetentionDays()`, `getViolationMaxCount()`
   (clone `:91-101`), and matching `DEFAULT_VIOLATION_RETENTION_DAYS = 90`,
   `DEFAULT_VIOLATION_MAX_COUNT = 50000` fields.
6. `runCleanup()` (`:51-69`) — second phase per §2(d). Same try/catch, same `logger.debug` summary
   line (extended to mention violations removed).
7. Thin pass-throughs for the routes:
   ```ts
   async getViolationGatewaySummary(q): Promise<MqttViolationGateway[]>
   async getViolationGatewaySummaryCount(q): Promise<number>
   async getViolationGatewaySourceIds(q): Promise<Array<{gatewayId: string; sourceId: string}>>
   async getViolations(q): Promise<DbMqttOkToMqttViolation[]>
   async getViolationCount(q): Promise<number>
   async getSuspectedViolations(q): Promise<DbMqttPacket[]>
   async getSuspectedViolationGateways(q): Promise<…>
   ```
   (Each delegates to the corresponding repo method — same style as `:125-143`.)

### 3.16 `src/server/constants/settings.ts` — **EDIT**

Three keys per §2(g), added after `:105`, with a comment referencing #4114 and calling out the
default-ON inversion.

### 3.17 `src/server/routes/analysisRoutes.ts` — **EDIT**

**Reuse check (verified).** `analysisRoutes.ts` declares exactly three module-level helpers —
`parseSourcesParam` (`:54`), `clampPageSize` (`:59`), `parseSinceMs` (`:65`). There is **no**
`parseUntilMs`, `parseLookbackDays`, or `parseBoolParam` under those or any similar name, so the
three below are genuinely new. Reuse `parseSourcesParam`, `clampPageSize`, and `parseSinceMs` as-is.

**One near-duplicate to be aware of, deliberately NOT refactored:** the solar handlers inline an
anonymous lookback parser twice (`:298-302` and `:379-383`). It differs from `parseLookbackDays`
below in both the query-param name (`lookback_days`, snake_case) and the clamp (**1..90**, vs 1..365
here). Do **not** unify them in this phase — changing the solar endpoints' clamp or param name is an
unrelated behavior change. To avoid a third convention, `parseLookbackDays` accepts **both**
`lookbackDays` and `lookback_days` spellings; the handler passes
`req.query.lookbackDays ?? req.query.lookback_days`.

Add near the existing helpers (`:54-68`):

```ts
function parseUntilMs(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}
function parseLookbackDays(raw: unknown): number {
  const n = parseInt(String(raw ?? '7'), 10);
  if (!Number.isFinite(n)) return 7;
  return Math.min(Math.max(n, 1), 365);
}
function parseBoolParam(raw: unknown): boolean {
  return raw === 'true' || raw === '1';
}
const VIOLATION_GATEWAY_SORTS = ['violationCount','lastSeen','distinctOriginators','gatewayId'] as const;
const VIOLATION_LIST_SORTS    = ['timestamp','fromNode','gatewayId'] as const;
```

Then the two handlers of §2(e). Both:
1. `const permitted = await resolvePermittedSourceIds(req, 'packetmonitor');`
2. intersect with `parseSourcesParam(req.query.sources)` using the existing idiom;
3. resolve `since` (explicit `since`, else `Date.now() - lookbackDays * 86_400_000`) and `until`;
   `since > until` ⇒ `fail(res, 400, 'INVALID_RANGE', …)`;
4. validate `sort`/`dir` against the whitelist ⇒ `fail(res, 400, 'INVALID_SORT_FIELD', …)` /
   `'INVALID_SORT_DIRECTION'`;
5. short-circuit `sourceIds.length === 0` to an empty payload via `ok(...)` (200);
6. query the durable repo; when `includeUnknown`, also query the suspected path — but **only when
   `await mqttPacketLogService.isEnabled()`**, otherwise set `suspectedAvailable: false` and skip it;
7. for `/gateways`, merge the suspected per-gateway counts into the confirmed rows by `gatewayId`
   (gateways present only in the suspected set appear with `violationCount: 0`), then sort/paginate
   the merged list **in the handler** (both inputs are already bounded by `limit`-free aggregate
   queries over an indexed range; cap the pre-merge fetch at 2000 rows per side);
8. attach `sourceIds` per gateway from `getViolationGatewaySourceIds`;
9. `ok(res, payload)`; `catch` ⇒ `logger.error(...)` + `fail(res, 500, 'MQTT_VIOLATIONS_FETCH_FAILED', …)`.

Node display names are **not** resolved in Phase 1 (`gatewayLongName` is out of the response until a
phase needs it) — keep the handler free of the N-source `getAllNodes` scan.

---

## 4. Test plan

All standard Vitest suites. **No standalone scripts.** Mocks of async DB methods use
`mockResolvedValue`.

> **Multi-backend warning:** the PG/MySQL suites are `describe.skipIf(!postgresAvailable)` /
> `!mysqlAvailable` and **skip silently** with nothing on `localhost:5433` / `localhost:3307`.
> Before claiming migration/schema work verified, start both containers (recipe in `CLAUDE.md`) and
> confirm coverage via `numPendingTests` in the JSON reporter, not just `success`.

### 4.1 `src/server/migrations/128_mqtt_oktomqtt_violations.test.ts` — **NEW**

Template: `121_mqtt_packet_log.test.ts`.
- **SQLite:** run `121`'s `migration.up(db)` first (so `mqtt_packet_log` exists), then `128`.
  - creates `mqtt_ok_to_mqtt_violations`; **second `up()` does not throw** (idempotency);
  - all three new `mqtt_packet_log` columns present (`PRAGMA table_info`), and re-running does not
    throw ("duplicate column" swallowed);
  - full round-trip insert/read of a violation row;
  - **dedupe:** inserting the same `(sourceId, packetId, fromNode, gatewayNodeNum)` twice raises a
    UNIQUE constraint at the raw-SQL level (proving the index exists); the repo-level no-op is
    covered in 4.5.
- **PostgreSQL / MySQL:** `vi.fn()` mock client/pool; assert the expected statements were issued
  (`ADD COLUMN IF NOT EXISTS` ×3 for PG; `information_schema.COLUMNS` pre-checks + `information_schema.TABLES`
  pre-check for MySQL) and that the functions resolve without throwing.

### 4.2 `src/server/utils/okToMqtt.test.ts` — **NEW**

- `readBitfieldOkToMqtt`: `undefined`/`null`/`NaN`/`'1'` ⇒ `'unknown'`; `0` ⇒ `'no'`; `1` ⇒ `'yes'`;
  `2` ⇒ `'no'` (bit 0 clear, other bits set); `3` ⇒ `'yes'`; `0xffffffff` ⇒ `'yes'`.
- `resolveOkToMqttForEnvelope`: plaintext yes/no; plaintext-with-absent-bitfield **and no encrypted**
  ⇒ `'unknown'`; plaintext-with-absent-bitfield **and encrypted present** ⇒ decrypt attempted (assert
  `tryDecrypt` called with `(enc, id, from, channelHash)`); decrypt success with bitfield ⇒ mapped;
  decrypt success with non-numeric bitfield ⇒ `'unknown'`; decrypt failure ⇒ `'unknown'`; missing
  `id`/`from` ⇒ `'unknown'` with **no** `tryDecrypt` call.
- **`allowsUplink` fail-closed vs tri-state distinction** (the point of the extraction):
  `'yes'`⇒`true`, `'no'`⇒`false`, **`'unknown'`⇒`false`**, while the detector treats `'unknown'`
  as *suspected*, not *violation*.
- `parseGatewayNodeNum`: `'!aabbccdd'`⇒`0xaabbccdd`; `undefined`/`null`/`''`⇒`null`;
  `'aabbccdd'` (no `!`)⇒`null`; `'!zzzz'`⇒`null`; `'!ffffffff'`⇒`4294967295` (unsigned).
- `detectOkToMqttViolation` — **one case per row of the §2(f) table**, with two dedicated, explicitly
  named tests:
  - row 4: *"originator publishing its own packet must NOT flag, even with bit 0"*;
  - row 15 / §2(f.1): *"a gateway equal to our own localGatewayNodeNum must NOT flag, even with
    bit 0"* — assert `selfGateway === true`, `relayed === false`, `isViolation === false`,
    `isSuspected === false`. Plus the complements: `localGatewayNodeNum = null` ⇒ guard inert
    (falls back to the plain `gateway !== originator` test); `localGatewayNodeNum` set but not
    matching ⇒ normal violation still flags.

### 4.3 `src/server/mqttBridgeManager.test.ts` — **EXTEND**

Existing cases at `:1038-1101` and `:1103-1141` must pass **unmodified** (regression guard for the
refactor). Add:
- decoded present with `bitfield` absent **and** `encrypted` present ⇒ `tryDecrypt` is still called;
- `'unknown'` outcome ⇒ packet not uplinked **and** `uplinkOkToMqttDrops` incremented (assert via
  `getStatus()` / the counter surfaced at `:462`).

### 4.4 `src/server/mqttIngestion.bitfield.test.ts` — **NEW**

**Proves `bitfield` survives server-side decrypt** — the §2(b) regression guard.
- Mock `channelDecryptionService.isEnabled()` ⇒ `true` and `tryDecrypt` ⇒
  `{ success: true, portnum: PortNum.TEXT_MESSAGE_APP, payload, bitfield: 0, channelDatabaseId: 1 }`.
- Feed an envelope with `packet.encrypted` set and no `packet.decoded` through `ingestServiceEnvelope`.
- Assert `envelope.packet.decoded.bitfield === 0` afterwards, and that the row handed to
  `mqttPacketLogService.logEnvelope` carries `bitfield: 0`.
- Same with `bitfield: 1`, and with `bitfield` omitted from the decrypt result ⇒ row `bitfield: null`.
- Assert the plaintext path (no decrypt) still carries the wire `bitfield` through untouched.

### 4.5 `src/server/mqttPacketLogService.violations.test.ts` — **NEW**

- violation row **written while `mqtt_packet_log_enabled` is off** (the independence requirement);
- violation row **not** written when `mqtt_oktomqtt_violation_log_enabled === '0'`;
- violation row **not** written for originator-self-publish (`gatewayNodeNum === fromNode`, bit 0);
- **REQUIRED (§2(f.1)): an envelope whose `gatewayId` is our own local node must not produce a
  violation row.** Call `logEnvelope(sourceId, envelope, result, topic, OUR_NODE_NUM)` with
  `envelope.gatewayId = '!<OUR_NODE_NUM hex>'`, `bitfield: 0`, and a *different* `fromNode` (i.e.
  the shape of a genuine violation in every respect except that we are the gateway) — assert **zero**
  rows in `mqtt_ok_to_mqtt_violations`. This is the "MeshMonitor must never flag its own operator"
  guarantee and must fail loudly if the guard is ever removed.
  - Complement: the same envelope with `localGatewayNodeNum` omitted/`null` (the "echo window was
    missed **and** we have no local identity" worst case) **does** write a row — documenting the
    residual exposure rather than hiding it. Per §2(f.1) Fact 1 this remains unreachable in practice
    because the bridge republishes `p.payload` byte-for-byte and never rewrites `gatewayId`, so a
    real echo carries the *original* gateway's id; the assertion exists to pin that reasoning to a
    test so a future change to the uplink path breaks visibly here.
  - Complement: `localGatewayNodeNum` set but not matching ⇒ the row **is** written (guard does not
    over-suppress).
- violation row **not** written when `gatewayId` is malformed / `fromNode` is missing;
- unknown-bitfield relayed reception writes **no** violation row (only the packet-log row, when enabled);
- `buildViolationRow` field-for-field projection matches its `DbMqttPacket` source;
- duplicate `logEnvelope` of the same envelope results in **one** stored violation row
  (repo-level dedupe no-op, run against SQLite via `createTestDb()`);
- `runCleanup()` invokes **both** retention phases and uses the violation-specific cutoff/cap;
- **retention immunity:** after `mqttPacketLog.deletePacketsOlderThan(now)` +
  `deleteAllPackets()`, the violation rows are still present.

### 4.6 `src/server/services/mqttPacketLogService.buildRow.test.ts` — **EXTEND**

Row carries `bitfield`, `okToMqttViolation`, `topic`; `topic` omitted ⇒ `null`; `okToMqttViolation`
defaults to `0` for every pre-existing case (proving no existing assertion regresses).

### 4.7 `src/server/mqttPacketLogService.ingestHook.test.ts` — **EXTEND**

`logEnvelope` receives the `topic` threaded from `MqttIngestionInput`; a call with no `topic` still
works (optional field).

### 4.8 `src/db/repositories/mqttOkToMqttViolations.test.ts` — **NEW**

`createTestDb()` + `new MqttOkToMqttViolationsRepository(drizzleDb, 'sqlite')`, following
`mqttPacketLog.perSource.test.ts:8-56` for setup and a `makeViolation()` factory.
- `insertViolation` throws without `sourceId`;
- duplicate insert is a no-op (row count stays 1, first `timestamp` preserved);
- `getGatewaySummary` counts, `distinctOriginators`, `firstSeen`/`lastSeen`;
- every `sort` × `dir` combination orders correctly;
- `limit`/`offset` pagination; `getGatewaySummaryCount` ignores pagination;
- `since`/`until` range boundaries are **inclusive**;
- `gatewayId` filter on `getViolations`;
- **empty `sourceIds` ⇒ `[]` / `0` with no query executed**;
- `getGatewaySourceIds` pivots correctly for a gateway seen on two sources.

### 4.9 `src/db/repositories/mqttOkToMqttViolations.perSource.test.ts` — **NEW**

Source-isolation on **every** method: seed identical rows under `source-a` and `source-b`; assert
`getGatewaySummary`/`getViolations`/`getViolationCount`/`getRowCount`/`deleteViolationsOlderThan`/
`trimViolationsToCount`/`deleteAllViolations` never leak or delete across sources; assert
`getViolationSourceIds()` returns both.

### 4.10 `src/db/repositories/mqttPacketLog.grouping.test.ts` — **EXTEND**

- `MAX(okToMqttViolation)` surfaces on the grouped row: three gateway receptions of one packet, only
  one flagged ⇒ grouped row has `okToMqttViolation === 1`;
- none flagged ⇒ `0`;
- `MAX(bitfield)` surfaces, and is `null` when every reception's bitfield is `null`;
- `getReceptions` returns the per-reception `okToMqttViolation`/`bitfield`/`topic` (bare-select
  auto-pickup);
- `getSuspectedViolations` matches only `bitfield IS NULL AND gatewayNodeNum <> fromNode`, and
  excludes self-published and confirmed rows;
- `getSuspectedViolationGateways` aggregate shape.

### 4.11 `src/db/repositories/mqttPacketLog.perSource.test.ts` — **EXTEND**

Add `bitfield`, `okToMqttViolation`, `topic` to the existing `makePacket()` factory (`:15-44`) so the
new columns are exercised by the existing isolation assertions.

### 4.12 `src/server/routes/analysisRoutes.mqttViolations.test.ts` — **NEW**

**Uses `createRouteTestApp`.** Do **not** use the deprecated
`vi.mock('../../services/database.js')` monkey-patch, and do **not** modify the existing
`analysisRoutes.test.ts` (which is a legacy monkey-patch file; it converts opportunistically, not in
this phase).

```ts
harness = await createRouteTestApp({ mount: app => app.use('/', analysisRoutes) });
await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);
```

Cases:
- admin sees both sources; `limited` (granted on `sourceA` only) sees **only** `sourceA` rows — real
  SQL enforcement, seeded rows in both sources;
- anonymous / ungranted ⇒ 200 with `gateways: []`, `sources: []`;
- `?sources=` intersects with the permitted set and cannot widen it (request `sourceB` while granted
  only `sourceA` ⇒ empty);
- envelope shape is exactly `{ success: true, data: { … } }` (assert `res.body.data` is where the
  payload lives — the Phase 3 contract);
- `sort`/`dir` whitelist: valid values order the response; an unknown `sort` ⇒ 400 +
  `code: 'INVALID_SORT_FIELD'`;
- `since > until` ⇒ 400 + `code: 'INVALID_RANGE'`;
- `limit`/`offset` pagination and `total`;
- `lookbackDays` clamps to 1..365 and is ignored when `since` is explicit;
- `includeUnknown=false` (default) ⇒ `suspectedCount: 0` on every row and the packet-log path is not
  queried; `includeUnknown=true` with `mqtt_packet_log_enabled` off ⇒ `suspectedAvailable: false`;
  with it on ⇒ suspected rows merged and `kind: 'suspected'` on the packets endpoint;
- `/packets?gateway=!aabbccdd` filters to one gateway.

### 4.13 Files explicitly **not** affected

- `src/db/repositories/nodes.test.ts` — no `nodes` column is added, so the hand-written
  `POSTGRES_CREATE` / `MYSQL_CREATE` DDL blocks need no edit.
- `src/db/migrations.test.ts` — registry-derived assertions cover 128 automatically.
- `src/server/routes/mqttPacketRoutes.ts` and its tests — the cross-source surface lives in
  `analysisRoutes.ts` (epic decision 8).

---

## 5. Work packages

Six packages. File ownership is non-overlapping except where noted; where two packages touch the
same file the ordering is stated explicitly.

```
        ┌──────────────────────────────────────────────┐
WP1 ────┼──> WP3 ──┬──> WP4 ──┐                        │
        │          │          ├──> WP6 (verification)  │
WP2 ────┴──────────┴──> WP5 ──┘                        │
        └──────────────────────────────────────────────┘

PARALLEL: WP1 ∥ WP2      (no shared files, no shared symbols)
PARALLEL: WP4 ∥ WP5      (after WP3)
SEQUENTIAL: WP1 → WP3 → {WP4, WP5} → WP6 ;  WP2 → WP4
```

### WP1 — Schema, migration 128, registration, settings keys *(first; parallel with WP2)*

**Owns:** `src/db/schema/mqttOkToMqttViolations.ts` (new) · `src/db/schema/mqttPacketLog.ts` ·
`src/db/schema/index.ts` · `src/db/activeSchema.ts` · `src/server/migrations/128_mqtt_oktomqtt_violations.ts` (new) ·
`src/server/migrations/128_mqtt_oktomqtt_violations.test.ts` (new) · `src/db/migrations.ts` ·
`src/server/constants/settings.ts` · `src/db/repositories/mqttPacketLog.perSource.test.ts` (factory only).

**Scope:** §3.2–§3.7, §3.16, §4.1, §4.11. Includes the stale-comment fix at
`src/db/schema/mqttPacketLog.ts:53`.

**Depends on:** nothing.

**Acceptance:** `npx vitest run src/server/migrations/128_* src/db/migrations.test.ts` green;
migration 128 registered with `settingsKey: 'migration_128_mqtt_oktomqtt_violations'` and all three
dialect functions; migrations registry contiguity test green; PG/MySQL migration params typed as
`import('pg').PoolClient` / `import('mysql2/promise').Pool` with **no** `any` and **no** new
eslint-disable; `tsc --noEmit` green; `npm run lint:ci` shows no new in-repo `FAIL`.

### WP2 — Shared tri-state evaluator + detector + bridge refactor *(parallel with WP1)*

**Owns:** `src/server/utils/okToMqtt.ts` (new) · `src/server/utils/okToMqtt.test.ts` (new) ·
`src/server/mqttBridgeManager.ts` **(evaluator body at `:482-499` only — WP4 touches the call site at
`:698` afterwards)** · `src/server/mqttBridgeManager.test.ts`.

**Scope:** §2(a), §2(f), §2(f.1) detector guard, §3.1, §3.14 spot 1, §4.2, §4.3.

**Depends on:** nothing (no DB, no schema).

**Acceptance:** `npx vitest run src/server/utils/okToMqtt.test.ts src/server/mqttBridgeManager*`
green with the pre-existing `:1038-1141` cases **unmodified**; `evaluateOkToMqtt` is a two-liner over
`allowsUplink(await resolveOkToMqttForEnvelope(env))`; the §2(a) equivalence table has a test per row;
`detectOkToMqttViolation` has a test per row of the §2(f) table including **both** named cases
(originator-self-publish, and the §2(f.1) self-gateway guard with its two complements);
`tsc` + `lint:ci` clean.

### WP3 — Violations repository + `mqtt_packet_log` repo changes + DB wiring *(after WP1)*

**Owns:** `src/db/repositories/mqttOkToMqttViolations.ts` (new) ·
`src/db/repositories/mqttOkToMqttViolations.test.ts` (new) ·
`src/db/repositories/mqttOkToMqttViolations.perSource.test.ts` (new) ·
`src/db/repositories/mqttPacketLog.ts` · `src/db/repositories/mqttPacketLog.grouping.test.ts` ·
`src/db/repositories/index.ts` · `src/services/database.ts`.

**Scope:** §3.8–§3.11, §4.8–§4.10.

**Depends on:** WP1 (tables must exist in `activeSchema` and in the migration registry that
`createTestDb()` replays).

**Acceptance:** all three repo test files green; per-source isolation proven on every method; empty
`sourceIds` guarded; MySQL-safe aggregates only (single-arg `COUNT(DISTINCT …)`, no ungrouped
`sourceId` in the summary projection); `MAX(okToMqttViolation)`/`MAX(bitfield)` present in
`getGroupedPackets`; `databaseService.mqttOkToMqttViolations` resolves after init and throws
`'Database not initialized'` before; `tsc` + `lint:ci` clean.

### WP4 — Ingest plumbing, violation write, retention *(after WP1+WP2+WP3; parallel with WP5)*

**Owns:** `src/server/mqttIngestion.ts` · `src/server/mqttBrokerManager.ts` ·
`src/server/mqttBridgeManager.ts` **(call site at `:698` only — WP2 goes first on this file)** ·
`src/server/services/mqttPacketLogService.ts` ·
`src/server/mqttIngestion.bitfield.test.ts` (new) ·
`src/server/mqttPacketLogService.violations.test.ts` (new) ·
`src/server/services/mqttPacketLogService.buildRow.test.ts` ·
`src/server/mqttPacketLogService.ingestHook.test.ts`.

**Scope:** §2(b), §2(d) write path + retention, §2(f.1) `localGatewayNodeNum` threading,
§2(g) getters, §3.12–§3.15, §4.4–§4.7.

**Depends on:** WP2 (`detectOkToMqttViolation`, `parseGatewayNodeNum`), WP3 (the repo),
WP1 (the columns).

**Acceptance:** bitfield-survives-decrypt test green; violation written with the packet log disabled;
not written when the kill switch is `'0'`; not written for self-publish/malformed-gateway/unknown-bit;
**the §4.5 REQUIRED self-gateway test passes — an envelope gatewayed by our own local node produces
zero violation rows**; `localGatewayNodeNum` is threaded from **both** call sites
(`mqttBrokerManager.handlePublish` and `mqttBridgeManager.handleDownlink`) and the eval is computed
**once** in `logEnvelope`; duplicate ingest ⇒ one row; retention runs on the **existing** 15-minute
interval with **no new `setInterval`**; retention-immunity test green; `logEnvelope` still never
throws; `tsc` + `lint:ci` clean.

### WP5 — Cross-source analysis routes *(after WP3; parallel with WP4)*

**Owns:** `src/server/routes/analysisRoutes.ts` ·
`src/server/routes/analysisRoutes.mqttViolations.test.ts` (new).

**Scope:** §2(e), §3.17, §4.12. Must **not** modify the legacy `analysisRoutes.test.ts`.

**Depends on:** WP3. (It calls `mqttPacketLogService` pass-throughs added in WP4; to keep WP4∥WP5
truly parallel, WP5 may call `databaseService.mqttOkToMqttViolations.*` and
`databaseService.mqttPacketLog.*` **directly** from the handler — that is the pattern
`analysisRoutes.ts` already uses for `databaseService.analysis.*`. Prefer that and treat the WP4
service pass-throughs as optional convenience.)

**Acceptance:** route test file green using `createRouteTestApp`; the deprecated
`vi.mock('../../services/database.js')` pattern is absent from the new file; response bodies are
`{ success: true, data: {…} }` via `ok()` and every error path uses `fail()` with a SCREAMING_SNAKE
code; cross-source permission isolation proven by real SQL; `?sources=` cannot widen the permitted
set; `tsc` + `lint:ci` clean.

### WP6 — Full verification + doc close-out *(after all)*

**Owns:** `docs/internal/dev-notes/MQTT_OK_TO_MQTT_VIOLATIONS_EPIC.md` (Phase 1 checkbox +
"Deviations / notes"). No source files.

**Scope:**
1. Start the PG (`:5433`) and MySQL (`:3307`) containers per `CLAUDE.md`, then run the **full** suite:
   `npx vitest run --reporter=json` — confirm `success: true` **and** that `numPendingTests` reflects
   the multi-backend suites actually running (not silently skipped).
2. `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` ⇒ empty.
3. `npx tsc --noEmit` ⇒ clean.
4. Confirm no `eslint-baseline.json` rule count grew.
5. Record in the epic doc's "Deviations / notes" — these are cross-phase and user-facing, so they
   must survive outside this spec:
   a. **Forward-only, empty on upgrade (§2(d)).** No backfill is possible; both endpoints return
      empty until new MQTT traffic arrives after the upgrade. **Expected, not a bug** — say so in
      the epic doc so the user is not surprised, and so Phase 3's empty state can word itself
      accordingly.
   b. **Phase 2 / Phase 3 availability asymmetry (§2(g)).** The durable violation write is
      **default ON**, but the Phase 2 packet-list badge reads `mqtt_packet_log`, which is opt-in and
      **default OFF**. On a default install the Reports view works while the badge never appears.
      **Phase 2 must gate its badge on — and explain — `mqtt_packet_log_enabled` in its empty state.**
   c. **`includeUnknown` retention-window caveat (§2(e))** — suspected entries come from
      `mqtt_packet_log`, so they are bounded by its 24 h window and require the packet monitor to be
      enabled; Phase 3 must surface `suspectedAvailable` / `suspectedWindowMs` in the UI.
   d. **Self-echo guard (§2(f.1))** — `localGatewayNodeNum` exists because the bridge's echo
      suppression is topic-string + 60 s TTL + 256-entry ring and is therefore not airtight; do not
      remove the guard in a later phase on the belief that echo suppression covers it.
   e. **`SERVER_ONLY_SETTINGS` trap (§2(g))** for any Phase 2/3 SettingsTab toggle over the three
      new keys.
   f. **packetId-0 dedupe limitation (§2(d)).**

**Acceptance:** all four checks pass; epic doc updated; PR opened; `/ci-monitor` green.

---

## 6. Open risks

1. **`MAX(bitfield)` on a mixed group.** Argued exact in §2(c) (the field is the originator's and is
   identical in every gateway's copy). If a gateway ever rewrites it, `MAX` biases toward "opted in".
   The per-reception truth remains in `getReceptions`, and the violation flag is computed
   per-reception, so this can only understate — never fabricate — a violation. Acceptable.
2. **Suspected-row volume in the `includeUnknown` query.** Bounded by the packet log's own retention
   and by `limit`, but on a busy source the pre-merge fetch can still be large; the 2000-row cap in
   §3.17 step 7 is the guard. If Phase 3 finds it insufficient, push the merge into SQL rather than
   raising the cap.
3. **Kill-switch default inversion** (`!== '0'` rather than `=== '1'`). Deliberate and documented, but
   it is the one place in this feature where a reader's convention-based assumption is wrong. It must
   carry a comment at both the constant and the getter.
