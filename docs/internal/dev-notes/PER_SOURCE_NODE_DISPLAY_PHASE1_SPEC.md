# Phase 1 Spec — Per-Source Settings Foundation & Guardrails

**Epic:** [PER_SOURCE_NODE_DISPLAY_EPIC.md](./PER_SOURCE_NODE_DISPLAY_EPIC.md) (issue #4412)
**Branch:** `feature/per-source-settings-foundation`
**Worktree:** `/home/yeraze/Development/meshmonitor-per-source-node-display`
**Phase goal:** make the per-source settings mechanism trustworthy and seed the data.
**User-visible change: NONE.** Phase 1 ships no UI change and no behavior change that a
user can observe. Backend read conversion is Phase 2; UI is Phase 3.

---

## 0. Reuse inventory (READ FIRST — do not build what already exists)

Every implementer MUST use the following. Nothing in this spec authorizes a new
subsystem; the only genuinely new artifacts are two constant arrays, one migration,
and test files.

### 0.1 Route / HTTP layer

| Thing | Location | How Phase 1 uses it |
|---|---|---|
| `ok(res, data?)` / `fail(res, status, code, message, extra?)` | `src/server/utils/apiResponse.ts` (39 lines, whole file) | **All new or modified response paths** in `settingsRoutes.ts` use these. `ok(res)` emits exactly `{ success: true }` — byte-identical to the per-source branch's current `res.json({ success: true })`, so swapping it in is safe. `fail()` is always safe (CLAUDE.md): `ApiService` reads only `error`/`code`. **Do NOT** convert the global branch's `res.json({ success: true, settings: filteredSettings })` — that is a bare payload with a live consumer. |
| `requirePermission(resource, action, options?)` | `src/server/auth/authMiddleware.ts:351-387` (option parsing) and `:428-447` (the `checkPermissionAsync(user.id, resource, action, scopedSourceId)` call) | Add `{ sourceIdFrom: 'query' }` to the `POST /` route. Verified: when `req.query.sourceId` is absent, `scopedSourceId` stays `undefined` and the call degrades to the exact global check performed today. See §3.3 for the proof. |
| `RequirePermissionOptions.requireSourceId` | `src/server/auth/authMiddleware.ts:344-349` | **MUST NOT be set** on this route — the handler serves both global and per-source writes; `requireSourceId: true` would 400 every global save. |
| Correct-usage reference | `src/server/routes/meshcoreAutomationRoutes.ts` | Read for the calling convention before editing. |
| `optionalAuth()` | `src/server/auth/authMiddleware.ts` | Unchanged; `GET /` keeps it. |

### 0.2 Data layer

| Thing | Location | How Phase 1 uses it |
|---|---|---|
| `SettingsRepository.getSourceSettings(sourceId)` | `src/db/repositories/settings.ts:175-186` | Reads the whole `source:{id}:` namespace with the prefix stripped. Already used by `GET /api/settings?sourceId=`. |
| `SettingsRepository.getSettingForSource(sourceId, key)` | `src/db/repositories/settings.ts:198-203` | No fallback to global by design (#2839/#2840). **Do not add one.** |
| `SettingsRepository.setSourceSettings(sourceId, kv)` | `src/db/repositories/settings.ts:216-231` | The per-source POST branch already calls this. Keep it — it already guards against property injection with `/^[A-Za-z0-9_.-]+$/`. |
| `SettingsRepository.deleteSourceSettings(sourceId)` | `src/db/repositories/settings.ts:238-248` | **Exists and is never called anywhere in the repo** (verified by grep). WP3 wires it up and makes it a single prefix `DELETE` instead of the current select-all-then-delete-one-by-one loop. |
| `settings` table schema | `src/db/schema/settings.ts` | Flat KV: `key` PK (`VARCHAR(255)` on MySQL), `value NOT NULL`, `createdAt`/`updatedAt` `NOT NULL` with **no DB default** — every insert must supply timestamps (see the comment in migration 093 for the failure mode). Per-source scoping is key namespacing only: **no schema change in Phase 1.** |
| `DatabaseService.settingsCache` | `src/services/database.ts:374`, populated at `:977-981`, read at `:3136`/`:3169` | PG/MySQL only, backs the *sync* `getSetting`/`getSettingForSourceSync` path. `deleteSourceSettings` on the repo does **not** evict it — WP3 must (see §5.2). |
| `DatabaseService.auditLogAsync(userId, action, resource, details, ip, before?, after?)` | `src/services/database.ts:4464-4472` | `resource` is a free-form string; `valueBefore`/`valueAfter` are currently `void`-ed (not yet in the Drizzle schema). Reuse the existing call shape from `settingsRoutes.ts:954-962`. |

### 0.3 Migration layer

| Thing | Location | How Phase 1 uses it |
|---|---|---|
| Migration registry | `src/db/migrations.ts` (registration blocks, newest at the tail) | Register migration 131 with `{ number, name, settingsKey, sqlite, postgres, mysql }`. `src/db/migrations.test.ts` is registry-derived — **no edit needed**, but it asserts `highest number === registry count`, names unique, all three backends present, and `settingsKey` present for 002+. |
| Migration ledger | `src/db/migrationLedger.ts` (`runLedgeredMigrations`, `markMigrationAppliedPostgres/Mysql`) | Gives once-per-DB semantics on PG/MySQL. **Idempotency is still mandatory** (crash between run and ledger write re-runs it). |
| `src/server/migrations/093_autoack_matrix.ts` | whole file | **The closest structural precedent.** Prefix-aware, INSERT-if-absent, explicit `createdAt`/`updatedAt`, `INSERT OR IGNORE` (SQLite) / `ON CONFLICT (key) DO NOTHING` (PG) / `INSERT IGNORE` (MySQL), pure exported `computeMigrationInserts()` for unit testing. **Copy this shape.** Its one deficiency — a per-row round trip on PG/MySQL — is what 131 must not repeat. |
| `src/server/migrations/050_promote_globals_to_default_source.ts` | whole file | Precedent for reading globals and writing `source:{defaultId}:{key}`. **Its scope is wrong for us** (default source only) and **its import of `PER_SOURCE_SETTINGS_KEYS` is an anti-pattern to avoid** — see §6.1. |
| `src/server/migrations/030_add_source_id_to_route_segments.ts:271-280` (`chunk<T>()`) and `:347-360` (PG multi-row `VALUES` with computed `$n` placeholders), `:484-500` (MySQL multi-row + per-row fallback) | | **Copy the batching pattern verbatim.** This is the fix for the #4233 disaster CLAUDE.md warns about. |
| `src/server/migrations/helpers.ts` | `addColumnIfMissing`, `addColumnIfMissingPostgres`, `addColumnIfMissingMysql`, `createTableIfMissingMysql`, `createIndexIfMissingMysql` | **Confirmed: none apply to migration 131.** 131 adds no column, table, or index — it is a pure data seed into an existing table. Idempotency comes from `INSERT`-if-absent on the `key` primary key, which is the same mechanism 093 and 050 use. Do not invent a helper. |
| `src/server/migrations/_legacyDefaultSource.ts` (`ensureDefaultSourceIdSqlite/Postgres/Mysql`) | | **Confirmed NOT applicable.** Those helpers resolve *one* default source and will *synthesize* a placeholder source from `MESHTASTIC_NODE_IP` when `sources` is empty. Migration 131 must seed **every** source and must **not** create one. Use a plain `SELECT id FROM sources`. Cited here so no implementer reaches for it by analogy with 050. |
| `sources` table column names | `src/server/migrations/020_create_sources.ts:6-32` | `id` is unquoted lowercase on all three backends — `SELECT id FROM sources` is portable as-is. |

### 0.4 Test layer

| Thing | Location | How Phase 1 uses it |
|---|---|---|
| `createRouteTestApp()` / `RouteTestHarness` | `src/server/test-helpers/routeTestApp.ts` | **Mandatory for every new/changed route test** (CLAUDE.md). Provides `app`, `db` (the live `:memory:` singleton with migrations + seeded users), `sourceA`/`sourceB`, `admin`/`limited`/`anonymous`, `loginAs()`, `grant(userId, resource, action, sourceId?)`, `revokeAll()`, `cleanup()`. The per-source permission test in WP2 is impossible to write honestly without it. Canonical template: `src/server/routes/sourceRoutes.permissions.test.ts`. |
| Multi-backend repository harness | `src/db/repositories/test-utils.ts` — `postgresAvailable`, `mysqlAvailable`, `createPostgresBackend`, `createMysqlBackend`, `clearTable`, `TestBackend` | Extend `src/db/repositories/settings.test.ts`'s existing `runSettingsTests(getBackend)` factory with `deleteSourceSettings` cases; it already runs SQLite always and PG/MySQL under `describe.skipIf`. |
| `createTestDb()` | `src/server/test-helpers/testDb.ts` | SQLite in-memory DB built from the migration registry. Used by `settings.test.ts`'s SQLite block. |
| Fake PG client / MySQL pool for migration SQL assertions | `src/server/migrations/030_route_segments_rebuild.pgmysql.test.ts:43-80` | **The established way to test PG/MySQL migration paths without containers.** Copy for 131's batching assertions. |
| Real-container migration test pattern | `describe.skipIf(!postgresAvailable)` in `src/db/repositories/settings.test.ts:275+` | Use for 131's round-trip test. CLAUDE.md warning applies: a silent skip still reports success — confirm coverage via `numPendingTests` in the JSON reporter. |
| `src/server/services/automation/autoAckParity.test.ts:257-260` | | **Load-bearing constraint.** It asserts `AUTOACK_PARITY[key].perSource === PER_SOURCE_SETTINGS_KEYS.has(key)` for every auto-ack key, and `:332-336` separately pins `autoAckTestMessages.perSource === false`. Adding `autoAckTestMessages` to `PER_SOURCE_SETTINGS_KEYS` breaks both. This is why §2.2 introduces a *separate* array. |
| Existing settings route tests | `src/server/routes/settingsRoutes.test.ts` (1014 lines, legacy `vi.mock('../../services/database.js')` pattern) | **Do not rewrite.** Extend it for pure-validation cases (they need no DB). Per CLAUDE.md the file converts to the harness only opportunistically; a wholesale conversion in Phase 1 is out of scope and would be a large merge hazard. New *permission* and *isolation* tests go in a new harness-based file. |

### 0.5 Constants

| Thing | Location | Status |
|---|---|---|
| `VALID_SETTINGS_KEYS` | `src/server/constants/settings.ts:9-319` | The `POST /api/settings` allowlist. All 10 Node Display keys are **already present** (verified). Unchanged by Phase 1. |
| `PER_SOURCE_SETTINGS_KEYS` | `src/server/constants/settings.ts:340-529` | Extended by WP1. Semantics preserved: "keys the server reads via `getSettingForSource`". |
| `SECRET_SETTINGS_KEYS` / `stripSecretSettings` | `src/server/constants/settings.ts:542-575` | Untouched. |
| Consumers of `PER_SOURCE_SETTINGS_KEYS` | migration 050 (×3 backends) and `autoAckParity.test.ts` | Verified exhaustively by grep. Neither may break — see §2.2. |
| `GLOBAL_ONLY_SETTINGS_KEYS` (NEW, WP1) | `src/server/constants/settings.ts` | The **only** new constant the route reads. Deny-list: per-source POST accepts `VALID_SETTINGS_KEYS \ GLOBAL_ONLY_SETTINGS_KEYS`. See §2.2/§3.1(b). |
| `PER_SOURCE_KEYS_NOT_POSTABLE` (NEW, WP1) | `src/server/constants/settings.ts` | Documentation-only; consumed solely by `settings.allowlist.test.ts`. Never read at request time. See §3.1(c)/§4.1. |

---

## 1. Ground truth established during analysis

Facts confirmed by reading source. Implementers should not re-derive these.

1. **All 10 Node Display keys are already in `VALID_SETTINGS_KEYS`.** Only 1 of 10
   (`localStatsIntervalMinutes`) is in `PER_SOURCE_SETTINGS_KEYS`. WP1 adds the other 9.
2. **Boolean settings in this group are persisted as `'1'`/`'0'`, not `'true'`/`'false'`.**
   `SettingsTab.tsx:902` (`hideIncompleteNodes: draft.hideIncompleteNodes ? '1' : '0'`) and
   `:907` (`nodeDimmingEnabled: nodeDimmingEnabled ? '1' : '0'`). Read back at
   `App.tsx:1230` (`settings.hideIncompleteNodes !== '1'`) and `SettingsTab.tsx:530`
   (`=== '1' || === 'true'`). **Migration 131 must seed `'0'`, not `'false'`.**
3. **`requirePermission` with `sourceIdFrom: 'query'` is safe for a dual-purpose handler.**
   `authMiddleware.ts:361-378`: `scopedSourceId` is only assigned when the raw value is a
   non-empty string; `requireSourceId` is opt-in. `:428-433` then calls
   `checkPermissionAsync(user.id, resource, action, scopedSourceId)` — with `undefined`
   this is the identical call made today.
4. **The `settings` table's `createdAt`/`updatedAt` are `NOT NULL` with no DB default.**
   A `(key, value)`-only insert is silently swallowed by `INSERT OR IGNORE` on SQLite and
   hard-fails on PG (migration 093 comment, lines 130-134). Always bind timestamps.
5. **Client input ranges** (`SettingsTab.tsx:1874-2031`): `maxNodeAgeHours` 1-168 ·
   `inactiveNodeThresholdHours` 1-720 · `inactiveNodeCheckIntervalMinutes` 1-1440 ·
   `inactiveNodeCooldownHours` 1-720 · `localStatsIntervalMinutes` 0-60 ·
   `nodeDimmingStartHours` 0.5-24 step 0.5 · `nodeDimmingMinOpacity` 0.1-0.9 step 0.1 ·
   `nodeHopsCalculation` ∈ {`nodeinfo`,`traceroute`,`messages`}.
   Only `inactiveNode*` (3 of these) have server-side validation today
   (`settingsRoutes.ts:283-304`). `maxNodeAgeHours` has none — WP2 adds it.
6. **The audit-log block can compute per-source before-values with no extra query.**
   `currentSettings = await databaseService.settings.getAllSettings()` at
   `settingsRoutes.ts:210` returns *every* row including `source:{id}:{key}` ones
   (`GET /` explicitly filters them out afterwards at `:181-184`). So the per-source
   before-value is `currentSettings['source:' + sourceId + ':' + key]`.

---

## 2. Decision: the shape of the per-source key filter (work items 1, 2, 3)

### 2.1 Why the obvious design is wrong

The obvious implementation of work item 3 — "filter the per-source POST body against
`PER_SOURCE_SETTINGS_KEYS` instead of `VALID_SETTINGS_KEYS`" — **silently breaks 10 keys
across 6 live UI surfaces.** A full audit of every frontend `POST` to bare `/api/settings`
carrying `?sourceId=` found 19 call sites. Ten keys they send are absent from
`PER_SOURCE_SETTINGS_KEYS`:

| Key | Written by | Read back by | Consequence of a naive filter |
|---|---|---|---|
| `telemetryFavorites` | `Dashboard/Dashboard.tsx:219`, `hooks/useFavorites.ts:158` | `Dashboard/hooks/useDashboardData.ts:82`, `useFavorites.ts:62,145` | **Severe.** Chart favoriting stops persisting per-source. `Dashboard.tsx:219` reloads the page on a thrown error, but a dropped key still returns 200 — so the UI shows success, then reverts on reload. |
| `telemetryCustomOrder` | `Dashboard.tsx:188` | `useDashboardData.ts:86` | Severe, partly masked by a localStorage mirror (`Dashboard.tsx:181`) — degrades to browser-local. |
| `dashboardWidgets` | `Dashboard/hooks/useCustomWidgets.ts:38` | `useDashboardData.ts:90` | **Severe.** No fallback: every custom-widget add/remove/config becomes a no-op. |
| `dashboardSolarVisibility` | `Dashboard.tsx:80` | `useDashboardData.ts:94` | Severe. Solar-overlay toggles stop persisting. |
| `autoKeyManagementIntervalMinutes` | `AutoKeyManagementSection.tsx:118` | same section, L~99 via source-scoped GET | Save silently no-ops; the sibling `autoKeyManagementEnabled` *is* per-source and survives ⇒ **partial save**, split state. |
| `autoKeyManagementMaxExchanges` | " | " | same |
| `autoKeyManagementAutoPurge` | " | " | same |
| `autoKeyManagementImmediatePurge` | " | " | same |
| `remoteAdminScannerExpirationHours` | `RemoteAdminScannerSection.tsx:198` | `RemoteAdminScannerSection.tsx:72` | Partial save alongside 4 sibling keys that *are* per-source. |
| `autoAckTestMessages` | `AutoAcknowledgeSection.tsx:257` | same section via source-scoped GET | UI scratchpad stops persisting. Explicitly documented as server-unread (`autoAckConverter.ts:387`). |

These keys are **legitimately source-scoped** — the UI writes them into the namespace and
reads them back out of the source-scoped `GET`. They are simply never read by *server*
code, which is why they were never added to `PER_SOURCE_SETTINGS_KEYS`.

The table above is therefore not just a bug list. It is the evidence that **an allow-list
built from `PER_SOURCE_SETTINGS_KEYS` cannot be trusted**, because that array was never
maintained to mean "legal in a source namespace" — it means "the server reads this
per-source", which is a strictly narrower thing.

### 2.2 Decision: default-ALLOW with an explicit `GLOBAL_ONLY_SETTINGS_KEYS` deny-list

**The per-source POST filter is `VALID_SETTINGS_KEYS \ GLOBAL_ONLY_SETTINGS_KEYS`.**
One new set. `PER_SOURCE_SETTINGS_KEYS` is extended per work item 1 but is **not** used by
the route filter at all.

**Why deny-list, not allow-list — the polarity decides the failure mode.**

| | Key missing from the list | Consequence |
|---|---|---|
| Allow-list (default-deny) | a source-scoped key you failed to enumerate | The user's setting silently stops persisting. HTTP 200, no error, no log. **Silent data loss** — exactly the bug class §2.1 caught. |
| Deny-list (default-allow) | a global-only key you failed to enumerate | One junk row in the source namespace that nothing reads. Harmless, and **identical to today's behavior**. |

The maintenance economics point the same way. CLAUDE.md already treats these
hand-maintained key lists as a known weak spot (see the "Adding New Settings" rule and
ARCHITECTURE_LESSONS §"Settings Allowlist" — both exist *because* contributors forget to
update them). Under an allow-list, every future per-source key silently breaks unless the
contributor finds and updates the right list. Under a deny-list, every future global-only
key they forget just writes a junk row. Forgiving the hand-maintenance failure is the
entire point of the choice.

**Consequences of this design (all favourable):**

- No `PER_SOURCE_CLIENT_ONLY_SETTINGS_KEYS` array is needed — the 10 keys in §2.1 are
  simply not in the deny-list, so they keep working with no new bookkeeping.
- Migration 050's input set is untouched (`PER_SOURCE_SETTINGS_KEYS` still feeds it, and
  work item 1's 9 additions are Node Display keys that genuinely belong there).
- `autoAckParity.test.ts:257,332` is unaffected — `autoAckTestMessages` stays out of
  `PER_SOURCE_SETTINGS_KEYS`.
- The doc comment on `PER_SOURCE_SETTINGS_KEYS` ("derived by grepping
  `getSettingForSource(...)` call sites") stays true.

**Cost, stated honestly:** the filter only rejects what we positively enumerate, so a
global-only key added after Phase 1 can still be written into a source namespace until
someone adds it to the deny-list. That is the status quo, not a regression, and §3.1(b)
specifies the growth procedure.

### 2.3 Rejection semantics — **silently drop, report, warn. Never 400.**

A `400` is wrong here:

- **It would break existing tests today.** `settingsRoutes.test.ts:600-609` POSTs
  `{ cotFeedEnabled: '1' }` to `?sourceId=mqtt-broker-1` and asserts `200`;
  `:661-669` POSTs `{ meshName: 'Somewhere' }` to the same endpoint and asserts `200`.
  Both are global-only keys. A 400 makes both fail, and those tests encode real client
  behavior.
- **Mixed payloads are the norm.** Phase 3 will have `SettingsTab` split its save, but
  until then, and for any third-party/API-token client, a mixed body must keep working.
- **It is inconsistent with the existing contract.** The current filter already drops
  unrecognized keys silently (`for (const key of VALID_SETTINGS_KEYS) if (key in settings)`).
  Dropping non-per-source keys is the same class of behavior.

**Specified semantics for `POST /api/settings?sourceId=<id>`:**

1. Filter the body against `VALID_SETTINGS_KEYS`, then drop anything in
   `GLOBAL_ONLY_SETTINGS_KEYS`.
2. Compute `ignoredKeys` = keys present in the body that are in `VALID_SETTINGS_KEYS`
   **and** in `GLOBAL_ONLY_SETTINGS_KEYS`. (Keys not in `VALID_SETTINGS_KEYS` at all stay
   silently ignored exactly as today — reporting those would leak the allowlist to
   unauthenticated fuzzing and is a behavior change.)
3. `logger.warn` once per request when `ignoredKeys` is non-empty, naming the sourceId and
   the keys. Diagnostic, not a safety net — under default-allow, an unlisted key is written
   rather than dropped, so nothing depends on this warning firing.
4. Respond `ok(res, { ignoredKeys })` → `{ success: true, data: { ignoredKeys: [...] } }`.
   Purely additive: today's shape is `{ success: true }` and every audited client checks
   only `response.ok`. Existing tests assert `res.status === 200` and are unaffected.

**Global writes (`sourceId` absent) are completely unchanged** — same `VALID_SETTINGS_KEYS`
filter, same `{ success: true, settings: filteredSettings }` response.

---

## 3. File-by-file changes

### 3.1 `src/server/constants/settings.ts`

**(a) Add 9 keys to `PER_SOURCE_SETTINGS_KEYS`.** Insert as one commented block, keeping
the file's existing "grouped with a `//` header" style:

```ts
  // Node Display (#4412 / per-source node display epic). All ten keys in the
  // Settings → Node Display section are per-source as of Phase 1; Phase 2 converts
  // the server reads to getSettingForSource(). `localStatsIntervalMinutes` is
  // already listed under "Misc per-source" below — do not duplicate it.
  'maxNodeAgeHours',
  'inactiveNodeThresholdHours',
  'inactiveNodeCheckIntervalMinutes',
  'inactiveNodeCooldownHours',
  'nodeHopsCalculation',
  'hideIncompleteNodes',
  'nodeDimmingEnabled',
  'nodeDimmingStartHours',
  'nodeDimmingMinOpacity',
```

`localStatsIntervalMinutes` is already present under `// Misc per-source` — **do not add a
duplicate**; a duplicate would silently double 050's work and make the exact-equality tests
in §4.1 harder to read.

**(b) Add `GLOBAL_ONLY_SETTINGS_KEYS`** — the single new set, placed immediately after
`PER_SOURCE_SETTINGS_KEYS` / `PerSourceSettingKey`.

The starter list below is evidence-gated, not exhaustive by intent. Every entry satisfies
**both** admission tests; the doc comment makes them binding on future contributors.

```ts
/**
 * Settings that are meaningless inside a `source:{id}:` namespace. Dropped (and
 * reported as `ignoredKeys`) by POST /api/settings?sourceId= so a global-only key
 * cannot be written where nothing will ever read it.
 *
 * DENY-LIST, deliberately (see PER_SOURCE_NODE_DISPLAY_PHASE1_SPEC §2.2): the
 * per-source filter is VALID_SETTINGS_KEYS minus this set. A key that belongs here
 * but is missing costs one junk row nobody reads; an over-eager entry silently
 * stops a user setting from persisting. The asymmetry is why this is a deny-list.
 *
 * TWO TESTS BOTH MUST PASS BEFORE ADDING A KEY:
 *   1. No server code reads it per-source — grep for getSettingForSource /
 *      getSettingForSourceSync / getSourceSettings with that key.
 *   2. No frontend code POSTs it to /api/settings with a ?sourceId= query — grep
 *      src/components, src/pages, src/hooks, src/contexts. This is the test that
 *      catches the Dashboard/useFavorites class of key (#4412 Phase 1 audit).
 * If you cannot satisfy BOTH, leave the key out. Omission is safe; a wrong entry
 * is silent data loss.
 */
export const GLOBAL_ONLY_SETTINGS_KEYS = new Set<string>([
  // Documented "global" in this file's own inline comments:
  'pkiDmDecryptionGloballyEnabled',         // :82 master switch, gates every source
  'position_estimation_enabled',            // :141 global batch job (#3271)
  'position_estimation_frequency_hours',    // :141
  'position_estimation_lookback_hours',     // :141
  'position_estimation_max_uncertainty_km', // :145
  'linkPreviewsEnabled',                    // :175 global privacy toggle (#3416)
  'discardInvalidPositions',                // :178 global ingest gate
  'noIndexEnabled',                         // :184 global robots gate (#4202)
  'meshcoreChannelRetryEnabled',            // :189 global opt-in (#3979)
  'meshcoreCliTimeoutSeconds',              // :195 global CLI reply timeout (#4027)
  'elevationEnabled',                       // :305 "Global (not per-source)" (#4111)
  'elevationSourceUrl',                     // :305, also SECRET_SETTINGS_KEYS
  // Global singletons driven only by the global POST branch:
  'cotFeedEnabled',                         // settingsRoutes.ts:900-911 — "global singleton"
  'cotFeedPort',                            // "
  'customTilesets',                         // :725-728 refreshTileHostnameCache (global CSP cache)
  'analyticsProvider',                      // :730-733 invalidateHtmlCache (global HTML)
  'analyticsConfig',                        // "
  'appriseApiServerUrl',                    // :632-647 "(global; #3012)"
]);
```

> **Deliberately NOT in the list** (each fails admission test 2 — the UI posts it with
> `?sourceId=`): the four `autoKeyManagement*` tuning keys,
> `remoteAdminScannerExpirationHours`, `autoAckTestMessages`, `telemetryFavorites`,
> `telemetryCustomOrder`, `dashboardWidgets`, `dashboardSolarVisibility`. See §2.1.
>
> **Deliberately NOT in the list, pending evidence:** `lowBatteryCheckIntervalMinutes` /
> `lowBatteryCooldownHours` drive a global singleton
> (`restart/stopLowBatteryService` take no `sourceId`), which satisfies test 1 — but WP1
> did not confirm test 2 against `NotificationsTab.tsx`. Under default-allow the safe move
> is to omit them. Add later with evidence; do not guess.

**(c) Add the documented exemption set** consumed by the §4.1 test:

```ts
/**
 * PER_SOURCE_SETTINGS_KEYS entries that intentionally are NOT in
 * VALID_SETTINGS_KEYS, because they are written exclusively by a dedicated route
 * or by the server itself — never through POST /api/settings.
 *
 * This set exists so `settings.allowlist.test.ts` can assert EXACT equality
 * rather than a vacuous subset check: adding a per-source key that is missing
 * from VALID_SETTINGS_KEYS fails the build unless you consciously classify it
 * here, and a key that later gains a POST path fails until it is removed.
 *
 * Each entry MUST carry a comment naming the route/service that writes it.
 */
export const PER_SOURCE_KEYS_NOT_POSTABLE = new Set<string>([
  // ── Written by a dedicated route ────────────────────────────────────────
  // POST /api/settings/timesync → databaseService.setTimeSyncFilterSettingsAsync
  // (settingsRoutes.ts:1554; setters at services/database.ts:4699,4707)
  'autoTimeSyncEnabled',
  'autoTimeSyncIntervalMinutes',
  // POST /api/settings/traceroute-nodes → setTracerouteFilterSettingsAsync
  // (settingsRoutes.ts:1321; setters at services/database.ts:2358-2571, 2665)
  'tracerouteNodeFilterEnabled',
  'tracerouteFilterChannels',
  'tracerouteFilterRoles',
  'tracerouteFilterHwModels',
  'tracerouteFilterNameRegex',
  'tracerouteFilterNodesEnabled',
  'tracerouteFilterChannelsEnabled',
  'tracerouteFilterRolesEnabled',
  'tracerouteFilterHwModelsEnabled',
  'tracerouteFilterRegexEnabled',
  'tracerouteExpirationHours',
  'tracerouteSortByHops',
  // ── Server-managed bookkeeping, never user-set ──────────────────────────
  'autoFavoriteNodes',      // favoritesService.ts:301,342,419; nodesRoutes.ts:443,569
  'lastAnnouncementTime',   // announceRoutes.ts:15,17; autoAnnounceService.ts:242,244
  'localNodeNum',           // meshtasticManager.ts:4688,4748
  // ── KNOWN ORPHAN — not legitimized by being listed here ─────────────────
  // externalUrl is READ at securityDigestService.ts:332 and written NOWHERE in
  // the repo. It is in this set because it is in fact absent from
  // VALID_SETTINGS_KEYS, not because that absence is correct. Either the write
  // path was never built or the read is dead. Tracked in §8.7; needs its own
  // issue. Do NOT "fix" it by adding it to VALID_SETTINGS_KEYS — that creates a
  // new user-writable setting, which is a feature, not a Phase 1 cleanup.
  'externalUrl',
]);
```

**This set is exactly 18 keys** — measured, not guessed: `VALID_SETTINGS_KEYS` has 241
entries, `PER_SOURCE_SETTINGS_KEYS` has 161 (no duplicates in either), and the difference
is the 18 above. WP1 **must re-derive it mechanically** after adding the 9 Node Display
keys (all 9 are already in `VALID_SETTINGS_KEYS`, so the difference should stay at 18) and
fail loudly if the number moves.

**No category-(c) bug exists today** — every one of the 18 was traced to a writer, and a
grep of `src/components`, `src/contexts`, `src/hooks`, `src/pages` confirmed none of them
appears in a `/api/settings` POST body. (`localNodeNum`, `lastAnnouncementTime` and
`autoFavoriteNodes` do appear in the frontend, but as local identifiers / React state /
response fields — not as posted keys.) So WP1 should be able to populate the set verbatim;
if its derivation disagrees, the constant edits introduced a mistake.

Note the deliberate division of labour between the two new sets:
`PER_SOURCE_KEYS_NOT_POSTABLE` is **documentation with a test behind it** — it never
affects a request. `GLOBAL_ONLY_SETTINGS_KEYS` is the only one the route reads.

### 3.2 `src/server/routes/settingsRoutes.ts` — the POST key filter

Replace the filter loop at `:213-219`:

```ts
    const settings = req.body;
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
    ...
    // Deny-list, not allow-list (see spec §2.2). A global-only key we failed to
    // enumerate writes one junk row nobody reads; a per-source key wrongly
    // excluded from an allow-list would silently stop persisting.
    const filteredSettings: Record<string, string> = {};
    const ignoredKeys: string[] = [];
    for (const key of VALID_SETTINGS_KEYS) {
      if (!(key in settings)) continue;
      if (sourceId && GLOBAL_ONLY_SETTINGS_KEYS.has(key)) {
        ignoredKeys.push(key);
        continue;
      }
      filteredSettings[key] = String(settings[key]);
    }
    if (ignoredKeys.length > 0) {
      logger.warn(
        `POST /api/settings?sourceId=${sourceId}: dropped ${ignoredKeys.length} global-only ` +
        `key(s), meaningless in a source namespace: ${ignoredKeys.join(', ')}`
      );
    }
```

A single pass over `VALID_SETTINGS_KEYS` — the global path is byte-identical to today
(`sourceId` is null, so the deny branch is unreachable and `ignoredKeys` stays empty).

Import `GLOBAL_ONLY_SETTINGS_KEYS` alongside the existing
`VALID_SETTINGS_KEYS, stripSecretSettings` import at `:21`, and add
`import { ok, fail } from '../utils/apiResponse.js';`.

> **`filteredSettings` must keep `Record<string, string>` typing and the existing
> `String(...)` coercion.** Downstream validation blocks (`:234-647`) do
> `'someKey' in filteredSettings` and index into it — narrowing the type breaks them.

**Ordering note:** the validation blocks at `:234-647` run *after* the filter and *before*
the `if (sourceId)` branch. Because a global-only key is now absent from
`filteredSettings` on a per-source request, its validation block is simply skipped — which
is correct and requires no change to any of them.

### 3.3 `src/server/routes/settingsRoutes.ts` — permission scoping

```diff
-router.post('/', requirePermission('settings', 'write'), async (req, res) => {
+router.post('/', requirePermission('settings', 'write', { sourceIdFrom: 'query' }), async (req, res) => {
```

Verified behavior (`authMiddleware.ts:361-387`, `:428-447`):

| Request | `scopedSourceId` | `checkPermissionAsync` 4th arg | Result |
|---|---|---|---|
| `POST /api/settings` (global) | `undefined` | `undefined` | Identical to today. **No regression.** |
| `POST /api/settings?sourceId=abc` | `'abc'` | `'abc'` | Now scoped. Bug #4 of the epic fixed. |
| `?sourceId=` (empty string) | `undefined` (empty rejected at `:371`) | `undefined` | Falls back to global check. The handler also treats `''` as falsy at `:207` (`typeof … === 'string'` is true but `if (sourceId)` at `:650` is false), so route and middleware agree. |
| `?sourceId=a&sourceId=b` (array) | — | — | `400 { error: 'Invalid sourceId', code: 'BAD_REQUEST' }` from `:372-377`. New but correct; the handler's own `typeof … === 'string'` check would have silently treated it as global. |
| Admin user | short-circuits at `:427-430` | — | Unchanged. |

**Do not set `requireSourceId: true`.**

**Leave `DELETE /` and the sub-routes alone.** Scoping the reset-to-defaults endpoint is a
separate behavior change with its own blast radius; out of scope for Phase 1. Note it in
the deviations log if a reviewer asks.

### 3.4 `src/server/routes/settingsRoutes.ts` — audit logging both branches

The per-source branch returns at `:704`, skipping the audit block at `:936-963`. Extract
the audit block into a module-scope helper and call it from both branches. This is the
lowest-merge-risk restructuring: the global side-effects block is untouched and stays
below the early return.

```ts
/**
 * Audit-log a settings write. Called from BOTH the per-source branch and the
 * global branch, so per-source changes stop being invisible (epic bug #6).
 *
 * `currentSettings` is the pre-write snapshot from getAllSettings(), which
 * includes `source:{id}:{key}` rows — so the per-source before-value needs no
 * extra query.
 *
 * The explicit allowlist check is retained so static analyzers can see that
 * `key` cannot be an attacker-controlled property name like `__proto__`.
 */
async function auditSettingsWrite(
  req: Request,
  currentSettings: Record<string, string>,
  filteredSettings: Record<string, string>,
  sourceId: string | null,
): Promise<void> {
  const validKeySet = new Set<string>(VALID_SETTINGS_KEYS as readonly string[]);
  const changed: Record<string, { before: string | undefined; after: string }> = {};
  const prefix = sourceId ? `source:${sourceId}:` : '';
  for (const key of Object.keys(filteredSettings)) {
    if (!validKeySet.has(key)) continue;
    const before = currentSettings[`${prefix}${key}`];
    if (before !== filteredSettings[key]) {
      Object.defineProperty(changed, key, {
        value: { before, after: filteredSettings[key] },
        enumerable: true, writable: true, configurable: true,
      });
    }
  }
  if (Object.keys(changed).length === 0) return;

  void databaseService.auditLogAsync(
    req.user!.id,
    'settings_updated',
    'settings',
    JSON.stringify({ sourceId, keys: Object.keys(changed) }),
    req.ip || null,
    JSON.stringify(Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.before]))),
    JSON.stringify(Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.after]))),
  );
}
```

Then:
- In the per-source branch, immediately before `return res.json({ success: true })` at
  `:704`, call `await auditSettingsWrite(req, currentSettings, filteredSettings, sourceId);`
  and change the return to `return ok(res, { ignoredKeys });`.
- Replace the inline block at `:939-963` with
  `await auditSettingsWrite(req, currentSettings, filteredSettings, null);`.

**Constraints:**
- `action` stays `'settings_updated'` and `resource` stays `'settings'` so existing audit-log
  filters and the security digest keep matching. The `sourceId` goes in `details`.
- `details` for the global path changes from `{"keys":[...]}` to `{"sourceId":null,"keys":[...]}`.
  Check `settingsRoutes.test.ts` for an assertion on that exact string before changing it;
  if one exists, update it in the same commit.
- The helper must NOT fire any of the global side-effect callbacks. It only writes the
  audit row.
- Do not move the security-digest reschedule (`:966-968`) — it is global-only and correct
  where it is.

### 3.5 `src/server/routes/settingsRoutes.ts` — `maxNodeAgeHours` range validation

Add immediately before the existing `inactiveNodeThresholdHours` block at `:283`, matching
that trio's structure but using the envelope helper (new code must, per CLAUDE.md):

```ts
    // Range-validate the node-age window (client input is min=1 max=168 —
    // SettingsTab.tsx:1882-1884). Prior to this there was no server-side check
    // at all, so an API client could store 0 or a negative value and every
    // consumer's `Date.now() - h*3600e3` window silently inverted.
    if ('maxNodeAgeHours' in filteredSettings) {
      const hours = parseInt(filteredSettings.maxNodeAgeHours, 10);
      if (isNaN(hours) || hours < 1 || hours > 168) {
        return fail(res, 400, 'INVALID_MAX_NODE_AGE_HOURS',
          'maxNodeAgeHours must be between 1 and 168 hours');
      }
    }
```

`fail()` emits `{ success: false, error, code }`; the existing tests in this file assert on
`res.body.error`, which is preserved. Do **not** convert the neighbouring
`inactiveNode*`/`lowBattery*` blocks to `fail()` in this phase — that is churn in a file two
other work items already touch.

### 3.5b `localStatsIntervalMinutes` never reaches the saved source's manager

**Correction to an earlier reading of this defect.** The problem is *not* that
`settingsRoutes.ts:776` omits a `sourceId` argument. Line 776 sits in the **global** branch,
below the per-source early return at `:704`, so `sourceId` is provably `null` there — and
its two neighbours that *do* pass it (`setRemoteAdminScannerInterval` at `:769`,
`setAutomationAirtimeCutoffThreshold` at `:783`) are therefore also always passing `null`.
Adding the argument at `:776` alone would change nothing whatsoever.

**The actual gap:** the per-source branch (`:650-705`) has **no
`localStatsIntervalMinutes` handler at all** — verified. It handles announce, timer,
geofence, airtime-cutoff and distance-delete, but not this one. So a scoped save persists
the value and then never tells any manager about it. Combined with the fact that
`applyManagerSettings.ts:42` reads the key per-source, this is the mechanism behind the
epic's known bug #2: the setting has no effect until the source reconnects.

Fix — add the missing handler inside the per-source branch, alongside the existing
`restartAnnounceScheduler` / `restartTimerScheduler` block:

```ts
      // #4412: localStatsIntervalMinutes is read per-source by
      // applyManagerSettings.ts:42, but this branch never told the source's own
      // manager about a change — so a scoped save only took effect on reconnect.
      if ('localStatsIntervalMinutes' in filteredSettings) {
        const interval = parseInt(filteredSettings.localStatsIntervalMinutes, 10);
        if (!isNaN(interval) && interval >= 0 && interval <= 60) {
          callbacks.setLocalStatsInterval?.(interval, sourceId);
        }
      }
```

Two supporting edits:

1. `SettingsCallbacks.setLocalStatsInterval` at `settingsRoutes.ts:121` becomes
   `(interval: number, sourceId?: string | null) => void`, matching
   `setRemoteAdminScannerInterval` at `:120`.
2. `src/server/server.ts:867-868` — resolve the target manager from the registry when a
   `sourceId` is given, falling back to the current primary otherwise:

```ts
  setLocalStatsInterval: (interval, sourceId) => {
    const mgr = sourceId
      ? sourceManagerRegistry.getManager(sourceId)
      : (getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager);
    if (mgr && isMeshtasticManager(mgr)) mgr.setLocalStatsInterval(interval);
  },
```

**Why this is still safe to land in Phase 1:** no client posts
`localStatsIntervalMinutes` with `?sourceId=` until Phase 3 (`SettingsTab.tsx:904` sends it
on the unscoped save), so the new handler is unreachable in production today. It is added
now because WP2 already owns this file, the key is one of the epic's ten, and leaving it
would mean Phase 2 re-opening the same branch.

> ⚠ `src/server/server.ts` is **not** otherwise owned by any work package. Those four lines
> are the only ones WP2 may touch there. Use `isMeshtasticManager` from
> `src/server/sourceManagerTypes.ts` — never `instanceof` or an `as any` cast (CLAUDE.md);
> reuse the existing import if `server.ts` already has it. A MeshCore manager resolved by
> id has no `setLocalStatsInterval`, which is why the type guard is load-bearing rather
> than decorative.
>
> **Scope limits:** the global branch's behavior must not change — with `sourceId` null the
> expression resolves exactly as `server.ts:868` does today; assert it. And do **not**
> extend this treatment to the other unscoped callbacks in the same block
> (`setTracerouteInterval`, key-repair / inactive-node / low-battery restarts). Those are
> genuine Phase 2 work with real behavior change.

### 3.6 `src/db/repositories/settings.ts` — make `deleteSourceSettings` a single statement

Current implementation (`:238-248`) selects every settings key and issues one `DELETE` per
matching row. Replace with one prefix delete:

```ts
  /**
   * Delete all per-source settings for a source. Single statement — the previous
   * implementation read every settings key into memory and issued one DELETE per
   * match, which is the per-row round-trip pattern that made migration 030 a
   * startup hazard (#4233).
   *
   * `_` and `%` are LIKE wildcards; source ids are UUIDs today, but escape
   * defensively so a future non-UUID id cannot over-match a sibling namespace.
   */
  async deleteSourceSettings(sourceId: string): Promise<void> {
    const { settings } = this.tables;
    const escaped = this.sourcePrefix(sourceId).replace(/([\\%_])/g, '\\$1');
    await this.db.delete(settings).where(sql`${settings.key} LIKE ${escaped + '%'} ESCAPE '\\'`);
  }
```

Add `sql` to the `drizzle-orm` import at `:7`. `ESCAPE '\'` is supported by SQLite,
PostgreSQL and MySQL. **Verify the emitted SQL on all three backends via the
`settings.test.ts` multi-backend harness** — this is the one place in Phase 1 where a
dialect difference could bite. If `ESCAPE` proves awkward under Drizzle on any backend,
the acceptable fallback is `like(settings.key, prefix + '%')` with the escaping dropped
**and** a comment recording that source ids are UUIDs; do not fall back to the row loop.

### 3.7 `src/services/database.ts` — facade + cache eviction

The repo method alone leaves the PG/MySQL `settingsCache` (`:374`) holding stale
`source:{id}:*` entries, which the sync read path (`getSettingForSourceSync`, `:3153`)
would still serve. Add next to the other settings facade methods:

```ts
  /**
   * Delete every `source:{id}:*` settings row and evict the matching sync-cache
   * entries. Called when a source is deleted (sourceRoutes DELETE /:id) so the
   * namespace does not outlive the source.
   *
   * The cache is PG/MySQL-only (see settingsCache) but evicting unconditionally
   * is harmless on SQLite, where the map is never populated.
   */
  async deleteSourceSettingsAsync(sourceId: string): Promise<void> {
    if (!this.settingsRepo) return;
    await this.settingsRepo.deleteSourceSettings(sourceId);
    const prefix = `source:${sourceId}:`;
    for (const key of [...this.settingsCache.keys()]) {
      if (key.startsWith(prefix)) this.settingsCache.delete(key);
    }
  }
```

Follows the CLAUDE.md rule "expose through DatabaseService with an `Async` suffix".

### 3.8 `src/server/routes/sourceRoutes.ts` — call it on delete

In `DELETE /:id`, after the successful `deleteSource` + `purgeAllNodesAsync` block
(`:894-908`), before `res.json({ success: true })`:

```ts
    // #4412: deleteSource only removes the `sources` row. Every
    // `source:{id}:{key}` settings row would otherwise be orphaned forever with
    // no UI path left to reach it — and a namespace whose values could be
    // resurrected by a future source that reused the id. Best-effort, matching
    // the node purge above: a cleanup failure must not fail the delete.
    try {
      await databaseService.deleteSourceSettingsAsync(req.params.id);
    } catch (settingsError) {
      logger.warn(`Failed to purge settings for deleted source ${req.params.id}:`, settingsError);
    }
```

**Placement matters:** it must be *inside* the `if (!deleted) return 404` guard's success
path — i.e. after `:894`. Deleting a nonexistent source must not wipe a namespace.

### 3.9 `src/server/migrations/131_seed_per_source_node_display.ts` (NEW)

See §5 for full structure and §6.4 for its tests.

### 3.10 `src/db/migrations.ts` — register 131

Import at the tail of the import block (following the 130 line at `:147`) and append the
registration block at end of file, matching the surrounding comment style:

```ts
// ---------------------------------------------------------------------------
// Migration 131: seed the per-source Node Display settings (#4412). Copies the
// current global value (or the documented default) into `source:{id}:{key}` for
// every existing source and all ten Node Display keys, so Phase 2's per-source
// reads — which deliberately have no global fallback (#2839) — do not silently
// fall back to hardcoded defaults on upgrade. Insert-if-absent: never clobbers a
// value a user already set per-source.
// ---------------------------------------------------------------------------

registry.register({
  number: 131,
  name: 'seed_per_source_node_display',
  settingsKey: 'migration_131_seed_per_source_node_display',
  sqlite: (db) => seedPerSourceNodeDisplayMigration.up(db),
  postgres: (client) => runMigration131Postgres(client),
  mysql: (pool) => runMigration131Mysql(pool),
});
```

Confirmed 131 is the next free number: the highest registered is 130
(`130_add_waypoint_channel.ts`), and `migrations.test.ts:16-19` asserts
`highest number === registry count` with no gaps.

---

## 4. The allowlist test (work item 2) — shape and justification

### 4.1 Why a plain subset assertion is the wrong test

`PER_SOURCE_SETTINGS_KEYS ⊆ VALID_SETTINGS_KEYS` **fails today**, because several
per-source keys are written exclusively by dedicated routes via `setSourceSetting`, never
through `POST /api/settings`, and so were never added to the POST allowlist. Weakening the
assertion to make it pass (e.g. filtering out the failures inline) makes it vacuous.

**Specified test: exact equality against a documented, named exemption set.**

```ts
// src/server/constants/settings.allowlist.test.ts  (NEW)
const valid = new Set<string>(VALID_SETTINGS_KEYS as readonly string[]);
const missing = PER_SOURCE_SETTINGS_KEYS.filter((k) => !valid.has(k)).sort();

it('every per-source key is either POST-able or a documented exemption', () => {
  expect(missing).toEqual([...PER_SOURCE_KEYS_NOT_POSTABLE].sort());
});
```

Exact equality (not `⊇`, not `⊆`) is what makes it meaningful in both directions:

- Add a new per-source key and forget `VALID_SETTINGS_KEYS` → the test fails until you
  either add it to the allowlist or consciously classify it as route-written. This is the
  exact class of bug ARCHITECTURE_LESSONS §"Settings Allowlist" documents.
- A key later gains a `POST` path and is added to `VALID_SETTINGS_KEYS` → the test fails
  until the stale exemption is removed, so the list cannot rot.

**Procedure for WP1 (mechanical, not from memory):** compute `missing` with a throwaway
script and compare against the 18 keys listed in §3.1(d). If parsing the arrays with a
regex, **strip comments first** — apostrophes inside the file's `//` comments otherwise
produce false matches. Any key in `missing` that turns out to be POSTed by the UI would be
**a real bug** (silently dropped today); do not paper over it by adding it to the exemption
set — add it to `VALID_SETTINGS_KEYS`, note it in the PR body, and flag it to the
orchestrator rather than absorbing a behavior change into Phase 1. The audit found **no
such key**, so this branch should not trigger.

**Related existing guard — do not duplicate it.**
`src/server/server.settings-persistence.test.ts:381` already asserts "every key
`SettingsTab` sends is in `VALID_SETTINGS_KEYS`". That covers the *global* save path from
one component. The new test covers a different invariant (per-source legality vs. the POST
allowlist) and the two are complementary; neither replaces the other.

### 4.2 Companion assertions in the same file

```
1. GLOBAL_ONLY_SETTINGS_KEYS ⊆ VALID_SETTINGS_KEYS.
   (A deny-list entry outside the allowlist is dead weight — it can never match.)
2. GLOBAL_ONLY_SETTINGS_KEYS ∩ PER_SOURCE_SETTINGS_KEYS = ∅.
   (A key in both is a direct contradiction: the server reads it per-source AND we
   refuse to let it be written per-source. This is the assertion that would catch an
   over-eager deny-list entry — the one failure mode of the default-allow design.)
3. GLOBAL_ONLY_SETTINGS_KEYS contains NONE of the ten keys in §2.1's table, asserted by
   literal name. THE REGRESSION PIN for the whole §2.1 audit: this is what stops a
   future contributor from "tidying up" telemetryFavorites or dashboardWidgets into the
   deny-list and reintroducing the silent data loss.
4. No duplicates within PER_SOURCE_SETTINGS_KEYS or within VALID_SETTINGS_KEYS.
   (Guards the `localStatsIntervalMinutes` double-add hazard called out in §3.1a.)
5. All ten Node Display keys are in BOTH PER_SOURCE_SETTINGS_KEYS and
   VALID_SETTINGS_KEYS, and in NEITHER GLOBAL_ONLY_SETTINGS_KEYS nor
   PER_SOURCE_KEYS_NOT_POSTABLE — pinned by literal name, so a future refactor cannot
   quietly un-scope the group this epic exists to scope.
```

Assertion 3 is the load-bearing one under the inverted design. The allow-list version of
this spec needed the audit to be *complete*; the deny-list version only needs it to be
*correct about the keys it names* — and assertion 3 is what freezes that correctness.

---

## 5. Migration 131 — structure

### 5.1 Seed contents

Ten keys × every row in `sources`. Value = the current **global** row for that key if one
exists, else the documented default. Insert-if-absent, keyed on the `settings.key` PK.

All ten defaults below were **verified against source**; client and server agree everywhere
(no disagreements found). Citations are the authoritative definition site.

| Key | Default | Verified at | Wire format |
|---|---|---|---|
| `maxNodeAgeHours` | `'24'` | client `SettingsContext.tsx:339`; server `services/database.ts:2031,2149,2211`, `meshtasticManager.ts:3226`, `virtualNodeServer.ts:806`, `pollRoutes.ts:438`, `tracerouteRoutes.ts:19`, `sourceDashboardData.ts:44` — **8 independent hardcoded `24`s, all in agreement** | integer string |
| `inactiveNodeThresholdHours` | `'24'` | `SettingsContext.tsx:348`; server `server.ts:388` and `settingsRoutes.ts:842-847` | integer string |
| `inactiveNodeCheckIntervalMinutes` | `'60'` | `SettingsContext.tsx:353`; server `server.ts:390` and `settingsRoutes.ts:848-853` | integer string |
| `inactiveNodeCooldownHours` | `'24'` | `SettingsContext.tsx:358`; server `server.ts:393` and `settingsRoutes.ts:854-859` | integer string |
| `localStatsIntervalMinutes` | `'15'` | `SettingsTab.tsx:387,519`; server field default `meshtasticManager.ts:734` (`= 15`). ⚠ **The trailing comment on that line says "Default 5 minutes" and is stale — the value is 15.** `applyManagerSettings.ts:42-46` supplies no fallback (skips on null, so 15 stands) | integer string |
| `nodeHopsCalculation` | `'nodeinfo'` | `SettingsContext.tsx:544` (anything not `traceroute`/`messages` → `nodeinfo`); no server read exists | enum `nodeinfo`\|`traceroute`\|`messages` |
| `hideIncompleteNodes` | `'0'` | `UIContext.tsx:101` (`showIncompleteNodes = true` ⇒ hide = false); written `SettingsTab.tsx:902`, read `App.tsx:1230` / `SettingsTab.tsx:486`; no server read exists | **`'1'`/`'0'`, NOT `'true'`/`'false'`** |
| `nodeDimmingEnabled` | `'0'` | `SettingsContext.tsx:529`; written `SettingsTab.tsx:907`, read `SettingsContext.tsx:1674` / `SettingsTab.tsx:530` (accepts both `'1'` and `'true'`); no server read exists | **`'1'`/`'0'`** |
| `nodeDimmingStartHours` | `'1'` | `SettingsContext.tsx:534`; clamp fallback `SettingsTab.tsx:2009`; no server read exists | float string, range 0.5-24 |
| `nodeDimmingMinOpacity` | `'0.3'` | `SettingsContext.tsx:539`; clamp fallback `SettingsTab.tsx:2025`; no server read exists | float string, range 0.1-0.9 |

> **Traps confirmed during verification, relevant to WP4:**
> - Five of these keys (`nodeHopsCalculation`, `hideIncompleteNodes`, `nodeDimming*`) have
>   **no server-side read at all** today. That is fine — they are stored server-side and
>   consumed client-side, and Phase 3 is what makes the per-source read happen. Seeding
>   them now is still correct and is what makes Phase 3 a pure frontend change.
> - `SettingsContext.tsx:1353` and `App.tsx:972` gate on truthiness
>   (`if (settings.maxNodeAgeHours)`), so a stored `'0'` is ignored. Never seed `'0'` for a
>   numeric key. (The two booleans are exempt — their readers compare to the literal `'1'`.)
> - WP4 must re-confirm each default against the cited line before writing the file and
>   record any discrepancy in the epic's Deviations log.

### 5.2 Anti-pattern to avoid: importing the constants

**Migration 131 MUST inline its own key list and defaults.** Do not
`import { PER_SOURCE_SETTINGS_KEYS } from '../constants/settings.js'` the way migration
050 does.

A migration is a statement about a point in time. 050's import means that on any fresh
install — where migrations replay from scratch (CLAUDE.md: `createTables` was deleted in
#3962, so fresh installs *are* a migration replay) — 050 runs against whatever the array
contains *today*, not what it contained when 050 shipped. That drift is invisible and
unbounded. 131 has a fixed, ten-item scope; inline it as a `const` in the migration file
and let the constants file evolve independently.

### 5.3 Shared pure function (testable without a DB)

Following 093's `computeMigrationInserts`:

```ts
export interface SettingRow { key: string; value: string }

/** Ten Node Display keys and their documented defaults. Frozen at migration time. */
export const NODE_DISPLAY_SEED: ReadonlyArray<readonly [key: string, fallback: string]> = [...];

/**
 * Given every source id and the current global values for the seeded keys,
 * produce the `source:{id}:{key}` rows to insert. Pure and total — the caller's
 * INSERT-if-absent provides idempotency. Exported for unit testing.
 */
export function computeSeedInserts(
  sourceIds: string[],
  globals: Record<string, string>,
): SettingRow[] {
  const out: SettingRow[] = [];
  for (const id of sourceIds) {
    for (const [key, fallback] of NODE_DISPLAY_SEED) {
      out.push({ key: `source:${id}:${key}`, value: globals[key] ?? fallback });
    }
  }
  return out;
}
```

Plus a local `chunk<T>(items, size)` copied from
`030_add_source_id_to_route_segments.ts:273-280`, and `const SEED_BATCH_SIZE = 200;`
(200 rows × 4 bound params = 800 placeholders, comfortably inside PG's 65535 limit and
MySQL's `max_allowed_packet`).

### 5.4 Per-backend implementations

All three share this sequence:

1. **`SELECT id FROM sources` → `sourceIds`. Source enumeration is TABLE-DRIVEN, not
   prefix-derived.** This is the load-bearing difference from migration 093, which groups
   by prefixes discovered in existing `settings` rows. A source that has never had a single
   setting written has **zero** `source:{id}:` rows, so a 093-style prefix scan would skip
   it entirely — and that is the common case for a freshly-added second source, which is
   exactly who this epic is for. Never derive the source list from settings keys.
   Wrap in try/catch; if the table is missing (pre-020 database) log at debug and return.
   If empty, return — **never synthesize a source** (that is `_legacyDefaultSource`'s job,
   and it is wrong here; see §0.3).
2. Read the ten global rows in ONE query: `SELECT key, value FROM settings WHERE key IN (…)`
   with bound parameters, into `globals`.
3. `computeSeedInserts(sourceIds, globals)`.
4. Insert in batches with insert-if-absent, always binding `createdAt`/`updatedAt` to a
   single `Date.now()` captured before the loop.
5. `logger.info` the count.

| Backend | Insert form | Notes |
|---|---|---|
| SQLite (`export const migration = { up(db) }`) | `INSERT OR IGNORE INTO settings (key, value, createdAt, updatedAt) VALUES (?,?,?,?)` inside `db.transaction(...)` | Prepared statement reused across rows inside a single transaction — exactly 093's shape. Batching the SQL text is unnecessary here (no round trips); the transaction is what matters. |
| PostgreSQL (`runMigration131Postgres(client)`) | multi-row `INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4),(…) ON CONFLICT (key) DO NOTHING` | Quote `"createdAt"`/`"updatedAt"` (camelCase). Build `$n` placeholders per 030:350-358. Wrap the whole run in `BEGIN`/`COMMIT` with `ROLLBACK` on error, per 050:124-183. |
| MySQL (`runMigration131Mysql(pool)`) | multi-row `INSERT IGNORE INTO settings (\`key\`, value, createdAt, updatedAt) VALUES (?,?,?,?),(…)` | Backtick `key` (reserved word). `pool.getConnection()` + `beginTransaction`/`commit`/`rollback` + `finally { conn.release() }`, per 050:195-259. |

### 5.5 Idempotency

Three layers, all required:
- The registry `settingsKey` (SQLite inline check; PG/MySQL via `migrationLedger`).
- `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` / `INSERT IGNORE` on the `key` PK.
- No `DELETE`, no `UPDATE`, no table rebuild anywhere in the migration.

A second run must insert 0 rows and must never overwrite a value a user has already set
per-source. **Assert this explicitly in the test.**

---

## 6. Test plan

All tests are standard Vitest files in the existing suite. **No standalone scripts.**

### 6.1 New files

| File | Contents |
|---|---|
| `src/server/constants/settings.allowlist.test.ts` | §4.1 exact-equality test + the five companion assertions in §4.2. Pure constant assertions; no DB, no mocks. |
| `src/server/routes/settingsRoutes.perSource.test.ts` | Harness-based (`createRouteTestApp`). See §6.3. |
| `src/server/migrations/131_seed_per_source_node_display.test.ts` | SQLite (real in-memory DB) + pure-function tests. See §6.4. |
| `src/server/migrations/131_seed_per_source_node_display.pgmysql.test.ts` | PG/MySQL. See §6.4. |

### 6.2 Extended files

| File | Additions |
|---|---|
| `src/server/routes/settingsRoutes.test.ts` | (a) `maxNodeAgeHours` range validation: `0`, `169`, `'abc'`, `''` → 400 with `code: 'INVALID_MAX_NODE_AGE_HOURS'`; `1`, `24`, `168` → 200. (b) global-only key dropped under `?sourceId=`: assert `setSourceSettings` called **without** `cotFeedEnabled`, response 200, `body.data.ignoredKeys` contains `'cotFeedEnabled'`. (c) per-source audit log fires: `auditLogAsync` called once with `action === 'settings_updated'` and `JSON.parse(details).sourceId === 'mqtt-broker-1'`. (d) **regression pin** — POST all ten §2.1 keys with `?sourceId=` and assert every one reaches `setSourceSettings` and `ignoredKeys` is empty. (e) **default-allow pin** — POST an invented-but-valid per-source key that is in `VALID_SETTINGS_KEYS` and in neither `PER_SOURCE_SETTINGS_KEYS` nor `GLOBAL_ONLY_SETTINGS_KEYS` (e.g. `temperatureUnit`) with `?sourceId=` and assert it **is** written. This pins the polarity itself: it fails if anyone re-inverts the filter to an allow-list. (f) global POST is byte-identical: `setSettings` receives the same object as before, response still `{ success: true, settings }`, `ignoredKeys` absent. (g) `setLocalStatsInterval` (§3.5b) is called with `(interval, null)` on a global save and with `(interval, 'mqtt-broker-1')` on a scoped save. |
| `src/db/repositories/settings.test.ts` | Inside `runSettingsTests(getBackend)` so it runs on all three backends: `deleteSourceSettings` removes only the target prefix; leaves global rows and a *sibling* source's rows intact; is a no-op on an unknown sourceId; handles a sourceId containing `_` without deleting a lookalike namespace (the LIKE-escape case from §3.6). |
| `src/server/routes/sourceRoutes.test.ts` (or the nearest existing sourceRoutes test — if it uses the legacy mock pattern, put these in a new harness-based `sourceRoutes.settingsCleanup.test.ts` instead) | Deleting a source removes its `source:{id}:*` rows; a second source's rows survive; a 404 delete purges nothing; a throwing purge does not fail the request (still 200). |

### 6.3 `settingsRoutes.perSource.test.ts` (harness-based — mandatory per CLAUDE.md)

```ts
harness = await createRouteTestApp({ mount: app => app.use('/api/settings', settingsRoutes) });
```

1. **Per-source permission scoping (epic bug #4).** `grant(limited.id, 'settings', 'write', harness.sourceA)`.
   `POST /api/settings?sourceId=<sourceA>` → 200. `POST /api/settings?sourceId=<sourceB>` → **403**.
   This is the assertion the whole work item exists for, and it is only trustworthy through
   the harness — real `checkPermissionAsync` against real permission rows.
2. **Global write still works for a globally-granted user.** `grant(limited.id, 'settings', 'write')`
   (no sourceId) → `POST /api/settings` (no query) → 200. **The no-regression guard for §3.3.**
3. A source-scoped grant does **not** authorize a global write → 403.
   (Read `permissions.ts` first: if source-scoped grants are designed to imply the global
   scope, assert the actual designed behavior and record it in the spec's deviations log
   rather than forcing this expectation.)
4. Admin bypasses both, scoped and unscoped.
5. **Namespace isolation:** write `maxNodeAgeHours=48` to sourceA and `=12` to sourceB,
   then assert via `harness.db.settings.getSettingForSource` that each source reads back
   its own value and that the **global** `maxNodeAgeHours` row is untouched. This is the
   per-source isolation test the epic requires.
6. `?sourceId=a&sourceId=b` → 400 `BAD_REQUEST` (documents the §3.3 array case).

### 6.4 Migration 131 tests

**`131_….test.ts` (SQLite + pure function, always runs):**
- `computeSeedInserts([], {})` → `[]`.
- `computeSeedInserts(['s1','s2'], {})` → 20 rows, all defaults, correct `source:{id}:{key}` keys.
- `computeSeedInserts(['s1'], { maxNodeAgeHours: '72' })` → the global wins for that key,
  defaults for the other nine.
- Real in-memory `better-sqlite3`: create `sources` + `settings` (copy the DDL bootstrap
  from `130_add_waypoint_channel.test.ts:9-28`), insert **three** sources — one with a
  pre-existing `source:{id}:maxNodeAgeHours = '99'` override, one with none, one created
  after a global `maxNodeAgeHours='72'` was set — then run `migration.up(db)` and assert:
  - every source × every key has a row;
  - the pre-existing `'99'` override is **untouched**;
  - the global `'72'` was propagated;
  - the un-set keys got the documented defaults, with `'0'` (not `'false'`) for the two
    booleans;
  - the un-namespaced global rows are unchanged;
  - `createdAt`/`updatedAt` are non-null on every inserted row.
- **Idempotency:** run `up()` twice; row count identical, `'99'` still `'99'`.
- **Empty `sources` table:** `up()` inserts nothing and does not throw.
- **Missing `sources` table:** `up()` does not throw.

**`131_….pgmysql.test.ts`:**
- *Always-run half* — fake PG client / MySQL pool per
  `030_route_segments_rebuild.pgmysql.test.ts:43-80`. Assert: exactly one `SELECT id FROM sources`,
  exactly one `SELECT … settings WHERE key IN`, and that the inserts are **batched** — the
  number of `INSERT` statements for 50 sources (500 rows) is `ceil(500/SEED_BATCH_SIZE)`,
  **not** 500. This is the #4233 guard and must be an explicit assertion. Also assert the PG
  statement quotes `"createdAt"`/`"updatedAt"` and carries `ON CONFLICT (key) DO NOTHING`,
  and the MySQL statement backticks `` `key` `` and uses `INSERT IGNORE`.
- *Container half* — `describe.skipIf(!postgresAvailable)` / `!mysqlAvailable` using
  `createPostgresBackend` / `createMysqlBackend` from `src/db/repositories/test-utils.ts`.
  Create minimal `sources` + `settings` tables, run the real
  `runMigration131Postgres(client)` / `runMigration131Mysql(pool)`, and assert the same
  seed/override/idempotency invariants as the SQLite half.
  **CLAUDE.md warning applies:** these skip silently with no containers. Both containers are
  up in this environment (`mm-test-pg` :5433, `mm-test-mysql` :3307) — confirm coverage via
  `numPendingTests` in the JSON reporter, not just `success: true`.

### 6.5 Suite-level gates (every work package)

```bash
npx tsc --noEmit
npx vitest run <the files you touched>
# and, before the package is called done:
npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'   # must be empty
```

Full suite with both containers up is WP5's job, not each package's.

---

## 7. Work packages

Five packages. Dependency edges are read-dependencies only except where noted.

```
WP1 (constants) ──► WP2 (route hardening) ──┐
WP3 (source-delete settings cleanup) ───────┼──► WP5 (integration + verification)
WP4 (migration 131) ────────────────────────┘
```

**WP3 and WP4 may start immediately, in parallel with WP1.** WP2 must wait for WP1 to land
(it imports two new constants). WP5 runs last.

### File ownership — no file is written by two packages

| File | Owner |
|---|---|
| `src/server/constants/settings.ts` | **WP1** |
| `src/server/constants/settings.allowlist.test.ts` (new) | **WP1** |
| `src/server/routes/settingsRoutes.ts` | **WP2** |
| `src/server/routes/settingsRoutes.test.ts` | **WP2** |
| `src/server/routes/settingsRoutes.perSource.test.ts` (new) | **WP2** |
| `src/server/server.ts` — **only** the `setLocalStatsInterval` callback, §3.5b | **WP2** |
| `src/db/repositories/settings.ts` | **WP3** |
| `src/db/repositories/settings.test.ts` | **WP3** |
| `src/services/database.ts` | **WP3** |
| `src/server/routes/sourceRoutes.ts` | **WP3** |
| sourceRoutes settings-cleanup test | **WP3** |
| `src/server/migrations/131_*.ts` + its 2 test files (new) | **WP4** |
| `src/db/migrations.ts` | **WP4** |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` (Deviations log) | **WP5** |

> ⚠ **Merge hazards, explicit:**
> - `src/server/routes/settingsRoutes.ts` is touched by five *work items* (deny-list key
>   filter, permission scoping, audit restructure, `maxNodeAgeHours` validation, and the
>   §3.5b per-source `localStatsIntervalMinutes` handler) — all five are deliberately
>   bundled into **WP2** so only one agent ever edits that file. Do not split them.
> - `src/server/constants/settings.ts` (WP1) and `src/db/migrations.ts` (WP4) are both
>   append-heavy; they are in different packages but never the same file.
> - WP2 *reads* WP1's exports. If run in parallel anyway, WP2 will not compile. Sequence it.

### WP1 — Per-source key constants and the allowlist test

**Files:** `src/server/constants/settings.ts`; new `src/server/constants/settings.allowlist.test.ts`.
**Depends on:** nothing.

**Work:** §3.1 (a)–(c) and §4.1–§4.2.

**Acceptance criteria**
1. The 9 missing Node Display keys are in `PER_SOURCE_SETTINGS_KEYS`;
   `localStatsIntervalMinutes` appears exactly once in the array.
2. `GLOBAL_ONLY_SETTINGS_KEYS` is exported and contains only keys that pass **both**
   admission tests in its doc comment. Every entry cites its evidence. The set contains
   **none** of the ten keys in §2.1's table.
3. No `PER_SOURCE_CLIENT_ONLY_SETTINGS_KEYS` or `SOURCE_SCOPED_POSTABLE_SETTINGS_KEYS`
   array exists — the design is a single deny-list (§2.2). A diff that reintroduces an
   allow-list is a review blocker.
4. `PER_SOURCE_KEYS_NOT_POSTABLE` was populated by *computing* the set difference (expect
   18 keys), and every entry carries a comment naming the route/service that writes it.
   `externalUrl` carries the known-orphan comment from §3.1(c) verbatim — it is documented,
   not legitimized. If any key in the difference turns out to be POSTed by the UI, it was
   added to `VALID_SETTINGS_KEYS` (not to the exemption set) and called out in the PR body.
5. `settings.allowlist.test.ts` passes: §4.1's exact-equality test plus all five companion
   assertions from §4.2, including assertion 3 (the §2.1 regression pin) and assertion 2
   (`GLOBAL_ONLY ∩ PER_SOURCE = ∅`).
6. `src/server/services/automation/autoAckParity.test.ts` **still passes unmodified.**
   If it does not, `autoAckTestMessages` was wrongly added to `PER_SOURCE_SETTINGS_KEYS`
   — revisit §2.2.
7. `npx tsc --noEmit` clean; `lint:ci` (worktree-filtered) clean.

### WP2 — Route hardening: key filter, permission scoping, audit, validation

**Files:** `src/server/routes/settingsRoutes.ts`, `settingsRoutes.test.ts`;
new `settingsRoutes.perSource.test.ts`; **4 lines of `src/server/server.ts`** (§3.5b only).
**Depends on:** WP1 (imports `GLOBAL_ONLY_SETTINGS_KEYS`). **Sequential after WP1.**

**Work:** §3.2, §3.3, §3.4, §3.5, §3.5b; tests §6.2 (settingsRoutes.test.ts rows a–g)
and §6.3.

**Acceptance criteria**
1. Per-source POST filters `VALID_SETTINGS_KEYS` minus `GLOBAL_ONLY_SETTINGS_KEYS`
   (**deny-list — see §2.2**); global POST is byte-for-byte unchanged in both filter set
   and response shape.
2. `ignoredKeys` is returned via `ok(res, { ignoredKeys })` and a `logger.warn` fires when
   non-empty. **No path returns 400 for a dropped key.**
3. The two pre-existing tests at `settingsRoutes.test.ts:600-609` and `:661-669` still
   pass **unmodified**.
4. All ten §2.1 keys still reach `setSourceSettings` under `?sourceId=` (§6.2d), **and**
   a valid key in neither constant list is still written per-source (§6.2e — the polarity
   pin).
5. `requirePermission('settings','write',{ sourceIdFrom: 'query' })`; `requireSourceId` is
   NOT set; the harness test proves sourceA-granted → 200 on sourceA, 403 on sourceB, and
   that a global write by a globally-granted user still returns 200.
6. Per-source writes produce exactly one `auditLogAsync` call with
   `action: 'settings_updated'` and `sourceId` inside `details`; the global path's audit
   still fires and fires **only once**.
7. The per-source branch fires **no** *global* side-effect callback (`restartCotFeed`,
   `restartInactiveNodeService`, `setKeyRepairSettings`, `restartLowBatteryService`,
   `securityDigestService.reschedule`, …). Assert at least `restartCotFeed`,
   `restartInactiveNodeService`, and `setKeyRepairSettings` are not called.
   **Note:** `setLocalStatsInterval` is now deliberately called from the per-source branch
   (§3.5b) — it is a *per-source* side effect, so it must NOT be in this not-called list.
8. §3.5b: the per-source branch calls `setLocalStatsInterval(interval, sourceId)`; the
   global branch still calls it with a null sourceId and resolves the primary manager
   exactly as before; `server.ts` narrows with `isMeshtasticManager` and touches no other
   line.
9. `maxNodeAgeHours` out of 1-168 → 400 `INVALID_MAX_NODE_AGE_HOURS` via `fail()`;
   in-range values pass.
10. `npx tsc --noEmit` clean; `lint:ci` clean; the whole `settingsRoutes*` test set green,
    plus `src/server/applyManagerSettings.test.ts` and any `server.ts` callback test.

### WP3 — Source deletion drops its settings namespace

**Files:** `src/db/repositories/settings.ts`, `settings.test.ts`, `src/services/database.ts`,
`src/server/routes/sourceRoutes.ts`, + a sourceRoutes settings-cleanup test.
**Depends on:** nothing. **Parallel-safe with WP1/WP2/WP4.**

**Work:** §3.6, §3.7, §3.8; tests §6.2 (settings.test.ts and sourceRoutes rows).

**Acceptance criteria**
1. `deleteSourceSettings` is a single `DELETE` statement — no select-then-loop, no per-row
   round trip — and passes on **all three backends** in `settings.test.ts` (PG and MySQL
   confirmed *run*, not skipped).
2. Prefix matching cannot bleed into a sibling namespace, including for a sourceId
   containing a LIKE wildcard character.
3. `deleteSourceSettingsAsync` exists on `DatabaseService`, calls the repo, and evicts
   `source:{id}:*` from `settingsCache`.
4. `DELETE /api/sources/:id` calls it on the success path only; a 404 delete purges nothing;
   a thrown cleanup error is logged and the request still returns 200.
5. New/changed route tests use `createRouteTestApp()`.
6. `npx tsc --noEmit` clean; `lint:ci` clean.

### WP4 — Migration 131

**Files:** new `src/server/migrations/131_seed_per_source_node_display.ts` and its two test
files; `src/db/migrations.ts`.
**Depends on:** nothing (§5.2: the migration inlines its own key list).
**Parallel-safe with WP1/WP2/WP3.**

**Work:** §3.9, §3.10, §5; tests §6.4.

**Acceptance criteria**
1. Every source in `sources` — not just the default — gets all ten keys, and the source
   list comes from **`SELECT id FROM sources`**, never from scanning `settings` key
   prefixes. Pinned by a test in which one seeded source has **zero** pre-existing
   `source:{id}:*` rows and still receives all ten (§6.4).
2. Global value wins over the default; existing `source:{id}:{key}` overrides are never
   clobbered.
3. Boolean seeds are `'0'`, not `'false'`. **Every default in §5.1 was re-verified against
   source before writing**; any discrepancy is recorded in the epic's Deviations log.
4. All three backends implemented, registered with a `settingsKey`, and idempotent —
   running twice inserts nothing the second time.
5. Inserts are **batched**; the fake-client test asserts statement count is
   `ceil(rows/SEED_BATCH_SIZE)`, not one per row.
6. Reads are batched too: exactly one `SELECT id FROM sources` and one
   `SELECT … WHERE key IN (…)` per run.
7. Missing or empty `sources` table → no-op, no throw, no synthesized source.
8. The migration does **not** import `PER_SOURCE_SETTINGS_KEYS` or any other mutable
   constant.
9. `src/db/migrations.test.ts` passes without edits.
10. Container-backed PG and MySQL halves actually **ran** (verify via `numPendingTests`).
11. `npx tsc --noEmit` clean; `lint:ci` clean.

### WP5 — Integration, cross-package invariant, and verification

**Files:** may add ONE cross-cutting test file
(`src/server/constants/perSourceNodeDisplay.integration.test.ts`); updates the epic's
Deviations log.
**Depends on:** WP1, WP2, WP3, WP4 all merged.

**Work**
1. **Cross-package invariant test** (this is why WP5 is a package, not a checklist): assert
   that migration 131's inlined `NODE_DISPLAY_SEED` key list is exactly the ten keys, and
   that every one of them is present in **both** `PER_SOURCE_SETTINGS_KEYS` and
   `VALID_SETTINGS_KEYS` — i.e. the migration seeds keys the route will actually accept
   per-source and the server will actually read per-source in Phase 2. §5.2 deliberately
   decouples the migration from the constants; this test is what keeps the decoupling
   honest without recoupling the code.
2. Full Vitest suite with both containers up. Confirm via the JSON reporter that
   `success === true` **and** that `numPendingTests` did not jump (i.e. PG/MySQL suites ran).
   Per the memory note, `PASS (N) FAIL (0)` from a wrapper is not sufficient evidence.
3. `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty.
4. `npx tsc --noEmit` → clean.
5. **Manual no-change verification** (Phase 1 promises no user-visible change): deploy the
   dev container per the `deploy` skill (`-f docker-compose.dev.local.yml`), log in, and
   confirm Settings → Node Display renders and saves exactly as on `main`, and that the
   Dashboard's per-source widget/favorite/solar toggles still persist across a reload —
   that last one is the direct check on §2.1's breakage list.
6. Record deviations (defaults that differed, the `PER_SOURCE_KEYS_NOT_POSTABLE`
   composition, any category-(c) bug WP1 surfaced) in the epic's Deviations log.

**Acceptance criteria:** all six items done; suite green with PG+MySQL confirmed running;
no console errors in the browser check; Deviations log updated.

---

## 8. Risks and open questions for the orchestrator

1. **RESOLVED — the audit is no longer a single point of failure.** An earlier draft
   specified a default-deny allow-list, which would have made this phase's safety depend on
   the §2.1 audit being *complete*. Inverting to the `GLOBAL_ONLY_SETTINGS_KEYS` deny-list
   (§2.2) changes the failure mode from silent data loss to a harmless junk row, so the
   audit now only needs to be *correct about the keys it names* — and §4.2 assertion 3
   freezes that. No warn-only staging is needed; the filter ships enforced in Phase 1 as
   the epic intends.
   **Residual risk, small and accepted:** a global-only key added after Phase 1 remains
   writable into a source namespace until someone adds it to the deny-list. That is the
   status quo today, so it is not a regression — but it does mean work item 3 closes the
   hole for the 18 keys we enumerated, not for all future ones. The `logger.warn` and
   `ignoredKeys` give operators visibility into what *is* being dropped.

2. **`?sourceId=a&sourceId=b` now 400s** where it previously fell through to a global write.
   This is a correctness improvement and no legitimate client sends a duplicate param, but
   it is technically a behavior change in a "no user-visible change" phase. Called out
   rather than hidden.

3. **Audit-log `details` shape changes** for global saves (`{"keys":[…]}` →
   `{"sourceId":null,"keys":[…]}`). If anything parses that string — a report, a dashboard,
   a security-digest formatter — it needs updating. WP2 must grep for consumers before
   changing it; if a consumer exists, the fallback is to omit `sourceId` when null.

4. **Migration 131 fires on every existing install** and writes 10 × (number of sources)
   rows. On the largest plausible deployment (say 20 sources) that is 200 rows in one or
   two batched statements — trivial. Flagged only because #4233 makes any settings-table
   migration worth a second look.

5. **Phase 2 sequencing is load-bearing and unchanged.** After Phase 1 the data is seeded
   but nothing reads it per-source, and `GET /api/settings?sourceId=` still merges globals
   *under* per-source overrides — so the UI keeps showing the same values it shows today.
   That is what makes "no user-visible change" true. Do not let a WP creep into converting
   a read site; that is Phase 2.

6. **`autoAckParity.test.ts` is a tripwire, not an obstacle.** If WP1 reports it failing,
   the implementer took the shortcut §2.2 warns against. Treat a "fixed" `autoAckParity`
   test in the diff as a review blocker.

### 8.7 Adjacent defects found during analysis — deliberately NOT fixed in Phase 1

Recorded so they are not re-discovered, and so no implementer "helpfully" fixes them
inside a phase that promises no user-visible change. Each needs its own issue.

| Finding | Evidence | Disposition |
|---|---|---|
| `neighborInfoRoutes.ts:15` reads the key `'maxNodeAge'`, which exists nowhere — always `null`, so the route is permanently pinned to its hardcoded 24 h and ignores the user's setting. | `neighborInfoRoutes.ts:15-16` | **Already scoped to Phase 2** (epic "Known bugs", item 1). Leave it. |
| ~~`settingsRoutes.ts:776` omits `sourceId`~~ — re-analysed. The real defect is that the **per-source branch has no `localStatsIntervalMinutes` handler at all**; `:776` is in the global branch where `sourceId` is always null. | `settingsRoutes.ts:650-705` (verified: no handler) | **MOVED INTO WP2** — see §3.5b. No longer deferred. |
| `externalUrl` is in `PER_SOURCE_SETTINGS_KEYS`, is **read** by `securityDigestService.ts:332`, and has **no writer anywhere in the repo**. Either the setting is dead or its write path was never built. | repo-wide grep hits only `settings.ts`, `securityDigestService.ts`, and that service's test | **Out of scope.** Listed in `PER_SOURCE_KEYS_NOT_POSTABLE` with a comment. File an issue; do not "fix" it by adding it to `VALID_SETTINGS_KEYS` — that would create a new writable setting, which is a feature. |
| Traceroute filter allowlist is asymmetric: 12 of the 17 keys written by `setTracerouteFilterSettingsAsync` are absent from `VALID_SETTINGS_KEYS`, but 5 (`tracerouteFilterLastHeard{Enabled,Hours}`, `tracerouteFilterHops{Enabled,Min,Max}`) are present — so those 5 can be written through `POST /api/settings`, bypassing the dedicated route's validation at `settingsRoutes.ts:1284-1318`. | §3.1(c) list vs. `PER_SOURCE_SETTINGS_KEYS:497-516` | **Out of scope**, but note the direction of the fix is to *remove* the 5 from `VALID_SETTINGS_KEYS`, not to add the 12. File an issue. |
| Two parallel loaders hydrate the same four numeric keys — `SettingsContext.tsx:1353-1384` and legacy `App.tsx:972-1000` — both writing localStorage. | both files | **Phase 3 blocker.** Flagging now so Phase 3 budgets for it: converting only one of the two leaves a stale mirror. |
| `SettingsContext.tsx:526`'s comment claims the dimming trio is "localStorage only", but all three are POSTed to and read back from the server (`SettingsTab.tsx:531-532,908-909`; `SettingsContext.tsx:1679-1693`). | as cited | Stale comment. Phase 3 corrects it while restructuring those bindings. |
