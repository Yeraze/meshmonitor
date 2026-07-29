# Phase 2 Spec — Backend reads go per-source (epic #4412)

**Epic:** `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md`
**Phase 1:** merged (PR #4417) — keys allowlisted, POST scoped/audited/validated,
migration 131 seeded, `deleteSourceSettings` wired.
**Branch:** `feature/per-source-node-display-reads` (worktree
`/home/yeraze/Development/meshmonitor-per-source-reads`), based on `origin/main @ 5cb8fef9`.

**Scope:** convert every backend read of the 10 Node Display keys from global to
per-source; fix the `neighborInfoRoutes` dead key; restructure
`inactiveNodeNotificationService` to one timer + per-source config; wire the
per-source save side-effect. **No frontend changes** (Phase 3). **No MeshCore
filtering** (Phase 4).

---

## 0. Reuse inventory — use these, do not reinvent

Verified against the worktree. Implementers MUST use or extend the following.

### Settings access (existing — extend, never duplicate)

| Symbol | Location | Use for |
|---|---|---|
| `SettingsRepository.getSettingForSource(sourceId, key)` | `src/db/repositories/settings.ts:201` | **The** per-source read. `sourceId` null/undefined → un-namespaced global key. **No global fallback** (deliberate, #2839/#2840). |
| `SettingsRepository.getSetting(key)` | `src/db/repositories/settings.ts` (see `getAllSettings` at `:35`) | Single indexed PK lookup. Cheap. Keep for genuinely global keys. |
| `SettingsRepository.getSourceSettings(sourceId)` | `src/db/repositories/settings.ts:178` | **Do NOT use for single-key reads.** It calls `getAllSettings()` — a full-table scan (#4419). |
| `SettingsRepository.setSourceSettings` / `deleteSourceSettings` | `:216` / `:253` | Write path (Phase 1). Untouched here. |
| `DatabaseService.getSettingForSourceSync` | `src/services/database.ts:3154` | Sync per-source read for singletons that cannot await. **Not needed in Phase 2** — all three `database.ts` sites are inside `async` methods. |
| `databaseService.settings` | getter on the singleton | The reader object every converted call site passes. |
| `PER_SOURCE_SETTINGS_KEYS` / `GLOBAL_ONLY_SETTINGS_KEYS` / `VALID_SETTINGS_KEYS` | `src/server/constants/settings.ts:340` / `:565` / `:9` | Already contain all 10 keys (Phase 1). **Do not edit.** |
| `NODE_DISPLAY_SEED` | `src/server/migrations/131_seed_per_source_node_display.ts:65` | The frozen default table. **Do not import it into runtime code** and **do not make 131 import the new constants module** — 131 deliberately freezes its own list (see its file-level comment and the Phase 1 deviations log). Instead, a test asserts the two agree. |

### Structural-subset interface pattern (existing precedent — copy it)

`ManagerSettingsDb` (`src/server/applyManagerSettings.ts:24-29`) is the repo's
established way to depend on a slice of `DatabaseService` without importing the
singleton. The new `NodeDisplaySettingsReader` (§1.2) is the same shape and for
the same reason (cycle avoidance with `src/services/database.ts`).

### Existing per-source side-effect wiring (extend, do not invent a new mechanism)

| Symbol | Location | Note |
|---|---|---|
| `SettingsCallbacks` | `src/server/routes/settingsRoutes.ts:118-156` | Injected by `server.ts:859`. Add/replace entries here. |
| Per-source side-effect block | `src/server/routes/settingsRoutes.ts:735-795` | `restartAnnounceScheduler(sourceId)`, `restartTimerScheduler(sourceId)`, `setLocalStatsInterval(interval, sourceId)`, `restartAutoDeleteByDistanceService(sourceId)`. The inactive-node reschedule goes **here**, in the same style. |
| Phase 1 TODO comment | `src/server/routes/settingsRoutes.ts:353-361` | Describes exactly what §4 must add. Update/remove it as part of the change. |
| `applyManagerSettings()` | `src/server/applyManagerSettings.ts:31` | Already reads `localStatsIntervalMinutes` per-source (`:42`). It is a **boot-time push**, not a read-at-call-time accessor — it is NOT the home for the defaults helper, but it IS a consumer of it. |

### Existing helpers reused unchanged

| Symbol | Location |
|---|---|
| `sourceManagerRegistry.getAllManagers()` / `.getManager(id)` | `src/server/sourceManagerRegistry.ts` |
| `isMeshtasticManager` / `isMeshCoreManager` | `src/server/sourceManagerTypes.ts` |
| `HourlyLogLimiter` | `src/server/utils/hourlyLogLimiter.ts` |
| `parseMonitoredUnion`, `countMonitoredNodes`, `formatSourceIdForLog`, `logZeroEligiblePrefRows` | `src/server/utils/notificationCheckHelpers.ts` |
| `ok()` / `fail()` envelope | `src/server/utils/apiResponse.ts` |
| `createRouteTestApp()` / `RouteTestHarness` | `src/server/test-helpers/routeTestApp.ts` (`sourceA`, `sourceB`, `admin`, `limited`, `grant()`, `cleanup()`) |

### Existing test files to extend (do not create parallel suites)

`src/server/routes/neighborInfoRoutes.test.ts`, `tracerouteRoutes.test.ts`,
`pollRoutes.test.ts`, `settingsRoutes.test.ts`, `settingsRoutes.perSource.test.ts`,
`src/server/services/inactiveNodeNotificationService.test.ts`,
`src/server/applyManagerSettings.test.ts`,
`src/server/virtualNodeServer.zombieFix.test.ts`,
`src/db/repositories/settings.test.ts`,
`src/server/constants/settings.allowlist.test.ts`.

Canonical per-source test templates:
`src/server/services/securityDigestService.perSource.test.ts` (service),
`src/server/routes/settingsRoutes.perSource.test.ts` (route + harness).

### Justification for the two new modules

| New module | Closest existing thing | Why not that |
|---|---|---|
| `src/constants/nodeDisplayDefaults.ts` | `src/server/constants/settings.ts` | That file is **server-only** and holds *key allowlists*, not values. Phase 3 needs these defaults in client code, and today the frontend imports **only `type`** from `src/server/**` (verified: 8 import sites, all `import type`). `src/constants/` already exists as the isomorphic constants home (`src/constants/index.ts`, imported by `src/components/**` and `src/utils/**`), and `src/utils/hopEmoji.ts:4-8` documents this exact "shared rather than server-only" rule. Pure `const` file, zero imports. |
| `src/server/services/nodeDisplaySettings.ts` | `src/server/applyManagerSettings.ts` | `applyManagerSettings` is a one-shot boot-time *push* into a manager instance. Phase 2 needs *pull* accessors called on every request/tick, from `routes/`, `services/`, `meshtasticManager`, `virtualNodeServer` **and `src/services/database.ts`**. Adding them to `applyManagerSettings` would force `database.ts` to import a manager-mutating module. Adding them to `sourceDashboardData.ts` (where `getMaxNodeAgeHours` lives today) is worse: that module imports `sourceManagerRegistry`, `nodeEnhancer`, auth middleware and `databaseService` — importing it from `database.ts` is a hard cycle. |

---

## 1. New modules

### 1.1 `src/constants/nodeDisplayDefaults.ts` (new, isomorphic, zero imports)

Single source of truth for the 10 keys' defaults and validation ranges. Client-
importable — Phase 3 consumes it directly with no changes.

```ts
export const NODE_DISPLAY_SETTING_KEYS = [
  'maxNodeAgeHours',
  'inactiveNodeThresholdHours',
  'inactiveNodeCheckIntervalMinutes',
  'inactiveNodeCooldownHours',
  'localStatsIntervalMinutes',
  'nodeHopsCalculation',
  'hideIncompleteNodes',
  'nodeDimmingEnabled',
  'nodeDimmingStartHours',
  'nodeDimmingMinOpacity',
] as const;
export type NodeDisplaySettingKey = typeof NODE_DISPLAY_SETTING_KEYS[number];

/**
 * Canonical STORED string form of each default. MUST stay byte-identical to
 * `NODE_DISPLAY_SEED` in migration 131 (booleans are '0'/'1', never
 * 'false'/'true' — see the Phase 1 deviations log). Enforced by
 * nodeDisplayDefaults.test.ts; migration 131 must NOT import this.
 */
export const NODE_DISPLAY_DEFAULT_STRINGS: Readonly<Record<NodeDisplaySettingKey, string>> = {
  maxNodeAgeHours: '24',
  inactiveNodeThresholdHours: '24',
  inactiveNodeCheckIntervalMinutes: '60',
  inactiveNodeCooldownHours: '24',
  localStatsIntervalMinutes: '15',
  nodeHopsCalculation: 'nodeinfo',
  hideIncompleteNodes: '0',
  nodeDimmingEnabled: '0',
  nodeDimmingStartHours: '1',
  nodeDimmingMinOpacity: '0.3',
};

export const NODE_DISPLAY_NUMERIC_DEFAULTS = {
  maxNodeAgeHours: 24,
  inactiveNodeThresholdHours: 24,
  inactiveNodeCheckIntervalMinutes: 60,
  inactiveNodeCooldownHours: 24,
  localStatsIntervalMinutes: 15,
  nodeDimmingStartHours: 1,
  nodeDimmingMinOpacity: 0.3,
} as const;
export type NodeDisplayNumericKey = keyof typeof NODE_DISPLAY_NUMERIC_DEFAULTS;

export const NODE_DISPLAY_BOOLEAN_DEFAULTS = {
  hideIncompleteNodes: false,
  nodeDimmingEnabled: false,
} as const;
export type NodeDisplayBooleanKey = keyof typeof NODE_DISPLAY_BOOLEAN_DEFAULTS;

export const NODE_DISPLAY_STRING_DEFAULTS = { nodeHopsCalculation: 'nodeinfo' } as const;

/**
 * Accepted ranges. Lifted verbatim from the existing server-side write
 * validation so the read-side clamp and the write-side 400 can never disagree:
 *   maxNodeAgeHours                   settingsRoutes.ts:345-351   1..168
 *   inactiveNodeThresholdHours        settingsRoutes.ts:363-368   1..720
 *   inactiveNodeCheckIntervalMinutes  settingsRoutes.ts:370-377   1..1440
 *   inactiveNodeCooldownHours         settingsRoutes.ts:379-384   1..720
 *   localStatsIntervalMinutes         meshtasticManager.setLocalStatsInterval  0..60 (0 = disabled)
 *
 * `nodeDimmingStartHours` and `nodeDimmingMinOpacity` deliberately have NO
 * entry: no backend reads them and no authoritative server-side range exists
 * today. Phase 3 adds theirs from the SettingsTab inputs.
 */
export const NODE_DISPLAY_RANGES: Readonly<Partial<Record<
  NodeDisplayNumericKey, { min: number; max: number; integer: boolean }
>>> = {
  maxNodeAgeHours:                  { min: 1, max: 168,  integer: true },
  inactiveNodeThresholdHours:       { min: 1, max: 720,  integer: true },
  inactiveNodeCheckIntervalMinutes: { min: 1, max: 1440, integer: true },
  inactiveNodeCooldownHours:        { min: 1, max: 720,  integer: true },
  localStatsIntervalMinutes:        { min: 0, max: 60,   integer: true },
};

/**
 * Parse a stored value into a usable number. null/empty/NaN/out-of-range all
 * resolve to the hardcoded default — never to a neighbouring source's value and
 * never to the legacy global row (the interview's "no runtime global fallback"
 * decision). Keys with no range entry are parsed but not bounds-checked.
 */
export function parseNodeDisplayNumber(
  key: NodeDisplayNumericKey,
  raw: string | null | undefined,
): number;

/** '1' | 'true' → true; '0' | 'false' → false; anything else → the default. */
export function parseNodeDisplayBoolean(
  key: NodeDisplayBooleanKey,
  raw: string | null | undefined,
): boolean;
```

**Intentional behaviour change:** today every site does
`parseInt(raw) || 24`, so a stored `'0'` becomes 24 but a stored `'-5'` stays
`-5` and inverts every `Date.now() - h*3600e3` window. `parseNodeDisplayNumber`
clamps out-of-range to the default. This matches Phase 1's write validation and
`server.ts:396-407`'s existing "invalid → default" policy. Call it out in the PR
body.

### 1.2 `src/server/services/nodeDisplaySettings.ts` (new)

The typed server accessor. **Must not import `src/services/database.ts`** —
`database.ts` imports *this* module, so the dependency has to point one way.
Uses the `ManagerSettingsDb` structural-subset pattern.

```ts
import {
  NODE_DISPLAY_NUMERIC_DEFAULTS, NODE_DISPLAY_RANGES,
  parseNodeDisplayNumber, parseNodeDisplayBoolean,
  type NodeDisplayNumericKey, type NodeDisplayBooleanKey,
} from '../../constants/nodeDisplayDefaults.js';

/**
 * Structural subset of the settings repository. Mirrors ManagerSettingsDb
 * (applyManagerSettings.ts:24) — deliberately does NOT import databaseService,
 * so src/services/database.ts can import this module without a cycle.
 * Satisfied by `databaseService.settings` and by `this.settings` inside
 * DatabaseService.
 */
export interface NodeDisplaySettingsReader {
  getSettingForSource(sourceId: string | null | undefined, key: string): Promise<string | null>;
}

/** Adds the batched read used by the unified-dashboard fan-out only. */
export interface NodeDisplayBatchReader extends NodeDisplaySettingsReader {
  getSettingForSources(sourceIds: string[], key: string): Promise<Map<string, string>>;
}

export function getNodeDisplayNumber(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
  key: NodeDisplayNumericKey,
): Promise<number>;

export function getNodeDisplayBoolean(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
  key: NodeDisplayBooleanKey,
): Promise<boolean>;

/** Convenience: getNodeDisplayNumber(reader, sourceId, 'maxNodeAgeHours'). */
export function getMaxNodeAgeHours(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
): Promise<number>;

/**
 * Batched: ONE query for many sources. Every requested id is present in the
 * returned Map (missing rows are filled with the hardcoded default), so callers
 * never need a per-source follow-up read. Empty input → empty Map, no query.
 */
export function getMaxNodeAgeHoursForSources(
  reader: NodeDisplayBatchReader,
  sourceIds: string[],
): Promise<Map<string, number>>;

export interface InactiveNodeConfig {
  thresholdHours: number;
  checkIntervalMinutes: number;
  cooldownHours: number;
}

/** All three inactive-node keys for one source, in one Promise.all. */
export function getInactiveNodeConfig(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
): Promise<InactiveNodeConfig>;

export function getLocalStatsIntervalMinutes(
  reader: NodeDisplaySettingsReader,
  sourceId: string | null | undefined,
): Promise<number>;
```

Passing `sourceId = null/undefined` reads the un-namespaced global key —
`getSettingForSource`'s existing semantics, and the only sane behaviour for a
genuinely unscoped caller (`GET /api/traceroutes/recent` with no `?sourceId`).
That is **not** a fallback: a call that *does* pass a sourceId never sees the
global row.

### 1.3 `src/db/repositories/settings.ts` — add one method

```ts
/**
 * Batched per-source read of ONE key across MANY sources: a single indexed
 * `key IN (...)` lookup. Deliberately NOT getSourceSettings(), which calls
 * getAllSettings() — a full-table scan (#4419) — once per source.
 *
 * Returns a Map keyed by sourceId. Ids with no stored row are simply absent;
 * there is no fallback to the global row (#2839/#2840).
 */
async getSettingForSources(sourceIds: string[], key: string): Promise<Map<string, string>>
```

Implementation notes:
- `if (sourceIds.length === 0) return new Map();` — no query.
- Build `prefixedToSourceId: Map<string, string>` from
  `` `${this.sourcePrefix(id)}${key}` `` → `id`. Resolve results by **reverse
  lookup against that map**, never by string-splitting the returned key (source
  ids are UUIDs today but a `:` in an id would corrupt a split).
- `inArray(settings.key, [...prefixedToSourceId.keys()])`, selecting
  `{ key, value }` only. Drizzle, no raw SQL.
- Dedupe `sourceIds` before building the key list.

---

## 2. Read-site conversion — file by file

The epic's survey list is **stale in line numbers and incomplete**. Verified
inventory (`grep` over `src/`, non-test, non-migration): **15 read sites in 10
files**, plus 4 duplicated-range/validation sites. Full table:

| # | Site (verified) | sourceId source | Owner WP |
|---|---|---|---|
| 1 | `sourceDashboardData.ts:43` (inside `getMaxNodeAgeHours()`) | `source.id` | WP2 |
| 2 | `unifiedRoutes.ts:1298` (fan-out — hard-codes globality) | `selected[].id` | WP2 |
| 3 | `neighborInfoRoutes.ts:15` — **dead key `'maxNodeAge'`** | `req.query.sourceId` (`:12`) | WP2 |
| 4 | `tracerouteRoutes.ts:19` | `req.query.sourceId` (`:25`, hoist) | WP3 |
| 5 | `pollRoutes.ts:438` | `pollSourceId` (`:54`) | WP3 |
| 6 | `meshtasticManager.ts:3226` | `this.sourceId` | WP3 |
| 7 | `virtualNodeServer.ts:824` | `sourceId` (`:823`) | WP3 |
| 8 | `database.ts:2031` (`getNodeNeedingTracerouteAsync`) | method param | WP3 |
| 9 | `database.ts:2149` (`getNodesNeedingRemoteLocalStatsAsync`) | method param | WP3 |
| 10 | `database.ts:2211` (`getNodeNeedingRemoteAdminCheckAsync`) | method param | WP3 |
| 11 | `server.ts:388` `inactiveNodeThresholdHours` | **deleted** (§3) | WP4 |
| 12 | `server.ts:390` `inactiveNodeCheckIntervalMinutes` | **deleted** (§3) | WP4 |
| 13 | `server.ts:393` `inactiveNodeCooldownHours` | **deleted** (§3) | WP4 |
| 14–16 | `settingsRoutes.ts:933/934/935` (the three global re-reads) | **deleted** (§4) | WP4 |
| — | `applyManagerSettings.ts:42` | already per-source; **reuse target** | WP3 |
| — | `settingsRoutes.ts:345-351`, `:363-384` duplicated ranges | → `NODE_DISPLAY_RANGES` | WP4 |
| — | `server.ts:396-407` duplicated clamping | **deleted** (moves into `getInactiveNodeConfig`) | WP4 |

**Sites the epic's list missed:** `server.ts:388/390/393` and
`settingsRoutes.ts:933/934/935` (named only obliquely as "restructure the
service"; they are literal global `getSetting` reads that must be deleted);
`applyManagerSettings.ts:42` (correct already, but the duplicated `0..60`
literal and null-skip behaviour should fold into the shared helper); the three
duplicated range-literal blocks. The epic's `settingsRoutes.ts:832-868` is off
by ~+94 lines (actual: `:926-962`); `sourceDashboardData.ts:41-45` is `:41-45`
(correct), `:233-238`→`:230-237`, `:357`→`:354-366`; `virtualNodeServer.ts:806-808`
is actually `:822-826`; `database.ts:2030/2147/2209` are `:2031/2149/2211`.

**Frontend sites are explicitly out of Phase 2** (`useProcessedNodes.ts`,
`useSourceView.ts`, `utils/mapAge.ts`, `utils/activeWindowConfig.ts`,
`utils/nodeTransport.ts`, `NodesTab.tsx`, `DashboardPage.tsx`,
`GlobalSettingsPage.tsx`, `useTraceroutePaths.tsx`) — Phase 3.

### 2.1 `src/server/services/sourceDashboardData.ts` (WP2)

Delete the local `getMaxNodeAgeHours()` (`:41-45`). Import the shared one.

```ts
import { getMaxNodeAgeHours } from './nodeDisplaySettings.js';
```

`buildSourceNeighborInfo` — signature unchanged, semantics changed:

```ts
/**
 * `maxNodeAgeHours` is PER-SOURCE as of #4412 Phase 2. The parameter exists
 * only so the unified fan-out can batch the lookup (one query for all sources)
 * instead of one per source; when omitted it is resolved for THIS source.
 */
export async function buildSourceNeighborInfo(
  source: SourceRow,
  user: ReqUser,
  maxNodeAgeHours?: number,
): Promise<unknown[]> {
  const resolvedMaxAge = maxNodeAgeHours ?? await getMaxNodeAgeHours(databaseService.settings, source.id);
  ...
```

`buildSourceDashboard` — unchanged. `sourceRoutes.ts:1179` and `:1202` call
these with no opts and are **not edited**; they now transparently resolve
per-source.

### 2.2 `src/server/routes/unifiedRoutes.ts` (WP2)

`:21` — change the import:
```ts
import { buildSourceDashboard } from '../services/sourceDashboardData.js';
import { getMaxNodeAgeHoursForSources } from '../services/nodeDisplaySettings.js';
```

`:1296-1299` — replace:
```ts
    // maxNodeAgeHours is per-source (#4412 Phase 2). ONE batched `key IN (...)`
    // read for the whole selection, not one query per source and NOT
    // getSourceSettings() (full-table scan per source, #4419).
    const ageBySource = await getMaxNodeAgeHoursForSources(
      databaseService.settings,
      selected.map((s) => s.id),
    );
    const bundles = await Promise.all(
      selected.map((s) => buildSourceDashboard(s, user, { maxNodeAgeHours: ageBySource.get(s.id) })),
    );
```
`getMaxNodeAgeHoursForSources` fills a default for every requested id, so
`.get(s.id)` is always defined and `buildSourceNeighborInfo` never issues a
follow-up read. **Net query delta on the 15s dashboard poll: +0** (one global
`getSetting` becomes one batched `IN` query).

### 2.3 `src/server/routes/neighborInfoRoutes.ts` (WP2) — bug #1

```ts
-    const maxNodeAgeStr = await databaseService.settings.getSetting('maxNodeAge');
-    const maxNodeAgeHours = maxNodeAgeStr ? parseInt(maxNodeAgeStr, 10) : 24;
+    // `'maxNodeAge'` is not in VALID_SETTINGS_KEYS, so this always read null and
+    // always fell back to 24 regardless of the configured window (#4412 bug 1).
+    const maxNodeAgeHours = await getMaxNodeAgeHours(
+      databaseService.settings,
+      neighborInfoSourceId ?? null,
+    );
```
**User-visible change:** this endpoint starts honouring the setting. State it in
the PR body.

### 2.4 `src/server/routes/tracerouteRoutes.ts` (WP3)

Hoist `const recentSourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;`
from `:25` to above the `else` branch, then:
```ts
      const maxNodeAgeHours = await getMaxNodeAgeHours(databaseService.settings, recentSourceId ?? null);
```
`tracerouteIntervalMinutes` on `:18` is a separate, already-per-source-listed key
**outside this epic's 10** — leave it exactly as-is.

### 2.5 `src/server/routes/pollRoutes.ts` (WP3)

```ts
      const maxNodeAgeHours = await getMaxNodeAgeHours(databaseService.settings, pollSourceId ?? null);
```
Leave `tracerouteIntervalMinutes` on `:437` untouched.

### 2.6 `src/server/meshtasticManager.ts` (WP3)

`:3226`:
```ts
      const maxNodeAgeHours = await getMaxNodeAgeHours(databaseService.settings, this.sourceId);
```

### 2.7 `src/server/virtualNodeServer.ts` (WP3)

`:824` — also drops the last `databaseService.getSettingAsync` use in this file:
```ts
    const maxNodeAgeHours = await getMaxNodeAgeHours(databaseService.settings, sourceId);
```

### 2.8 `src/services/database.ts` (WP3)

Three sync `this.getSetting(...)` calls, all inside `async` methods, all with a
`sourceId?: string` parameter already threaded from `meshtasticManager`
(`:2298`, `:2462`, `:2852` all pass `this.sourceId`). **No site stays global.**

```ts
import { getMaxNodeAgeHours } from '../server/services/nodeDisplaySettings.js';
```
(safe: `nodeDisplaySettings` imports only the pure constants module.)

- `:2031` → `const maxNodeAgeHours = await getMaxNodeAgeHours(this.settings, sourceId ?? null);`
- `:2149` → same
- `:2211` → same

`remoteAdminScannerExpirationHours` on `:2216` is **not** one of the 10 keys —
leave it.

### 2.9 `src/server/applyManagerSettings.ts` (WP3)

Replace `:42-46`:
```ts
-  const lsInterval = await db.settings.getSettingForSource(sourceId, 'localStatsIntervalMinutes');
-  if (lsInterval !== null) {
-    const n = parseInt(lsInterval, 10);
-    if (!isNaN(n) && n >= 0 && n <= 60) manager.setLocalStatsInterval(n);
-  }
+  manager.setLocalStatsInterval(await getLocalStatsIntervalMinutes(db.settings, sourceId));
```
`ManagerSettingsDb` already structurally satisfies `NodeDisplaySettingsReader` —
**no interface change**.

*Equivalence proof for the always-call change:* the old code skipped the call
when the value was null, leaving `MeshtasticManager.localStatsIntervalMinutes`
at its class-field default of `15` (`meshtasticManager.ts:734` — its trailing
`// Default 5 minutes` comment is stale; fix it while you are there).
`NODE_DISPLAY_NUMERIC_DEFAULTS.localStatsIntervalMinutes` is also `15`, so the
resulting interval is identical. The helper clamps to `[0, 60]`, so
`setLocalStatsInterval`'s `throw` on out-of-range is unreachable. At bootstrap
`isConnected` is false, so the `startLocalStatsScheduler()` restart branch does
not fire.

---

## 3. `inactiveNodeNotificationService` — one timer, per-source config (WP4)

File: `src/server/services/inactiveNodeNotificationService.ts`.

### 3.1 Public API

```ts
/** Start the single scheduler tick. Config is resolved per source, per pass. */
public start(): void;                                  // was start(threshold, check, cooldown)
public stop(): void;                                   // unchanged
/** Force a source (or all sources, when null/omitted) to re-read config and run on the next tick. */
public reschedule(sourceId?: string | null): void;     // NEW
public getStatus(): { running: boolean };              // unchanged shape
```

### 3.2 State

```ts
private tickTimer: NodeJS.Timeout | null = null;
private initialTimeout: NodeJS.Timeout | null = null;
private running = false;                       // NEW — see note below
private nextRunAt = new Map<string, number>(); // sourceId -> epoch ms of next eligible run
private lastNotifiedNodes = new Map<string, number>(); // unchanged: "userId:sourceId:nodeId" -> ts
private readonly hourlyLog = new HourlyLogLimiter();   // unchanged

private static readonly TICK_INTERVAL_MS = 60_000;   // 1 min == the minimum legal check interval
private static readonly INITIAL_DELAY_MS = 60_000;   // preserves today's 1-min warm-up
```

Delete `currentThresholdHours`, `currentCooldownHours`,
`DEFAULT_CHECK_INTERVAL_MINUTES`, `DEFAULT_INACTIVE_THRESHOLD_HOURS`,
`DEFAULT_NOTIFICATION_COOLDOWN_HOURS` — the constants module owns those now.

**`running` flag is load-bearing:** `getStatus().running` currently derives from
`this.checkInterval !== null`. With the warm-up delay the interval is not created
until t+60s, so deriving it would report `running: false` for the first minute —
a regression. Set `running = true` in `start()` and `false` in `stop()`.

### 3.3 Tick algorithm

`start()` sets `running = true`, schedules `initialTimeout` at
`INITIAL_DELAY_MS`; that callback clears `initialTimeout`, runs one `tick()`,
and installs `tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)`.
Guard re-entry: if `running` is already true, log the existing
`⚠️ already running` warn and return. `stop()` clears both timers, sets
`running = false`, and **clears `nextRunAt`** so a restart is a clean slate.

`private async tick(): Promise<void>` — ordering matters:

1. `const managers = sourceManagerRegistry.getAllManagers();` if empty → prune
   `nextRunAt` and return (existing debug log).
2. `const now = Date.now();`
3. **Prune** `nextRunAt` of any id not in `managers` — bounded growth, same
   discipline as PR #4413's `geofenceState`/`autoAckCooldowns` bound.
4. `const due = managers.filter(m => (this.nextRunAt.get(m.sourceId) ?? 0) <= now);`
   **If `due.length === 0`, return here — before any DB query.** This is why the
   60s tick does not turn the hourly `getUsersWithInactiveNodeNotifications()`
   query into a per-minute query.
5. `const rows = await databaseService.notifications.getUsersWithInactiveNodeNotifications();`
   If empty → existing `hourlyLog` + `logZeroEligibleDiagnostic()` and return
   **without** advancing `nextRunAt` (nothing was checked).
6. Build `rowsByUser` and each user's `monitoredUnion` via `parseMonitoredUnion`
   **once per tick**, hoisted out of the source loop (today it is recomputed
   inside the user loop, which is fine; it must not move *into* the source loop).
7. For each `source of due`, inside its own `try/catch` so one bad source cannot
   abort the tick:
   - `const cfg = await getInactiveNodeConfig(databaseService.settings, sourceId);`
   - **`this.nextRunAt.set(sourceId, now + cfg.checkIntervalMinutes * 60_000);`
     BEFORE doing the work** — a throw mid-source must not hot-loop that source
     every 60 s.
   - Resolve `sourceName` (existing `databaseService.sources.getSource` +
     try/catch), only for due sources.
   - `const cutoffSeconds = Math.floor(now / 1000) - cfg.thresholdHours * 60 * 60;`
   - For each `[userId, monitoredUnion]`: existing empty-union `hourlyLog`
     skip, existing `checkPermissionAsync(userId, 'nodes', 'read', sourceId)`
     gate, then the **unchanged** collectors:
     ```ts
     const alerts = manager.sourceType === 'meshcore'
       ? await this.collectMeshCoreInactiveAlerts(monitoredUnion, sourceId, cfg.thresholdHours, now)
       : await this.collectMeshtasticInactiveAlerts(monitoredUnion, sourceId, cutoffSeconds, now);
     ```
   - Cooldown: `const cooldownMs = cfg.cooldownHours * 60 * 60 * 1000;` — key
     stays `` `${userId}:${sourceId}:${alert.nodeId}` ``.
8. Cleanup `lastNotifiedNodes` older than 7 days + `this.hourlyLog.prune()` —
   unchanged.

**Loop inversion:** today the outer loop is users and the inner is sources.
Per-source due-ness forces **source-outer / user-inner**. Everything inside is a
straight move; the two collectors, `sendInactiveNodeNotification`,
`formatRowsSummary` and `logZeroEligibleDiagnostic` are **unchanged**.

**Unit hazard — preserve exactly.** `collectMeshtasticInactiveAlerts` takes a
**unix-seconds** cutoff and multiplies `node.lastHeard * 1000` (`:290`);
`collectMeshCoreInactiveAlerts` takes **threshold hours** and computes a
**millisecond** cutoff, using `node.lastHeard` directly (`:318`, `:334-335`).
Both signatures stay as they are — pass `cfg.thresholdHours` to the MeshCore
collector and `cutoffSeconds` to the Meshtastic one. Do not "unify" them.

### 3.4 `reschedule`

```ts
public reschedule(sourceId?: string | null): void {
  if (sourceId) {
    this.nextRunAt.delete(sourceId);
    logger.debug(`🔔 Inactive-node check rescheduled for source ${sourceId}`);
  } else {
    this.nextRunAt.clear();
    logger.debug('🔔 Inactive-node check rescheduled for all sources');
  }
}
```
Effect: that source becomes due on the next tick (≤60 s), re-reading its config.
No timer is torn down, so a reschedule cannot leak or double-schedule a timer —
the failure mode the old `stop()` + `start()` pair had.

### 3.5 `src/server/server.ts` (WP4)

Delete `:388-421` (the three global reads, the three clamp expressions, and the
"invalid values" warn — the clamp now lives in `getInactiveNodeConfig`). Replace
`:423-424` with:
```ts
    inactiveNodeNotificationService.start();
    logger.info('✅ Inactive node notification service started (per-source config, resolved per tick)');
```

Callbacks block (`:875-877`):
```ts
-  restartInactiveNodeService: (threshold, check, cooldown) =>
-    inactiveNodeNotificationService.start(threshold, check, cooldown),
+  rescheduleInactiveNodeService: (sourceId) =>
+    inactiveNodeNotificationService.reschedule(sourceId),
   stopInactiveNodeService: () => inactiveNodeNotificationService.stop(),
```

---

## 4. `src/server/routes/settingsRoutes.ts` (WP4)

### 4.1 Callback contract

```ts
-  restartInactiveNodeService?: (threshold: number, check: number, cooldown: number) => void;
+  // Per-source (#4412 Phase 2): the service resolves threshold/interval/cooldown
+  // per source on each tick, so a save only needs to invalidate that source's
+  // next-run timestamp. A null/omitted sourceId invalidates every source.
+  rescheduleInactiveNodeService?: (sourceId?: string | null) => void;
   stopInactiveNodeService?: () => void;
```
`stopInactiveNodeService` stays (lifecycle), but settingsRoutes no longer calls it.

### 4.2 Per-source branch — the side-effect Phase 1 left a TODO for

Add inside the `if (sourceId) { ... }` block (`:735-795`), next to the other
per-source side-effects, **before** `auditSettingsWrite`:

```ts
    // #4412 Phase 2: the inactive-node service reads threshold/interval/cooldown
    // per source on each tick, so a scoped save only needs to invalidate THIS
    // source's next-run timestamp. No global restart, no other source affected.
    const inactiveNodeKeys = [
      'inactiveNodeThresholdHours',
      'inactiveNodeCheckIntervalMinutes',
      'inactiveNodeCooldownHours',
    ];
    if (inactiveNodeKeys.some((key) => key in filteredSettings)) {
      callbacks.rescheduleInactiveNodeService?.(sourceId);
      logger.debug(`✅ Inactive node check rescheduled (source: ${sourceId})`);
    }
```
Hoist `inactiveNodeKeys` to module scope so the global branch reuses the same
array (it currently declares its own copy at `:926`).

### 4.3 Global branch — replace `:926-962` wholesale

```ts
    if (INACTIVE_NODE_KEYS.some((key) => key in filteredSettings)) {
      // These keys are per-source now; a global write still has to invalidate
      // every source's cached next-run so the change is picked up.
      callbacks.rescheduleInactiveNodeService?.(null);
      logger.debug('✅ Inactive node check rescheduled for all sources');
    }
```
This deletes the three global re-reads (`:933-935`) and the duplicated clamping.

### 4.4 Range validation reuses the constants

`:345-351` and `:363-384`: keep the exact HTTP status codes and error message
strings (tests pin them), but source the bounds from `NODE_DISPLAY_RANGES`:
```ts
const R = NODE_DISPLAY_RANGES.maxNodeAgeHours!;
if (isNaN(hours) || hours < R.min || hours > R.max) {
  return fail(res, 400, 'INVALID_MAX_NODE_AGE_HOURS',
    `maxNodeAgeHours must be between ${R.min} and ${R.max} hours`);
}
```
Keep the three inactive-node validators on their existing bare-`{error}` +
`res.status(400)` form — converting them to `fail()` is a separate opportunistic
change and would break their pinned tests.

### 4.5 Update the Phase 1 TODO comment

Rewrite `:353-361` to describe the delivered behaviour (per-source reschedule on
the scoped path, all-source reschedule on the global path). Do not leave a stale
"Phase 2 will…".

---

## 5. Decisions this spec makes

1. **Defaults live in `src/constants/nodeDisplayDefaults.ts`** (isomorphic, zero
   imports, client-importable). The *accessor* lives in
   `src/server/services/nodeDisplaySettings.ts` with reader injection, so
   `src/services/database.ts` can import it without a cycle. Justified against
   `applyManagerSettings.ts`, `sourceDashboardData.ts` and
   `src/server/constants/settings.ts` in §0.
2. **No read site stays global.** Every one of the 15 has a `sourceId` in scope
   (verified). Where a request legitimately has none (`/api/traceroutes/recent`
   without `?sourceId`, `/api/poll` without `?sourceId`), the helper is called
   with `null`, which reads the un-namespaced global key — the same value that
   endpoint reads today, and the only defined behaviour for a cross-source query.
   That is `getSettingForSource`'s documented semantics, not a reintroduced
   fallback.
3. **`unifiedRoutes` fan-out batches.** New
   `SettingsRepository.getSettingForSources(ids, key)` — one `key IN (...)`
   query for the whole selection. Not `getSourceSettings` (per-source full-table
   scan, #4419). Query delta on the dashboard hot path: **+0**.
4. **Out-of-range stored values now resolve to the default** rather than being
   used verbatim. Matches Phase 1 write validation and `server.ts`'s existing
   policy.
5. **Sources created after migration 131 get the hardcoded default** (epic's
   Option 1). See §9 — this needs the orchestrator's sign-off, but deferring
   Option 2 costs nothing: it is a purely additive seed in the `sourceRoutes`
   POST handler and touches no read path.

---

## 6. Test plan

All tests run in the standard Vitest suite. **No standalone scripts.** New or
changed route tests use `createRouteTestApp()`. PostgreSQL (`localhost:5433`) and
MySQL (`localhost:3307`) containers must be up — confirm coverage via
`numPendingTests` in the JSON reporter, not just `success`.

### New files

| File | WP | Asserts |
|---|---|---|
| `src/constants/nodeDisplayDefaults.test.ts` | WP1 | `NODE_DISPLAY_SETTING_KEYS` has exactly 10 entries and is a subset of `PER_SOURCE_SETTINGS_KEYS` and `VALID_SETTINGS_KEYS`; **`NODE_DISPLAY_DEFAULT_STRINGS` deep-equals migration 131's exported `NODE_DISPLAY_SEED`** (keeps the frozen migration table and the runtime defaults honest without coupling them); booleans stored as `'0'`/`'1'` not `'false'`/`'true'`; `parseNodeDisplayNumber` table-drives null/''/'abc'/'0'/'-5'/above-max → default, in-range → value, `localStatsIntervalMinutes: '0'` → `0` (not clamped up); keys with no range entry are not clamped. |
| `src/server/services/nodeDisplaySettings.test.ts` | WP1 | Accessors against a stub reader: per-source value wins; **missing per-source row returns the hardcoded default and never the global row**; `sourceId=null` reads the bare key; `getInactiveNodeConfig` issues exactly three reads and clamps each independently; `getMaxNodeAgeHoursForSources` returns an entry for every requested id, fills defaults, and calls `getSettingForSources` exactly **once**; empty input → empty Map, zero queries. |
| `src/server/services/sourceDashboardData.perSource.test.ts` | WP2 | **Headline per-source proof.** Harness: `sourceA` `maxNodeAgeHours='1'`, `sourceB` `'168'`; seed neighbor-info rows + nodes with a report timestamp ~24 h old on both; `buildSourceNeighborInfo(sourceA, admin)` returns `[]` while `buildSourceNeighborInfo(sourceB, admin)` returns the link. Also: an explicit `maxNodeAgeHours` argument overrides the per-source read. |
| `src/server/routes/unifiedRoutes.perSource.test.ts` | WP2 | Same two-source setup over `GET /api/unified/dashboard` through the harness: bundle A and bundle B have different `neighborInfo` lengths in one response. Plus a spy asserting `getSettingForSources` is called **once**, not once per source. |
| `src/services/database.maxNodeAge.perSource.test.ts` | WP3 | Two sources with different `maxNodeAgeHours`; `getNodeNeedingRemoteAdminCheckAsync` and `getNodesNeedingRemoteLocalStatsAsync` return different node sets for the same node fixtures. `sourceId` omitted → reads the global row (back-compat). |
| `src/server/services/inactiveNodeNotificationService.perSource.test.ts` | WP4 | Fake timers, two registered managers. A: threshold 1 h / interval 1 min; B: threshold 720 h / interval 60 min. Advance 60 s ⇒ A alerts, B does not. Advance a further 60 s ⇒ A runs again, B still has not (its `nextRunAt` has not elapsed). Advance 60 min ⇒ B runs. Per-source cooldown honoured independently. Deregistering a manager prunes its `nextRunAt` entry. |

### Extended files

| File | WP | Change |
|---|---|---|
| `src/db/repositories/settings.test.ts` | WP1 | `getSettingForSources`: multi-source hit/miss, empty input, dedupe, no cross-namespace bleed, ids containing `:` resolved by reverse map. Must run on all three backends (this suite already parameterises). |
| `src/server/constants/settings.allowlist.test.ts` | WP1 | Cross-check that the new key list agrees with `PER_SOURCE_SETTINGS_KEYS`. |
| `src/server/routes/neighborInfoRoutes.test.ts` | WP2 | Harness-based: the endpoint now honours `source:{id}:maxNodeAgeHours`; a link outside the window is filtered. Pins the dead-key fix. |
| `src/server/server.neighbor-info-position.test.ts` | WP2 | **`:124-126` re-implements the route body including the dead `'maxNodeAge'` key.** A fake that re-implements the logic under test cannot catch a regression in it. Convert this leg to `createRouteTestApp()` + the real router, or delete the re-implementation and keep only the position assertions. |
| `src/server/routes/tracerouteRoutes.test.ts` | WP3 | `?sourceId=` changes the derived `limit`; no `sourceId` keeps global behaviour. |
| `src/server/routes/pollRoutes.test.ts` | WP3 | Same for `/api/poll`. |
| `src/server/virtualNodeServer.zombieFix.test.ts` | WP3 | `:225` "falls back to default 24h" mocks `databaseService.getSettingAsync`, which this change stops using. Re-point at `databaseService.settings.getSettingForSource` and add a per-source case. |
| `src/server/applyManagerSettings.test.ts` | WP3 | `:66` and `:141` still pass; **add** a case proving a source with no stored `localStatsIntervalMinutes` now calls `setLocalStatsInterval(15)` (previously not called at all) and that an out-of-range stored value resolves to 15 instead of being skipped. |
| `src/server/services/inactiveNodeNotificationService.test.ts` | WP4 | Rewrite for `start()` with no args: warm-up delay, 60 s tick, `getStatus().running === true` immediately after `start()` (the regression the `running` flag prevents), `stop()` clears both timers and `nextRunAt`, `reschedule(id)` makes only that source due, `reschedule()` makes all due, no users → no `nextRunAt` advance, a throwing source does not abort the tick and does not hot-loop. |
| `src/server/routes/settingsRoutes.perSource.test.ts` | WP4 | Scoped POST of an inactive-node key fires `rescheduleInactiveNodeService(sourceA)` and **not** `(sourceB)` / `(null)`. Keep the existing header comment about bug #4 verbatim. |
| `src/server/routes/settingsRoutes.test.ts` | WP4 | Drop `restartInactiveNodeService`/`stopInactiveNodeService` assertions; assert the global POST fires `rescheduleInactiveNodeService(null)`. Range-validation error strings and status codes must be **unchanged**. |

### Suite-wide gates (WP5)

- `npx vitest run` fully green (0 failures) with PG + MySQL containers up.
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty.
- `npx tsc --noEmit` clean.
- `eslint-baseline.json` **must not grow any rule count**. The new modules must
  be `no-explicit-any`-free.

---

## 7. Work packages

Each is one Sonnet agent. **WP2, WP3 and WP4 are file-disjoint and may run in
parallel once WP1 has merged into the branch.**

### WP1 — Defaults module, accessor service, batched repo read
**Depends on:** nothing. **Blocks:** WP2, WP3, WP4.
**Writes:** `src/constants/nodeDisplayDefaults.ts` (new),
`src/server/services/nodeDisplaySettings.ts` (new),
`src/db/repositories/settings.ts`,
`src/constants/nodeDisplayDefaults.test.ts` (new),
`src/server/services/nodeDisplaySettings.test.ts` (new),
`src/db/repositories/settings.test.ts`,
`src/server/constants/settings.allowlist.test.ts`.

**Acceptance:**
- No behaviour change anywhere — this WP adds code, converts nothing.
- `nodeDisplaySettings.ts` imports **only** `../../constants/nodeDisplayDefaults.js`.
  Grep-verify it does not import `services/database.js`.
- `getSettingForSources` issues exactly one query (spy the drizzle builder or
  count via a test double) and passes on SQLite, PostgreSQL and MySQL.
- `NODE_DISPLAY_DEFAULT_STRINGS` deep-equals migration 131's `NODE_DISPLAY_SEED`.
  Migration 131 remains unedited.
- Full suite green.

### WP2 — Dashboard / neighbor-info path + dead-key bug
**Depends on:** WP1.
**Writes:** `src/server/services/sourceDashboardData.ts`,
`src/server/routes/unifiedRoutes.ts`,
`src/server/routes/neighborInfoRoutes.ts`,
`src/server/services/sourceDashboardData.perSource.test.ts` (new),
`src/server/routes/unifiedRoutes.perSource.test.ts` (new),
`src/server/routes/neighborInfoRoutes.test.ts`,
`src/server/server.neighbor-info-position.test.ts`.

**Acceptance:**
- `getMaxNodeAgeHours` no longer exists in `sourceDashboardData.ts`; nothing
  imports it from there.
- `GET /api/unified/dashboard` issues **one** settings query for N sources,
  proven by spy, and returns different `neighborInfo` per source.
- `sourceRoutes.ts` is **not modified** and its single-source callers resolve
  per-source.
- `neighborInfoRoutes` honours the setting; the string `'maxNodeAge'` no longer
  appears anywhere in `src/server/` outside comments.
- Full suite green.

### WP3 — Remaining read sites
**Depends on:** WP1.
**Writes:** `src/server/routes/tracerouteRoutes.ts`,
`src/server/routes/pollRoutes.ts`, `src/server/meshtasticManager.ts`,
`src/server/virtualNodeServer.ts`, `src/services/database.ts`,
`src/server/applyManagerSettings.ts`,
`src/services/database.maxNodeAge.perSource.test.ts` (new),
`src/server/routes/tracerouteRoutes.test.ts`,
`src/server/routes/pollRoutes.test.ts`,
`src/server/virtualNodeServer.zombieFix.test.ts`,
`src/server/applyManagerSettings.test.ts`.

**Acceptance:**
- Zero remaining `getSetting('maxNodeAgeHours')` / `getSettingAsync('maxNodeAgeHours')`
  in `src/` (non-test, non-migration) — grep-verify.
- `database.ts` does not import `sourceDashboardData.js`; no import cycle
  (`npx tsc --noEmit` clean plus a manual import-graph check).
- `applyManagerSettings` behaviour equivalence documented in the PR body.
- Full suite green.

### WP4 — Inactive-node service restructure + save side-effect
**Depends on:** WP1.
**Writes:** `src/server/services/inactiveNodeNotificationService.ts`,
`src/server/server.ts`, `src/server/routes/settingsRoutes.ts`,
`src/server/services/inactiveNodeNotificationService.perSource.test.ts` (new),
`src/server/services/inactiveNodeNotificationService.test.ts`,
`src/server/routes/settingsRoutes.perSource.test.ts`,
`src/server/routes/settingsRoutes.test.ts`.

**Acceptance:**
- Exactly **one** timer exists regardless of source count (assert
  `setInterval` call count under fake timers).
- Two sources with different check intervals run on different cadences.
- `nextRunAt` is pruned when a manager deregisters (no unbounded Map).
- A scoped POST reschedules only that source; a global POST reschedules all.
- `restartInactiveNodeService` no longer exists in the codebase.
- The Phase 1 TODO comment at `settingsRoutes.ts:353-361` is rewritten, not left
  stale.
- Full suite green.

### WP5 — Integration verification + docs
**Depends on:** WP2, WP3, WP4.
**Writes:** `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` (tick
Phase 2, append a Phase 2 deviations-log section), this spec file (record any
deviation).

**Acceptance:**
- Full Vitest suite green with PG + MySQL containers up; skipped-count check via
  the JSON reporter confirms the multi-backend suites actually ran.
- `npm run lint:ci` in-repo failures empty; `eslint-baseline.json` unchanged or
  smaller.
- Phase 2 exit criteria in the epic are demonstrably met (link the two
  `*.perSource.test.ts` files that prove "two sources with different
  `maxNodeAgeHours` get different node sets").

---

## 8. File ownership table — no file written by two packages

| File | Owner | Notes |
|---|---|---|
| `src/constants/nodeDisplayDefaults.ts` | WP1 | new |
| `src/constants/nodeDisplayDefaults.test.ts` | WP1 | new |
| `src/server/services/nodeDisplaySettings.ts` | WP1 | new |
| `src/server/services/nodeDisplaySettings.test.ts` | WP1 | new |
| `src/db/repositories/settings.ts` | WP1 | |
| `src/db/repositories/settings.test.ts` | WP1 | |
| `src/server/constants/settings.allowlist.test.ts` | WP1 | |
| `src/server/services/sourceDashboardData.ts` | WP2 | |
| `src/server/services/sourceDashboardData.perSource.test.ts` | WP2 | new |
| `src/server/routes/unifiedRoutes.ts` | WP2 | |
| `src/server/routes/unifiedRoutes.perSource.test.ts` | WP2 | new |
| `src/server/routes/neighborInfoRoutes.ts` | WP2 | |
| `src/server/routes/neighborInfoRoutes.test.ts` | WP2 | |
| `src/server/server.neighbor-info-position.test.ts` | WP2 | |
| `src/server/routes/tracerouteRoutes.ts` | WP3 | |
| `src/server/routes/tracerouteRoutes.test.ts` | WP3 | |
| `src/server/routes/pollRoutes.ts` | WP3 | |
| `src/server/routes/pollRoutes.test.ts` | WP3 | |
| `src/server/meshtasticManager.ts` | WP3 | |
| `src/server/virtualNodeServer.ts` | WP3 | |
| `src/server/virtualNodeServer.zombieFix.test.ts` | WP3 | |
| `src/services/database.ts` | WP3 | |
| `src/services/database.maxNodeAge.perSource.test.ts` | WP3 | new |
| `src/server/applyManagerSettings.ts` | WP3 | |
| `src/server/applyManagerSettings.test.ts` | WP3 | |
| `src/server/services/inactiveNodeNotificationService.ts` | WP4 | |
| `src/server/services/inactiveNodeNotificationService.test.ts` | WP4 | |
| `src/server/services/inactiveNodeNotificationService.perSource.test.ts` | WP4 | new |
| `src/server/server.ts` | WP4 | |
| `src/server/routes/settingsRoutes.ts` | WP4 | |
| `src/server/routes/settingsRoutes.test.ts` | WP4 | |
| `src/server/routes/settingsRoutes.perSource.test.ts` | WP4 | |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` | WP5 | |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_PHASE2_SPEC.md` | WP5 | |

**Collisions flagged and resolved:**
- `src/server/routes/settingsRoutes.ts` is touched by both the side-effect work
  and the range-constant reuse → **both assigned to WP4**, single owner.
- `src/server/services/sourceDashboardData.ts` and `unifiedRoutes.ts` are
  coupled by the deleted `getMaxNodeAgeHours` export → **both in WP2**.
- `src/server/server.ts` hosts both the service bootstrap and the callbacks
  block → **WP4 only**. WP3 must not touch it (`applyManagerSettings`'s callers
  need no edit).
- `src/db/repositories/settings.ts` is a WP1-only file; WP2 consumes the new
  method but must not edit the repository.

**No file appears twice.** Sequencing: `WP1 → (WP2 ‖ WP3 ‖ WP4) → WP5`.

---

## 9. Risks for the orchestrator

1. **Open question the epic deferred to this boundary — sources created after
   migration 131.** This spec assumes **Option 1** (hardcoded default). An admin
   who set `maxNodeAgeHours=72` globally and then adds a source silently gets 24
   there. Option 2 (seed from the current global value in the `sourceRoutes` POST
   handler) is purely additive and touches no read path, so it can land in
   Phase 3 or its own issue with zero rework. **Needs a yes/no before WP2 starts**
   only insofar as the wording of the defaults doc comment; the code is
   unaffected either way.
2. **`neighborInfoRoutes` starts behaving differently.** It has been pinned at
   24 h since the dead key was introduced. Anyone who tuned `maxNodeAgeHours`
   will see their neighbor-info link set change on upgrade. This is the fix, but
   it is a visible behaviour change and belongs in the release notes.
3. **Out-of-range clamp is a behaviour change.** Stored negative or
   above-max values previously flowed through verbatim (only `0`/`NaN` were
   caught by `|| 24`). They now resolve to the default. Low blast radius, but it
   can move a production install's node window.
4. **`inactiveNodeNotificationService` warm-up semantics shift.** Today the first
   check fires 60 s after boot and then every `checkIntervalMinutes`. After the
   change every source's first check still fires at ~60 s, but the *second* is
   governed by that source's own interval. Installs where the global interval was
   set very high will see one extra early check per source on the first boot
   after upgrade. Harmless (cooldown suppresses duplicate alerts) but worth a
   line in the PR body.
5. **`server.neighbor-info-position.test.ts` is a re-implementation test.** WP2
   is asked to convert or delete its re-implemented route body. If the harness
   conversion turns out to be large, the fallback is to delete the re-implemented
   filter leg and keep the position assertions — flag to me rather than leaving
   a fake that hard-codes the dead key.
6. **Bug #4 (`SOURCEY_RESOURCES` divergence, #4416) is still live.** A
   `settings:write` grant scoped to source A still authorises a write to source
   B. Phase 2 does not change that and cannot. Do not let a reviewer read the new
   per-source reads as "per-source settings are now secure".
7. **Parallel WP2/WP3/WP4 in a shared worktree.** Per the repo's
   `parallel_agents_rtk_commit_hazard` note, `rtk`-wrapped `git commit`
   auto-stages; concurrent agents in one worktree will sweep each other's files.
   Either give each WP its own worktree or require the pathspec commit form and
   audit per-commit file lists.
