# Implementation Spec — MeshCore Auto-Pathfinding Target Filtering (#4024)

**Branch:** `feature/meshcore-pathfinding-target-filter`
**Worktree:** `/home/yeraze/Development/meshmonitor-pathfinding-filter`
**Ships as:** one PR. Decisions in `MESHCORE_PATHFINDING_TARGET_FILTER_EPIC.md` are LOCKED.

This spec is the authoritative build order. Every claim below was grounded against
real signatures on this branch. Implementers MUST reuse the mechanisms named in
§1 rather than reinventing them.

---

## 0. Key architectural decisions (read first)

- **AND/OR classification (LOCKED, mirrors `getNodeNeedingTracerouteAsync`):**
  - **AND pre-filters** (narrow the pool, applied first): **last-heard**,
    **hop-range (pathLen)**, **signal (RSSI/SNR)**.
  - **OR-union identity filters** (select within the pool; a contact passes if it
    matches ANY enabled one): **specific-contact allowlist**, **name regex**.
  - Master `filterEnabled` off ⇒ no filtering (today's behavior — all companions +
    all repeaters). Master on but no OR sub-filter configured ⇒ every AND-survivor
    passes (`hasAnyOrFilter === false`, exactly like Auto-Traceroute).
  - One shared filter list covers both device-type sets: a contact is either a
    COMPANION (→ `discover_path`) or a REPEATER (→ `get_neighbours`), never both, so
    the same allowlist/attribute config is applied to both sets after the existing
    `pathDiscoveryEnabled`/`neighborsEnabled` toggles select them.

- **Route shape (DECISION): a NEW sibling route pair `GET/POST
  /automation/pathfinding/filter`**, NOT an extension of the existing
  `/automation/pathfinding` payload, and NOT `/targets` (the config is more than a
  target list). Justification:
  1. The existing `POST /automation/pathfinding` handler calls
     `mgr.startAutoPathfinding()` to rebuild the scheduler closure (interval/repeat
     live in that closure). The **filter config does not require a scheduler
     restart** — `executeRun()` will read the filter fresh on every tick (§3). A
     separate endpoint keeps the "restart scheduler" side-effect off the filter
     save path.
  2. It mirrors the Auto-Traceroute split, where filter settings have their own
     aggregation getter/setter (`get/setTracerouteFilterSettingsAsync`) distinct
     from the scheduler enable/interval keys.
  3. It keeps validation cohesive (RE2 regex compile + int/bool bounds) in one
     handler and lets the frontend save the filter independently of the scheduler
     panel. `/filter` (not `/targets`) because the payload carries the allowlist
     **and** the four attribute filters + their enable flags.

- **Signal filter semantics (DECISION):** `signalEnabled` is a single AND
  pre-filter with two independent thresholds `rssiMin` (dBm) and `snrMin` (dB).
  A contact `c` passes when **both** hold:
  `passesRssi = (rssiMin <= RSSI_FLOOR) || (c.rssi != null && c.rssi >= rssiMin)`
  and `passesSnr = (snrMin <= SNR_FLOOR) || (c.snr != null && c.snr >= snrMin)`.
  Sentinels `RSSI_FLOOR = -200`, `SNR_FLOOR = -100` make an unset threshold a
  no-op, giving the epic's "RSSI **and/or** SNR" behavior (configure either or
  both). A contact missing the metric a configured threshold targets is excluded.

---

## 1. Reuse inventory (MANDATORY — do not reinvent)

| Need | Reuse this (exact path) | Notes |
|------|-------------------------|-------|
| RE2-safe regex compile (backend) | `compileUserRegex(pattern, flags?)` — `src/utils/safeRegex.ts:25` | Import as `import { compileUserRegex } from '../utils/safeRegex.js'` (manager) / `'../../utils/safeRegex.js'`. Already imported in `database.ts:5`. Use flag `'i'`. |
| Allowlist repo template | `src/db/repositories/autoTraceroute.ts` (`AutoTracerouteRepository`) — `getAutoTracerouteNodes`/`setAutoTracerouteNodes` (L31–66) | New repo mirrors these two methods, keyed by `publicKey: string` instead of `nodeNum: number`. |
| Base repo helpers | `src/db/repositories/base.ts` — `this.tables`, `this.now()` (L259), `this.insertIgnore()` (L219), `this.isPostgres()/isMySQL()/getSqliteDb()` | New repo `extends BaseRepository`. `this.tables` is built by `buildActiveSchema(dbType)` (L67). |
| Aggregation getter/setter template | `getTracerouteFilterSettingsAsync` (`database.ts:5587`) / `setTracerouteFilterSettingsAsync` (`database.ts:5669`) | Copy the `read = (key) => this.settings.getSettingForSource(sourceId ?? null, key)` + `Promise.all` + `parseIntBounded` shape verbatim. |
| Per-source KV read | `this.settings.getSettingForSource(sourceId, key)` | Falls back to global when no per-source override. Used by scheduler already (`meshcoreManager.ts:5851`). |
| Per-source KV batch write | `this.settings.setSourceSettings(sourceId, kvRecord)` (batch) — see `database.ts:5712` | Setter writes all attribute KV in one call; allowlist via new repo. Single-key writes in routes use `setSourceSetting(sourceId, key, val)` (`meshcoreRoutes.ts:3042`). |
| Filter-logic reference (backend semantics) | `getNodeNeedingTracerouteAsync` (`database.ts:4759–4921`) | AND pre-filters L4790–4813; `hasAnyFilter` L4842–4847; OR union L4850–4891. Manager filter (§3) is the MeshCore analogue over `MeshCoreContact[]`. |
| Response envelope | `ok(res, data)` / `fail(res, status, code, msg)` — `src/server/utils/apiResponse.ts:15,31` | `meshcoreRoutes.ts` does NOT yet import these — add the import. `ok(res, x)` ⇒ `{success:true,data:x}`, which matches the frontend's `json.data` reads. Use `fail` for validation errors. |
| Route test harness | `createRouteTestApp()` — `src/server/test-helpers/routeTestApp.ts:126`; `RouteTestHarness` (L63) | Fields: `app, db, sourceA, sourceB, admin, limited, anonymous, loginAs(user?), grant(userId,resource,action,sourceId?), revokeAll, cleanup`. MANDATORY for new route tests. |
| Save bar | `useSaveBar({ id, sectionName, hasChanges, isSaving, onSave, onDismiss })` — used in `MeshCoreAutomationsView.tsx:130` | The filter panel piggybacks the existing view's save bar OR registers its own `id`. See §6. |
| CSRF fetch (frontend) | `useCsrfFetch()` — `MeshCoreAutomationsView.tsx:41` | The file already uses `csrfFetch`, NOT raw `fetch()`. New code MUST keep using `csrfFetch` (raw `fetch()` is ESLint-banned in `src/components/**`). |
| Contact fetch precedent | `MeshCoreTimerTriggersSection.tsx:160–181` (loads `/api/sources/${sourceId}/meshcore/contacts`, maps `data` → `{publicKey, name: advName ?? name ?? key.slice(0,16)}`) | Copy this loader shape for the contact checklist. |
| Live-preview useMemo + debounce | `AutoTracerouteSection.tsx:407–523` (`matchingNodes` useMemo + 1s `debouncedMatchingNodes`) | Re-implement client-side over `MeshCoreContact[]`; §6. |
| Permission middleware | `requirePermission('automation','read'|'write',{ sourceIdFrom:'params.id' })` + `optionalAuth()`/`requireAuth()` — `meshcoreRoutes.ts:2984,3019` | Reuse exactly. GET = `optionalAuth`+read, POST = `requireAuth`+write. |
| i18n | `t('meshcore.automation.pathfinding.*', 'Default string')` inline-default pattern | Keys resolve via inline default even if absent from `public/locales/en.json`. Add the new keys to `public/locales/en.json` (other locales fall back to defaults). |
| Contact type | `MeshCoreContact` — `meshcoreManager.ts:356` (`publicKey, advName?, name?, lastSeen?, lastAdvert?, rssi?, snr?, advType?, pathLen?`) | Filter fields come from here. `pathLen` null/undefined = OUT_PATH_UNKNOWN (unknown route). |

**No genuinely new mechanism is required.** Every layer has a direct precedent.

---

## 2. DB layer

### 2.1 New table `meshcore_pathfinding_targets`

One row per selected contact `publicKey` per `sourceId` (the OR allowlist). Model:
per-source MeshCore table, `sourceId NOT NULL` (all rows are source-scoped — there
is no legacy unscoped data, unlike `auto_traceroute_nodes`). Composite
`UNIQUE(sourceId, publicKey)`.

**Migration file:** `src/server/migrations/113_create_meshcore_pathfinding_targets.ts`
(next number after `112_add_notes_to_nodes`). Follow migration 110
(`110_add_meshcore_position_history.ts`) as the create-table template.

#### SQLite (`export const migration = { up, down }`)
```sql
CREATE TABLE IF NOT EXISTS meshcore_pathfinding_targets (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceId  TEXT NOT NULL,
  publicKey TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  UNIQUE(sourceId, publicKey)
);
CREATE INDEX IF NOT EXISTS meshcore_pathfinding_targets_source_idx
  ON meshcore_pathfinding_targets(sourceId);
```
`down`: `DROP TABLE IF EXISTS meshcore_pathfinding_targets`.

#### PostgreSQL (`runMigration113Postgres(client)`)
```sql
CREATE TABLE IF NOT EXISTS meshcore_pathfinding_targets (
  id        INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "sourceId"  TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT meshcore_pathfinding_targets_source_pk_uniq UNIQUE ("sourceId","publicKey")
);
CREATE INDEX IF NOT EXISTS meshcore_pathfinding_targets_source_idx
  ON meshcore_pathfinding_targets("sourceId");
```
(`CREATE TABLE IF NOT EXISTS` makes it idempotent; the inline `CONSTRAINT` is
created with the table so no separate `pg_constraint` guard is needed.)

#### MySQL (`runMigration113Mysql(pool)`)
Guard with `information_schema.TABLES` existence check (like migration 110 L86–91):
```sql
CREATE TABLE meshcore_pathfinding_targets (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sourceId  VARCHAR(255) NOT NULL,
  publicKey VARCHAR(64)  NOT NULL,
  createdAt BIGINT NOT NULL,
  UNIQUE KEY meshcore_pathfinding_targets_source_pk_uniq (sourceId, publicKey),
  INDEX meshcore_pathfinding_targets_source_idx (sourceId)
);
```

### 2.2 Registry registration — `src/db/migrations.ts`
Add import beside the migration-112 import (L129):
```ts
import { migration as meshcorePathfindingTargetsMigration,
         runMigration113Postgres as runMeshcorePathfindingTargetsPostgres,
         runMigration113Mysql as runMeshcorePathfindingTargetsMysql }
  from '../server/migrations/113_create_meshcore_pathfinding_targets.js';
```
Register after the migration-112 block (after L1784):
```ts
registry.register({
  number: 113,
  name: 'create_meshcore_pathfinding_targets',
  settingsKey: 'migration_113_create_meshcore_pathfinding_targets',
  sqlite: (db) => meshcorePathfindingTargetsMigration.up(db),
  postgres: (client) => runMeshcorePathfindingTargetsPostgres(client),
  mysql: (pool) => runMeshcorePathfindingTargetsMysql(pool),
});
```

### 2.3 Count test — `src/db/migrations.test.ts`
This file has **no hardcoded `112` literal**; it asserts contiguity/count
dynamically:
- `all[all.length - 1].number).toBe(all.length)` (L19),
- `all[i].number).toBe(i + 1)` for every i (L31–32),
- unique names (L26).

**Action:** adding a contiguous `number: 113` with a unique name satisfies these
automatically. Add/adjust any per-file test that enumerates a hardcoded latest
name if one exists (none found in `migrations.test.ts`). **Still run the full
suite** to confirm no other test hardcodes the count (e.g. an `activeSchema` or
`schemaSync` test) after adding the schema in §2.5.

### 2.4 Repository — `src/db/repositories/meshcorePathfindingTargets.ts` (NEW)
Mirror `AutoTracerouteRepository` (allowlist half only — no log table). All async.
```ts
import { eq, and, asc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export class MeshcorePathfindingTargetsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) { super(db, dbType); }

  /** All selected target publicKeys for a source, ordered by createdAt asc. */
  async getTargets(sourceId: string): Promise<string[]>;

  /** Replace the whole allowlist for a source (delete-then-insert). */
  async setTargets(publicKeys: string[], sourceId: string): Promise<void>;
}
```
- `getTargets`: `select({publicKey}).from(this.tables.meshcorePathfindingTargets)
  .where(eq(t.sourceId, sourceId)).orderBy(asc(t.createdAt))` → `rows.map(r => String(r.publicKey))`.
- `setTargets`: `delete` where `sourceId`, then loop `insert().values({ sourceId, publicKey, createdAt: this.now() })`. De-dupe input first (`[...new Set(publicKeys)]`). `sourceId` is required (no unscoped path).

### 2.5 Schema — `src/db/schema/misc.ts` + `src/db/activeSchema.ts`
Add three table defs to `misc.ts` (beside `autoTracerouteNodes*`, L209–223 / L441):
```ts
export const meshcorePathfindingTargetsSqlite = sqliteTable('meshcore_pathfinding_targets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  publicKey: text('publicKey').notNull(),
  createdAt: integer('createdAt').notNull(),
});
export const meshcorePathfindingTargetsPostgres = pgTable('meshcore_pathfinding_targets', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  publicKey: pgText('publicKey').notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});
export const meshcorePathfindingTargetsMysql = mysqlTable('meshcore_pathfinding_targets', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 255 }).notNull(),
  publicKey: myVarchar('publicKey', { length: 64 }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});
```
Register in `activeSchema.ts` in all three spots (mirror `autoTracerouteNodes` at
L66/281/337/393 and the `ActiveSchema` type at L193): add `meshcorePathfindingTargets: any;`
to the type, and `meshcorePathfindingTargets: meshcorePathfindingTargets<Backend>,`
to each of the SQLite/Postgres/MySQL maps, importing the three symbols at L66-67.

### 2.6 DatabaseService wiring — `src/services/database.ts`
Mirror `autoTracerouteRepo` wiring (L52 import, L533 field, L628 getter, L1001 init):
- Import `MeshcorePathfindingTargetsRepository`.
- Field `public meshcorePathfindingTargetsRepo: MeshcorePathfindingTargetsRepository | null = null;`
- Getter `get meshcorePathfindingTargets(): MeshcorePathfindingTargetsRepository { if (!this.meshcorePathfindingTargetsRepo) throw new Error('Database not initialized'); return this.meshcorePathfindingTargetsRepo; }`
- Init in the same block as L1001:
  `this.meshcorePathfindingTargetsRepo = new MeshcorePathfindingTargetsRepository(drizzleDb, this.drizzleDbType);`

### 2.7 Aggregation getter/setter — `src/services/database.ts`
Add beside the traceroute pair (after L5667/L5739). `sourceId` is **required**
here (MeshCore managers always have a `sourceId`).

**FilterSettings shape** (shared conceptually with the frontend TS interface, §6):
```ts
interface MeshcorePathfindingFilterSettings {
  enabled: boolean;              // master
  targetKeys: string[];          // allowlist (table-backed)
  contactsEnabled: boolean;      // OR: allowlist sub-filter enable
  regexEnabled: boolean;         // OR: name-regex enable
  nameRegex: string;             // regex value (default '.*')
  lastHeardEnabled: boolean;     // AND
  lastHeardHours: number;        // AND value (default 168)
  hopsEnabled: boolean;          // AND
  hopsMin: number;               // default 0
  hopsMax: number;               // default 10
  signalEnabled: boolean;        // AND
  rssiMin: number;               // dBm, default -200 (no-op)
  snrMin: number;                // dB,  default -100 (no-op)
}
```
```ts
async getMeshcorePathfindingFilterSettingsAsync(sourceId: string): Promise<MeshcorePathfindingFilterSettings>;
async setMeshcorePathfindingFilterSettingsAsync(sourceId: string, settings: Partial<MeshcorePathfindingFilterSettings> & { targetKeys: string[] }): Promise<void>;
```
- **Getter:** `targetKeys = await this.meshcorePathfindingTargets.getTargets(sourceId)`;
  read every KV via `read = (k) => this.settings.getSettingForSource(sourceId, k)` in
  one `Promise.all`; parse booleans as `=== 'true'` (enables default OFF) and the
  master + attribute enables default OFF; ints via a local `parseIntBounded`
  (copy `database.ts:5640`). `nameRegex` default `'.*'`. Bounds:
  `lastHeardHours` (1..8760, def 168), `hopsMin` (0..10, def 0), `hopsMax`
  (0..10, def 10), `rssiMin` (-200..0, def -200), `snrMin` (-100..100, def -100).
- **Setter:** build a `Record<string,string>` KV of only the provided fields,
  `await this.settings.setSourceSettings(sourceId, kv)`, then
  `await this.meshcorePathfindingTargets.setTargets(settings.targetKeys, sourceId)`.

---

## 3. Manager — `src/server/meshcoreManager.ts`

Target: the `executeRun` closure inside `startAutoPathfinding()` (L5878–5945),
specifically the `companions`/`repeaters`/`targets` build at L5890–5905.

### 3.1 Filter function (module-scope helper, exported for unit test)
Add a pure, exported function near the top of the module (after the
`MeshCoreContact` interface, ~L378) so the filter-logic test (§7) can import it
without constructing a manager:
```ts
export const MC_PF_RSSI_FLOOR = -200;
export const MC_PF_SNR_FLOOR = -100;

export function filterPathfindingContacts(
  contacts: MeshCoreContact[],
  cfg: MeshcorePathfindingFilterSettings,   // import type from database service
  nowMs: number = Date.now(),
): MeshCoreContact[] {
  if (!cfg.enabled) return contacts;

  // ---- AND pre-filters ----
  let pool = contacts;
  if (cfg.lastHeardEnabled) {
    const cutoffSecs = Math.floor(nowMs / 1000) - cfg.lastHeardHours * 3600;
    pool = pool.filter(c => {
      const seen = c.lastSeen ?? c.lastAdvert;         // seconds
      return seen != null && seen >= cutoffSecs;
    });
  }
  if (cfg.hopsEnabled) {
    pool = pool.filter(c => {
      if (c.pathLen == null) return false;             // unknown route excluded when hop filter on
      return c.pathLen >= cfg.hopsMin && c.pathLen <= cfg.hopsMax;
    });
  }
  if (cfg.signalEnabled) {
    pool = pool.filter(c => {
      const passRssi = cfg.rssiMin <= MC_PF_RSSI_FLOOR || (c.rssi != null && c.rssi >= cfg.rssiMin);
      const passSnr  = cfg.snrMin  <= MC_PF_SNR_FLOOR  || (c.snr  != null && c.snr  >= cfg.snrMin);
      return passRssi && passSnr;
    });
  }

  // ---- OR-union identity filters ----
  let regex: RegExp | null = null;
  if (cfg.regexEnabled && cfg.nameRegex && cfg.nameRegex !== '.*') {
    try { regex = compileUserRegex(cfg.nameRegex, 'i'); } catch { regex = null; }
  }
  const allow = new Set(cfg.targetKeys);
  const hasAnyOr =
    (cfg.contactsEnabled && allow.size > 0) ||
    (cfg.regexEnabled && (regex !== null || cfg.nameRegex === '.*'));
  if (!hasAnyOr) return pool;                           // AND-only ⇒ whole pool passes

  return pool.filter(c => {
    if (cfg.contactsEnabled && allow.has(c.publicKey)) return true;
    if (cfg.regexEnabled) {
      const name = c.advName || c.name || '';
      if (cfg.nameRegex === '.*') return true;
      if (regex && regex.test(name)) return true;
    }
    return false;
  });
}
```
- **`lastSeen`/`lastAdvert` units:** both are epoch **seconds** (contact records).
  Prefer `lastSeen`, fall back to `lastAdvert`.
- **"Selected contact no longer exists":** naturally handled — the allowlist is a
  `Set` of `publicKey`, and filtering is `contacts.filter(...)`. A stored key with
  no live contact simply never matches and is dropped from `targets`. No cleanup
  needed. (Add a test asserting this, §7.)

### 3.2 executeRun wiring
Inside `executeRun` (after L5884 `const contacts = this.getContacts()`), read the
filter **fresh every run** and apply it to the whole contact set before the
device-type split:
```ts
const contacts = this.getContacts();
if (contacts.length === 0) { /* existing early return */ }

const filterCfg = await databaseService.getMeshcorePathfindingFilterSettingsAsync(this.sourceId);
const filtered = filterPathfindingContacts(contacts, filterCfg);

const companions = pathDiscoveryEnabled
  ? filtered.filter(c => c.advType === MeshCoreDeviceType.COMPANION)
  : [];
const repeaters = neighborsEnabled
  ? filtered.filter(c => c.advType === MeshCoreDeviceType.REPEATER)
  : [];
```
Everything downstream (`targets` build L5897, the send loop) is unchanged.
Reading in `executeRun` (not `startAutoPathfinding`) means filter edits take effect
on the next tick **without a scheduler restart** — the basis for the separate
`/filter` route (§0). Add a debug log of pre/post counts:
`logger.debug(\`[MeshCore:${this.sourceId}] Auto-pathfinding: filter ${contacts.length}→${filtered.length} contacts (enabled=${filterCfg.enabled})\`)`.

---

## 4. API — `src/server/routes/meshcoreRoutes.ts`

Add the `ok`/`fail` import (`import { ok, fail } from '../utils/apiResponse.js'` —
verify the relative path against the file's other `../utils/*` imports). Place the
two handlers immediately after the existing `/automation/pathfinding` POST (after
L3074).

### 4.1 `GET /automation/pathfinding/filter`
```
optionalAuth(), requirePermission('automation','read',{ sourceIdFrom:'params.id' })
```
Body: none. Response `ok(res, data)` where `data` is the full
`MeshcorePathfindingFilterSettings` from
`await databaseService.getMeshcorePathfindingFilterSettingsAsync(sourceId)`.
On throw: `fail(res, 500, 'PATHFINDING_FILTER_READ_FAILED', 'Failed to read pathfinding filter')`.

### 4.2 `POST /automation/pathfinding/filter`
```
requireAuth(), requirePermission('automation','write',{ sourceIdFrom:'params.id' })
```
Request body = `Partial<MeshcorePathfindingFilterSettings> & { targetKeys?: string[] }`.
**Validation (return `fail(res, 400, 'PATHFINDING_FILTER_INVALID', <msg>)` on failure):**
- `enabled, contactsEnabled, regexEnabled, lastHeardEnabled, hopsEnabled,
  signalEnabled`: if present, must be `boolean`.
- `targetKeys`: if present, must be `string[]`; each entry a non-empty hex-ish
  string ≤ 64 chars (`/^[0-9a-fA-F]{2,64}$/`). Reject otherwise. Missing ⇒ treat as
  `[]` only if `contactsEnabled` — otherwise leave unchanged is NOT supported;
  always require `targetKeys` array in the payload (frontend always sends it).
- `nameRegex`: if present, must be a string; **compile-check with
  `compileUserRegex(nameRegex,'i')` inside try/catch** — on throw, `fail(...,
  'PATHFINDING_FILTER_BAD_REGEX', 'Invalid name filter regex')`.
- `lastHeardHours` int 1..8760; `hopsMin` int 0..10; `hopsMax` int 0..10 and
  `hopsMax >= hopsMin`; `rssiMin` int -200..0; `snrMin` int -100..100. Use
  `Number.isInteger` + range; reject NaN/out-of-range.

On success: `await databaseService.setMeshcorePathfindingFilterSettingsAsync(sourceId, validated)`.
Do **not** call `startAutoPathfinding()` (filter is read per-tick). Respond
`ok(res, await databaseService.getMeshcorePathfindingFilterSettingsAsync(sourceId))`
(echo the persisted config so the client re-syncs). On unexpected throw:
`fail(res, 500, 'PATHFINDING_FILTER_SAVE_FAILED', 'Failed to save pathfinding filter')`.

---

## 5. Settings keys — `src/server/constants/settings.ts`

Register EVERY new KV key in **BOTH** arrays:
`VALID_SETTINGS_KEYS` (add beside L221–225) **and** `PER_SOURCE_SETTINGS_KEYS`
(add beside L364–368). The allowlist is table-backed and is NOT a settings key.

New keys (12):
```
meshcorePathfindingFilterEnabled
meshcorePathfindingFilterContactsEnabled
meshcorePathfindingFilterRegexEnabled
meshcorePathfindingFilterNameRegex
meshcorePathfindingFilterLastHeardEnabled
meshcorePathfindingFilterLastHeardHours
meshcorePathfindingFilterHopsEnabled
meshcorePathfindingFilterHopsMin
meshcorePathfindingFilterHopsMax
meshcorePathfindingFilterSignalEnabled
meshcorePathfindingFilterRssiMin
meshcorePathfindingFilterSnrMin
```
The getter/setter (§2.7) must use these exact strings.

---

## 6. Frontend — `src/components/MeshCore/MeshCoreAutomationsView.tsx`

Add the filter panel inside the existing Auto-Pathfinding `settings-section`
(after the "Last run info" block, L318), gated the same way (`opacity`/
`pointerEvents` on `settings.enabled`; inputs additionally `disabled={!canWrite}`).
Keep everything in this file (or extract a `MeshCorePathfindingFilterSection.tsx`
child — preferred for size; it would take `{ baseUrl, sourceId, canWrite }` and own
its own `useSaveBar` with `id: 'meshcore-pathfinding-filter'`). Spec assumes a
**child component** to keep the parent lean.

### 6.1 New TS interface (frontend)
```ts
interface PathfindingFilterSettings {
  enabled: boolean;
  targetKeys: string[];
  contactsEnabled: boolean;
  regexEnabled: boolean;
  nameRegex: string;
  lastHeardEnabled: boolean;
  lastHeardHours: number;
  hopsEnabled: boolean;
  hopsMin: number;
  hopsMax: number;
  signalEnabled: boolean;
  rssiMin: number;
  snrMin: number;
}
const FILTER_DEFAULTS: PathfindingFilterSettings = {
  enabled: false, targetKeys: [], contactsEnabled: true, regexEnabled: false,
  nameRegex: '.*', lastHeardEnabled: false, lastHeardHours: 168,
  hopsEnabled: false, hopsMin: 0, hopsMax: 10,
  signalEnabled: false, rssiMin: -200, snrMin: -100,
};
```

### 6.2 Fetch / save wiring (mirror `MeshCoreAutomationsView` L51–137)
- `fetchFilter`: `csrfFetch(\`${baseUrl}/api/sources/${sourceId}/meshcore/automation/pathfinding/filter\`)`,
  read `json.data`, set `settings`+`initial`.
- `fetchContacts`: copy `MeshCoreTimerTriggersSection.tsx:160–181` —
  `csrfFetch(\`${baseUrl}/api/sources/${sourceId}/meshcore/contacts\`)`, map `data`
  → `MeshCoreContactRow { publicKey, name, advType?, lastSeen?, lastAdvert?, rssi?, snr?, pathLen? }`
  (keep the raw fields — the preview needs them). Store in `contacts` state.
- `handleSave`: `POST` the full `settings` object as JSON; on `!res.ok` return on
  403 else throw; on success set `initial = settings`.
- `hasChanges`: deep-compare `settings` vs `initial` (compare `targetKeys` as
  sorted-join). Register `useSaveBar({ id:'meshcore-pathfinding-filter',
  sectionName: t('meshcore.automation.pathfinding.filter.title','Target Filter'),
  hasChanges, isSaving, onSave, onDismiss })`.

### 6.3 Panel sub-components (each attribute section = its own enable checkbox)
1. **Master toggle** — `<input type=checkbox checked={settings.enabled}>` labeled
   "Filter target contacts". When off, the rest of the panel is dimmed/disabled but
   still visible.
2. **Contact checklist (OR):** enable checkbox (`contactsEnabled`) + a search box
   (filters `contacts` by name/publicKey substring) + **Select all / Deselect all**
   buttons that operate on the *currently searched* list + a **count badge**
   `{settings.targetKeys.length} / {contacts.length}`. Each row: checkbox bound to
   `targetKeys.includes(c.publicKey)`, toggling adds/removes the key. Model the
   fetch + option mapping on `MeshCoreTimerTriggersSection` (`contactOptions`
   L285).
3. **Name regex (OR):** enable checkbox (`regexEnabled`) + text input
   (`nameRegex`). Show inline "invalid regex" hint when `new RegExp(nameRegex,'i')`
   throws (client-side sanity only; backend enforces RE2 via `compileUserRegex`).
4. **Last heard (AND):** enable checkbox (`lastHeardEnabled`) + number input hours
   (min 1, max 8760).
5. **Hop range (AND):** enable checkbox (`hopsEnabled`) + two number inputs
   `hopsMin`/`hopsMax` (0..10; clamp `hopsMax >= hopsMin`). Note in helper text:
   "Contacts with an unknown route (flood) are excluded when this is on."
6. **Signal (AND):** enable checkbox (`signalEnabled`) + `rssiMin` (dBm, -200..0)
   + `snrMin` (dB, -100..100). Helper text: leave a threshold at its floor to
   ignore it.

### 6.4 Live "matching targets" preview (mirror `AutoTracerouteSection.tsx:407–523`)
Re-implement the backend `filterPathfindingContacts` logic **client-side** in a
`useMemo` named `matchingContacts` over the `contacts` state, using
`new RegExp(nameRegex,'i')` in try/catch (client preview only). AND pre-filters
first (last-heard via `lastSeen ?? lastAdvert`; hop via `pathLen` with null
excluded; signal via the floor sentinels), then `hasAnyOr` gate, then OR union —
identical branch structure to §3.1. Debounce 1s into `debouncedMatching`
(copy the `debounceTimerRef` pattern L495–523). Render
`{debouncedMatching.length} contacts will be targeted` plus, optionally, the first
N names. Deps array must list every `settings.*` field used (exhaustive-deps is an
ESLint error — include all; do not disable).

### 6.5 i18n keys — add to `public/locales/en.json`
Namespace `meshcore.automation.pathfinding.filter.*`. Minimum set (all also passed
as inline defaults in code so untranslated locales still render):
`title, description, master_toggle, contacts_label, contacts_enable,
search_placeholder, select_all, deselect_all, count_badge, regex_enable,
regex_label, regex_invalid, last_heard_enable, last_heard_label, hops_enable,
hops_min_label, hops_max_label, hops_unknown_note, signal_enable,
rssi_min_label, snr_min_label, signal_note, preview_count`.
Only `en.json` is required; other `public/locales/*.json` fall back to inline
defaults.

---

## 7. Test plan

### 7.1 Manager filter logic — `src/server/meshcoreManager.pathfindingFilter.test.ts` (NEW)
Import `filterPathfindingContacts`, `MC_PF_RSSI_FLOOR`, `MC_PF_SNR_FLOOR`. Build
`MeshCoreContact[]` fixtures. Cases:
- master off ⇒ returns input unchanged (identity).
- master on, no OR configured, no AND configured ⇒ all pass.
- allowlist only (`contactsEnabled`, `targetKeys=[k1]`) ⇒ only k1.
- **"selected contact no longer exists":** `targetKeys=[kGhost]` where no contact
  has that key ⇒ empty result, no throw.
- regex only (`regexEnabled`, `nameRegex='^rep'`) ⇒ matches by `advName`/`name`.
- regex `.*` ⇒ all pass. Invalid regex ⇒ treated as no regex match (falls to other
  OR filters / empty).
- OR union: allowlist ∪ regex ⇒ union, not intersection.
- last-heard AND: contact with `lastSeen` older than cutoff excluded; `lastAdvert`
  fallback honored; null both ⇒ excluded when enabled.
- hop AND: `pathLen` in [min,max] kept; out-of-range excluded; **`pathLen=null`
  excluded** when `hopsEnabled`.
- signal AND: `rssiMin`/`snrMin` thresholds; floor sentinel = no-op; contact
  missing the targeted metric excluded; combined rssi+snr both required.
- AND narrows before OR: a contact in the allowlist but failing an AND pre-filter
  is excluded (allowlist cannot rescue an AND failure).
- companions/repeaters share one filter: assert filtering the mixed set then
  splitting by `advType` yields the expected per-type members.

### 7.2 Repo source isolation — `src/db/repositories/meshcorePathfindingTargets.perSource.test.ts` (NEW)
Use the singleton `:memory:` DB (see existing `meshcoreFavorite.perSource.test.ts`
as the template for this directory). Assert:
- `setTargets([k1,k2], 'srcA')` then `getTargets('srcA')` returns `[k1,k2]`
  ordered by insert; `getTargets('srcB')` returns `[]`.
- Writing `srcB` does not affect `srcA` rows and vice-versa.
- `setTargets` replaces (delete-then-insert): second call with `[k3]` on `srcA`
  leaves only `[k3]`.
- duplicate input keys de-duped; `UNIQUE(sourceId,publicKey)` not violated.

### 7.3 Route tests — `src/server/routes/meshcoreRoutes.pathfindingFilter.test.ts` (NEW)
Use `createRouteTestApp({ mount: app => app.use('/api/sources/:id/meshcore', router) })`
(match the real mount prefix used for these routes). Cases:
- GET without `automation:read` on the source ⇒ 403 (`limited` user, no grant).
- GET with read grant ⇒ 200, `data` has all 13 fields with defaults.
- POST without `automation:write` ⇒ 403.
- POST with write grant, valid body ⇒ 200; GET reflects persisted values;
  `targetKeys` round-trip via the table.
- POST invalid regex ⇒ 400 `PATHFINDING_FILTER_BAD_REGEX`.
- POST out-of-range int (`hopsMax=99`, or `hopsMax < hopsMin`) ⇒ 400
  `PATHFINDING_FILTER_INVALID`.
- POST non-hex `targetKeys` entry ⇒ 400.
- Per-source isolation: POST to `sourceA` does not change `sourceB`'s GET.
- Mock the manager registry so `managerFor` resolves a stub MeshCore manager
  (this test exercises persistence/validation, not device IO). Non-DB mocks
  (`sourceManagerRegistry`) remain per CLAUDE.md.

### 7.4 Migration count test — `src/db/migrations.test.ts`
No literal edit needed (dynamic assertions). **Run the full suite** to catch any
schema-snapshot or `activeSchema` test that enumerates tables and must now include
`meshcore_pathfinding_targets`. If a migration-113 `*.test.ts` sibling is desired,
model it on `110_add_meshcore_position_history.test.ts` (create-table idempotency
across a re-run).

### 7.5 Gates (all must pass before PR)
`npm run typecheck` clean; full Vitest suite green (run the whole suite, not just
targeted files — migration/schema/repo wiring touches many); `npm run lint:ci`
exit 0 (no new `no-explicit-any` / raw-`fetch` / exhaustive-deps regressions —
type the new code, keep `csrfFetch`, list all preview deps).

---

## 8. Work-package decomposition

One PR, shared branch. Sequence chosen so each package compiles and tests on its
own where possible. **WP1 is a hard prerequisite for WP2/WP3.** WP4 depends on
WP3's route contract.

### WP1 — DB layer (foundation) — SEQUENTIAL, first
Scope: §2 in full — migration 113 (3 backends) + registry + schema (`misc.ts` +
`activeSchema.ts`) + repository + DatabaseService wiring + aggregation
getter/setter + settings keys (§5). Tests: §7.2 repo perSource test; run migration
suite.
**Acceptance:** migration applies on all three backends (SQLite proven by the
harness/`:memory:` boot); `getMeshcorePathfindingFilterSettingsAsync` returns
defaults for an unset source and round-trips a `set...`; both settings arrays
contain all 12 keys; `npm run typecheck` + repo test green.

### WP2 — Manager filter logic — depends on WP1 (needs the getter + FilterSettings type)
Scope: §3 — exported `filterPathfindingContacts` + `executeRun` wiring + debug log.
Tests: §7.1 manager filter test (pure function; no device IO).
**Acceptance:** §7.1 cases pass incl. "selected contact no longer exists" and
"AND narrows before OR"; `executeRun` reads the filter fresh each tick; typecheck
green. Can be built in parallel with WP3 once WP1 lands (both depend only on WP1).

### WP3 — API routes — depends on WP1 (getter/setter + settings keys)
Scope: §4 — GET/POST `/automation/pathfinding/filter` with `ok`/`fail`, permission
scoping, full validation (RE2 + int/bool). Tests: §7.3 route tests via
`createRouteTestApp()`.
**Acceptance:** §7.3 cases pass (403/200/400 codes exact); persistence round-trips;
per-source isolation holds; typecheck + lint green. Parallelizable with WP2.

### WP4 — Frontend panel — depends on WP3 (route contract) and WP1 (field shape)
Scope: §6 — `MeshCorePathfindingFilterSection.tsx` child (or inline) with master
toggle, searchable contact checklist (select/deselect + count badge), four
attribute sections each with its own enable checkbox, debounced live preview,
`useSaveBar` wiring, i18n keys in `en.json`. No new backend.
**Acceptance:** panel loads current config, edits mark the save bar dirty, save
persists and GET reflects it; preview count matches backend semantics on a
hand-checked fixture; `canWrite=false` disables all inputs; `lint:ci` clean (no
raw `fetch`, exhaustive-deps satisfied); browser-validated against the dev
container per the epic exit criteria.

### Ordering summary
```
WP1 ──┬── WP2  (manager)   ┐
      └── WP3  (API) ── WP4 (frontend)
```
WP2 and WP3 run in parallel after WP1. WP4 starts once WP3's endpoint shape is
fixed. Final step before PR: full Vitest suite + typecheck + `lint:ci` on the
integrated branch (§7.5), then `/ci-monitor`.
