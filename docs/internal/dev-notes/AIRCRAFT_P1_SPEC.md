# Likely-Aircraft Detection: Phase 1 Implementation Spec (#5364, #5365)

Epic plan and binding decisions: `docs/internal/dev-notes/AIRCRAFT_DETECTION_EPIC.md`.
Branch: `feature/aircraft-p1-classifier` (off `origin/main` at `cc60fe26`).
Next migration numbers: **175** and **176** (latest on main is 174).

Line numbers below were checked on `cc60fe26` and will drift. Search for the quoted
symbol, not the number.

---

## 0. Decisions made in this spec

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D1 | Where to persist the classification | **New columns on `nodes`** | Every node read path (poll, `/api/nodes`, Dashboard per-source feed, unified merge, popups) already selects `nodes.*`. A side table would need a join in 4+ read paths, its own delete cleanup, and its own source scoping. `nodes` already has the composite PK `(nodeNum, sourceId)`, so the flag is per source for free, and a node purge removes it. The cost is known and bounded (§3.1). |
| D2 | Meshtastic only, or MeshCore too | **Meshtastic only**, including MQTT sources (`mqtt_bridge`, `mqtt_broker`) | MeshCore adverts carry no altitude. `meshcore_nodes.altitude` is only written from remote LPP GPS telemetry, which is rare. MeshCore lives in a separate table and manager. The epic says "Meshtastic nodes". MeshCore can follow later if users ask. |
| D3 | Where classification runs | One **fire-and-forget, coalescing, single-flight batch queue** (`aircraftClassificationService`), fed from the three position-write sites | Never blocks or throws into RX. Coalescing by `(sourceId,nodeNum)` bounds the queue at the node count. One batch in flight bounds concurrency to 1 `sample()` call. A batch groups up to 100 points, so the Terrarium provider fetches each tile once per batch and the JSON provider batches its calls. |
| D4 | Elevation failure handling | 15 s timeout race around `sample()`. An all-null batch starts a 10-minute provider backoff that uses the MSL fallback | `safeFetch` has **no timeout** (`src/server/utils/ssrfGuard.ts:224`). A hung fetch would otherwise wedge the single-flight queue. The backoff stops an offline install from retrying on every packet. |
| D5 | Avoid repeat fetches for fixed nodes | In-memory LRU per `(sourceId,nodeNum)` holding `{latE4, lonE4, ground}`. If coordinates round to the same 4 dp (~11 m), reuse `ground` with no fetch | Most nodes never move. After one fetch, a fixed node costs nothing. |
| D6 | Threshold change | **One-shot silent recompute** from stored `altitude` + `groundElevation`, with no network calls. Rows with no stored ground get the MSL basis until their next position | Instant feedback on save, no burst of fetches, no automation storm. |
| D7 | Disable | Saving `aircraftDetectionEnabled=false` clears `likelyAircraft`/`aircraftBasis`/`heightAboveGround` for that source (keeps `groundElevation`), and the queue skips the source | The map and Auto-Favorite read only the flag, so clearing it switches both off. |
| D8 | Flapping near the threshold | **Hysteresis** in the pure classifier. Once flagged on a basis, the node stays flagged until the height drops below `threshold − max(50, round(0.1·threshold))`. Hysteresis only applies when the basis is unchanged | GPS altitude noise is ±15–30 m. Without hysteresis a node hovering at 500 m AGL would flip and re-fire the automation. |
| D9 | When the automation event fires | Only for `reason: 'position'` jobs, and only when `previous !== true && next === true` (so `null→true` counts). Backfill and settings recomputes are **silent**. `previous` is read from the persisted row | A plane first heard at altitude (`null→true`) is the main case. The persisted flag means a restart does not re-fire. |
| D10 | Frontend refresh | **No `node:updated` emit.** The classification reaches clients on the next poll (Dashboard 15 s, NodesTab poll interval) | `node:updated` feeds `trigger.nodeUpdated` **and** `checkNodeOnline` (`automationEngineSingleton.ts:128-141`). A silent bulk recompute would fire false "node back online" alerts for silent nodes. |
| D11 | Startup backfill | Once, 2 min after boot: queue every node row with `altitude IS NOT NULL AND aircraftClassifiedAt IS NULL` on non-MeshCore sources that have detection enabled. Silent | Without it, planes that were auto-favourited before the upgrade never send another position, so the sweep never removes them. That clutter is the #5364 pain point. Each node runs once, ever. |
| D12 | Map display preference | Server-persisted per user in `user_map_preferences.aircraft_display_mode` (the `spread_nodes` #5177 precedent), mirrored to `localStorage` for anonymous viewers (the `showEstimatedPositions` precedent) | Matches every other Map Features toggle. Anonymous users get 403 on save, so the mirror keeps their choice. |
| D13 | Hide mode and favourites | Favourites **bypass** Hide | Matches the age filter (`NodesTab.tsx` "Favorites are always shown"). |
| D14 | Auto-Favorite exclusion toggle | **Its own per-source switch** `autoFavoriteExcludeAircraft` (default on), in the Auto-Favorite section. The exclusion applies only when **both** detection and this switch are on | User decision (§11 Q2). |
| D15 | Trigger scope | Any node (the `trigger.nodeRebooted` pattern, `runTrigger`), with no `nodeNums` list | You cannot pre-select a plane you have never seen. Users narrow it with the existing "Source is one of…" condition. |
| D16 | Movement in P1 | **Not used.** `ground_speed` is stored as telemetry, but P1 ignores it | Keeps P1 simple. P2 adds stationary→fixed reclassification with a persisted override (see §9). |
| D17 | Position override | Classify the **effective** position (`getEffectiveDbNodePosition`) | The map shows the override, so the flag must describe the same point. An override with no `altitudeOverride` falls back to the device `altitude`, as the helper already does. |
| D18 | Where the detection settings live | **Settings → Node Display** (per-source), routed by `NODE_DISPLAY_SETTING_KEYS`. Not added to the MeshCore Node Display section | User decision (§11 Q1). `SettingsTab` never mounts under a MeshCore route (`SettingsTab.tsx` ~2290 comment), so no source-type gate is needed. |
| D19 | Sweep removal needs two strikes | A flagged auto-favourite is removed only when it was flagged at **two consecutive sweeps at least 45 min apart**. Strikes live in a persisted per-source JSON setting `autoFavoriteAircraftStrikes` (server-managed, like `autoFavoriteNodes`) | User decision (§11 Q5). The 45-min gap stops the boot sweep (`S * 11` = 55 s after every connect **and reconnect**, `meshtasticManager.ts` ~2298) from counting as a second sweep after a quick restart or TCP reconnect. Each reconnect also adds another hourly `setInterval` (existing behaviour, ~2290), so sweeps can run more often than hourly. The timestamp gap keeps the strike rule correct regardless. Persisted, so restarts and settings saves cannot reset it (mesh checklist §3). |

---

## 1. Reuse inventory (read before writing code)

| Mechanism | Where | How P1 uses it |
|-----------|-------|----------------|
| DEM sampling | `src/server/services/elevationProvider.ts`: `ElevationProvider.sample(points)` (never throws, null per failed point), `resolveProvider(url)` :452, `TerrariumTileProvider` (groups points by z12 tile, module-scope `tileCache` LRU 64), `JsonPointProvider` (batches of 100, cache 10k), `sanitizeElevation` (clamps −500..9000 m to null) | The service calls `resolveProvider(elevationSourceUrl).sample(batch)`. No change to the provider. |
| Elevation gates | Global settings `elevationEnabled` (`'false'` = off) and `elevationSourceUrl` (secret). Both are in `GLOBAL_ONLY_SETTINGS_KEYS` (`settings.ts:735-736`) and read with `databaseService.settings.getSetting(...)` (`elevationRoutes.ts:135-141`) | Read once per batch. |
| Front-end AGL helper | `src/utils/linkProfile.ts:57 aglFromNodeAltitude` (rounds, returns null below 0.5 m) | **Do not reuse for classification.** It hides negative/near-zero AGL, but the classifier needs the signed value. The note is here so nobody "dedupes" into it. |
| Per-update classification precedent | `nodeMobilityService.updateNodeMobility` + `databaseService.updateNodeMobilityAsync` called fire-and-forget at `meshtasticManager.ts:7891` and `:10077`, and `dataEventEmitter.emitNodeMobility` :193 | Same call shape (`.catch` logged, never awaited). Mobility is cross-source by `nodeId`. **Ours is per source.** |
| Effective position | `src/server/utils/nodeEnhancer.ts:48 getEffectiveDbNodePosition(node)` | Job input (D17). |
| Bogus position | `src/utils/nullIsland.ts isBogusPosition` | A bogus lat/lon means "no point to sample", so the MSL basis applies. |
| LRU | `src/server/utils/lruCache.ts LruCache<K,V>(max)` | Ground memo (D5). |
| Per-source settings read | `databaseService.settings.getSettingForSource(sourceId, key)` (`settings.ts:243`). This does **not** fall back to global (memory: per-source settings read with the bare key return null) | All aircraft and exclusion keys, plus the strikes JSON. |
| Settings allowlists | `src/server/constants/settings.ts`: `VALID_SETTINGS_KEYS` :9, `PER_SOURCE_SETTINGS_KEYS` :432, `GLOBAL_ONLY_SETTINGS_KEYS` :688, `PER_SOURCE_KEYS_NOT_POSTABLE` :761. `settings.allowlist.test.ts` asserts exact equality | Add the keys per §4.6. |
| Settings validation + post-save hooks | `settingsRoutes.ts`: `STRICT_BOOLEAN_SETTINGS_KEYS` :349 (module-local, `fail(…'INVALID_BOOLEAN_SETTING')`), range checks :455-475 (`fail(res,400,'INVALID_MAX_NODE_AGE_HOURS',…)`), per-source branch side-effects :896-960 (the `autoDeleteByDistance` post-write read pattern) | Validate and trigger `reclassifySource` (D6/D7). |
| Auto-Favorite | `favoritesService.ts`: `checkAutoFavorite` :234 (called from `meshtasticManager.ts:8185` on NodeInfo), `autoFavoriteSweep` :310 (hourly + at boot, `meshtasticManager.ts:2291-2302`), per-source provenance list `autoFavoriteNodes`, `favoriteLocked` skip | Add gate + sweep reason. |
| Remote auto-favorite | `autoFavoriteManagementService.ts selectNewFavorites` :165, fed at :361-380 (loop already calls `nodes.getNode(c, sourceId)` per candidate) | Add aircraft to `excluded` (trivial, included). |
| Marker badge | `src/components/map/markerIcons.ts createNodeIcon` :77, `isUnmessagable` option :40 / badge :159. SVG string builders in `src/utils/roleGlyphSvg.ts` (Leaflet-free, `unmessageableBadgeSvg` :43) | `isLikelyAircraft` option + `aircraftBadgeSvg`. |
| Marker call sites (iconSig) | `NodesTab.tsx:1893`, `Dashboard/DashboardMap.tsx:707`, `MapAnalysis/layers/NodeMarkersLayer.tsx:123/151` | Pass the flag and add it to every `iconSig`. EmbedMap, MeshCoreMap and ReticulumMap are **not** touched. |
| Shared Map Features control | `src/components/map/MapAgeFilterControl.tsx` + `.module.css` + `.test.tsx`, used at `NodesTab.tsx:2885` and `DashboardMap.tsx:990` | Pattern for `MapAircraftDisplayControl`. |
| Visible-node chains | NodesTab `visibleMapNodes` :1785 (also feeds 3D `node3DFeatures`); DashboardMap `nodesWithTruePos` inside the `useMemo` at :372-415; MapAnalysis `useAnalysisNodes` (reads `useMapContextOptional()?.spreadNodes` :78) | Hide filter. |
| Map prefs persistence | Migration 164 (`spread_nodes`), `src/db/schema/misc.ts` :127/:162/:417, `src/db/repositories/mapPreferences.ts` :54/:86/:118/:147, `src/services/database.ts` :5460 (type), `userPreferencesRoutes.ts` :44-91 (body destructure, validation, save), `MapContext.tsx` (setter :249 pattern, loader :401 pattern, `localStorage` mirror :170/:286 pattern) | `aircraftDisplayMode`. |
| Popups | `src/components/map/popups/nodeCardModel.ts` (`altitude` :54/:137), `sections.tsx SignalItems` altitude row :190; `src/components/NodeDetailsBlock.tsx:576` | Aircraft row next to altitude. |
| Icons | `src/components/icons/UiIcon.tsx UI_ICON_DEFINITIONS` :133 (`altitude` uses `Mountain` :140). `lucide-react` ships `Plane` | Add `aircraft: { lucide: Plane, emoji: '✈️', usage: 'likely-aircraft nodes' }`. The marker badge (an HTML string) embeds the same Lucide `Plane` path, the same way the unmessageable badge embeds Lucide `Ban`. |
| DTO mappers (**two copies**) | `src/server/utils/dbNodeMapper.ts:21 mapDbNodeToDeviceInfo` and `src/server/services/nodeDbMaintenanceService.ts:44 mapDbNodeToDeviceInfo` (used by `getAllNodesAsync` → `/api/poll` + `/api/nodes`) | Map the new fields in **both**. |
| PG/MySQL node cache | `src/server/services/nodeCacheService.ts fromRepoNode` :44 (explicit projection. Note that `isUnmessagable` is *missing* there today); `NodesRepository.syncCacheNode` :86 | Add the fields to the projection and sync after the write. |
| Cross-source merge | Server `src/server/utils/mergeNodesAcrossSources.ts` (position fields copied from `bestPosition` row); client `src/hooks/useDashboardData.ts mergeNodeRecords` :294 (position block :371-383, which does **not** carry `altitude` today) | Aircraft fields and altitude come from the **same row** as the coordinates. |
| Automation trigger plumbing | Model `trigger.nodeRebooted`: `src/types/automation.ts` :33/:84; `dataEventEmitter.ts` :23/:85/:210; `automationEngineSingleton.ts` :145; `automationEngineService.ts onNodeRebooted` :969 → `runTrigger` :682; `triggerContext.ts buildNodeRebootedContext` :459; `src/components/automations/catalog.ts` :298/:339/:381; `substitutionNodeTokens.ts` :40; `SubstitutionsHelp.tsx` :54/:67 | New `trigger.becameLikelyAircraft`. |
| Automation limits | Per-automation `COOLDOWN` / `COOLDOWN_SCOPE` fields, `cooldownGate` + `rateLimitGate` in `runTrigger` | Reused, nothing new. |
| Auto-Favorite UI | `src/components/AutoFavoriteSection.tsx` (self-contained, `csrfFetch` GET/POST `/api/settings${sourceQuery}`, `localEnabled`/`localStaleHours` + `initialSettings` dirty tracking :39-102), mounted in `AutomationTab.tsx:157` | Gains the `autoFavoriteExcludeAircraft` switch. |
| Node Display per-source routing | `src/constants/nodeDisplayDefaults.ts NODE_DISPLAY_SETTING_KEYS` :19 (the frozen ten, tied to migration 131's seed via `NODE_DISPLAY_DEFAULT_STRINGS`). Consumers: `SettingsTab.tsx handleSave` partition :1084-1112 (scoped `?sourceId=` POST), `settingsRoutes.ts` GET :284 (excludes these keys from the global back-fill), `utils/nodeDisplayStorage.ts` :61 (legacy bare-key purge), `MeshCoreNodeDisplaySection.tsx` :39 (`satisfies NodeDisplaySettingKey[]`) | The aircraft keys join the routed set (§4.6). |
| SettingsTab draft | `SettingsDraft` type (~:88-165), `buildBaseline` (~:780-808, reads `initial*` state), server-load block (~:558-700, `updateField` + `setInitial*`, fetched with `sourceQuery`), `const settings = {…}` literal in `handleSave` (~:1040-1080), Node Display section `#settings-node-display` (~:2228) | Aircraft inputs and draft fields (§5.10). |
| Settings persistence tests | `src/server/server.settings-persistence.test.ts` (extracts the `const settings` literal and executes the real partition against `NODE_DISPLAY_SETTING_KEYS`), `SettingsTab.nodeDisplay.perSource.test.tsx` :304/:343, `constants/nodeDisplayDefaults.test.ts` ("exactly ten", seed deep-equal), `settings.allowlist.test.ts` :98-113 ("exactly ten"), `utils/nodeDisplayStorage.test.ts` | Update for the new routed keys (§6). |
| Elevation on/off in the UI | `src/hooks/useElevationEnabled.ts:11 useElevationEnabled()` | Greys out the explanation line in Node Display. |
| Hand-written nodes DDL in tests | `src/db/repositories/nodes.test.ts` (`POSTGRES_CREATE` :25, `MYSQL_CREATE` :104), **plus** `nodes.transportHeard.multiBackend.test.ts` and `nodes.transportStampInsert.multiBackend.test.ts` | Add all 5 columns to all three files (CLAUDE.md #4250). |
| Migration helpers | `src/server/migrations/helpers.ts` `addColumnIfMissing` / `…Postgres` / `…Mysql`. **The DDL includes the column name** (quoted for PG) | §3. |
| Service init seam | `src/server/server.ts` :370-396 (`autoFavoriteManagementScheduler.initialize()`) | Start the backfill timer. |
| Source listing | `databaseService.sources.getAllSources()` (`src/db/repositories/sources.ts:54`). Types: `meshtastic_tcp`, `mqtt_bridge`, `mqtt_broker`, `meshcore`, `meshcore_mqtt`, `reticulum` | Backfill skips `meshcore*` and `reticulum`. |

---

## 2. Data model

### 2.1 `nodes` columns (migration 175)

| Column | SQLite | PostgreSQL | MySQL | Meaning |
|--------|--------|------------|-------|---------|
| `likelyAircraft` | `INTEGER` (drizzle `{ mode: 'boolean' }`), NULL | `BOOLEAN` NULL | `BOOLEAN` NULL | `true` = likely aircraft, `false` = classified as not, `NULL` = never classified / unknown / detection off |
| `aircraftBasis` | `TEXT` | `TEXT` | `VARCHAR(8)` | `'agl' \| 'msl' \| 'unknown'`, NULL when unclassified |
| `groundElevation` | `REAL` | `DOUBLE PRECISION` | `DOUBLE` | DEM metres at the classified point; NULL if not sampled |
| `heightAboveGround` | `REAL` | `DOUBLE PRECISION` | `DOUBLE` | `altitude − groundElevation`, signed; NULL unless basis `agl` |
| `aircraftClassifiedAt` | `INTEGER` | `BIGINT` | `BIGINT` | ms epoch of the last write; the backfill key |

No `DEFAULT`, no index. `upsertNode` must **not** write these columns, on insert or on conflict (like `mobile`/`notes`, `nodes.ts:737`). Only the new repository methods write them.

### 2.2 `user_map_preferences.aircraft_display_mode` (migration 176)

SQLite `TEXT`, PG `TEXT`, MySQL `VARCHAR(8)`, NULL default. NULL reads as `'mark'`.

### 2.3 Per-source settings

| Key | Default (when null) | Valid | Notes |
|-----|---------------------|-------|-------|
| `aircraftDetectionEnabled` | `'true'` | `'true' \| 'false'` (strict) | Node Display. Master switch: classification, badge data, trigger; the Auto-Favorite exclusion also needs it |
| `aircraftAglThresholdMeters` | `'500'` | integer 50–20000 | Node Display |
| `aircraftMslThresholdMeters` | `'5000'` | integer 500–20000 | Node Display. Fallback when there is no ground elevation |
| `autoFavoriteExcludeAircraft` | `'true'` | `'true' \| 'false'` (strict) | Auto-Favorite section. Exclusion is active only when this **and** `aircraftDetectionEnabled` are on |
| `autoFavoriteAircraftStrikes` | `'{}'` | server-managed JSON, never POSTed | `{ "<nodeNum>": { "count": 1, "lastAt": <ms> } }` (§4.11). In `PER_SOURCE_SETTINGS_KEYS` **and** `PER_SOURCE_KEYS_NOT_POSTABLE`, not in `VALID_SETTINGS_KEYS` (the `autoFavoriteNodes` precedent) |

All three detection keys are stored as `'true'`/`'false'` (not the `'0'`/`'1'` of the seeded Node Display booleans), matching `elevationEnabled` and `autoFavoriteEnabled`. No seed migration: an unset key falls through to the default in `parseAircraftSettings`. Because the GET back-fill skips `NODE_DISPLAY_SETTING_KEYS`, a legacy global row can never leak in (§4.6).

---

## 3. Migrations

### 3.1 `src/server/migrations/175_add_node_aircraft_classification.ts`

Model this on migration 164 (helpers, `LABEL`/`TABLE` consts, header comment that explains D1).

```ts
const COLS_SQLITE = [
  ['likelyAircraft',       'likelyAircraft INTEGER'],
  ['aircraftBasis',        'aircraftBasis TEXT'],
  ['groundElevation',      'groundElevation REAL'],
  ['heightAboveGround',    'heightAboveGround REAL'],
  ['aircraftClassifiedAt', 'aircraftClassifiedAt INTEGER'],
] as const;
const COLS_PG = [
  ['likelyAircraft',       '"likelyAircraft" BOOLEAN'],
  ['aircraftBasis',        '"aircraftBasis" TEXT'],
  ['groundElevation',      '"groundElevation" DOUBLE PRECISION'],
  ['heightAboveGround',    '"heightAboveGround" DOUBLE PRECISION'],
  ['aircraftClassifiedAt', '"aircraftClassifiedAt" BIGINT'],
] as const;
const COLS_MYSQL = [
  ['likelyAircraft',       'likelyAircraft BOOLEAN'],
  ['aircraftBasis',        'aircraftBasis VARCHAR(8)'],
  ['groundElevation',      'groundElevation DOUBLE'],
  ['heightAboveGround',    'heightAboveGround DOUBLE'],
  ['aircraftClassifiedAt', 'aircraftClassifiedAt BIGINT'],
] as const;
export const migration = { up(db) { for (const [c, ddl] of COLS_SQLITE) addColumnIfMissing(db, 'nodes', c, ddl); }, down() {} };
export async function runMigration175Postgres(client) { for (…) await addColumnIfMissingPostgres(client, 'nodes', c, ddl); }
export async function runMigration175Mysql(pool)     { for (…) await addColumnIfMissingMysql(pool, 'nodes', c, ddl); }
```

Register in `src/db/migrations.ts`: `number: 175, name: 'add_node_aircraft_classification', settingsKey: 'migration_175_add_node_aircraft_classification'`.

### 3.2 `src/server/migrations/176_user_map_preferences_aircraft_display_mode.ts`

Copy migration 164. DDL: SQLite `aircraft_display_mode TEXT`, PG `"aircraft_display_mode" TEXT`, MySQL `aircraft_display_mode VARCHAR(8)`. Register: `number: 176, name: 'user_map_preferences_aircraft_display_mode', settingsKey: 'migration_176_user_map_preferences_aircraft_display_mode'`.

Both are pure additive `ADD COLUMN`, idempotent on all backends, and need no backfill.

Tests: `175_….test.ts` (SQLite, run twice, columns present), `175_….pgmysql.test.ts` (use `createIsolatedPostgresDatabase` / `createIsolatedMysqlDatabase`, run twice), and the same pair for 176 (copy `164_user_map_preferences_spread_nodes.pgmysql.test.ts`).

---

## 4. Server design

### 4.1 Pure classifier: `src/utils/aircraftClassification.ts` (NEW, shared server + client)

It lives under `src/utils/` because the settings UI needs the ranges and the popup needs the formatting. It must not import the DB, Leaflet or React. Use `.js` relative imports (it is in the server compile set).

```ts
export type AircraftBasis = 'agl' | 'msl' | 'unknown';
export type AircraftDisplayMode = 'show' | 'mark' | 'hide';

export const DEFAULT_AIRCRAFT_AGL_THRESHOLD_M = 500;
export const DEFAULT_AIRCRAFT_MSL_THRESHOLD_M = 5000;
export const AIRCRAFT_AGL_RANGE = { min: 50, max: 20000 } as const;
export const AIRCRAFT_MSL_RANGE = { min: 500, max: 20000 } as const;
export const AIRCRAFT_DISPLAY_MODES: readonly AircraftDisplayMode[] = ['show', 'mark', 'hide'];
export const DEFAULT_AIRCRAFT_DISPLAY_MODE: AircraftDisplayMode = 'mark';

export interface AircraftSettings { enabled: boolean; aglThresholdM: number; mslThresholdM: number; }
export interface AircraftPrevious { likelyAircraft: boolean | null; basis: AircraftBasis | null; }
export interface AircraftClassification {
  likelyAircraft: boolean | null;
  basis: AircraftBasis;
  groundElevation: number | null;   // passthrough of the input (null if not finite)
  heightAboveGround: number | null; // signed; only when basis === 'agl'
}

/** Null/garbage → defaults; out-of-range numbers are clamped into range. */
export function parseAircraftSettings(raw: {
  enabled?: string | null; aglThresholdM?: string | null; mslThresholdM?: string | null;
}): AircraftSettings;

/** max(50, round(0.1 × threshold)). */
export function aircraftHysteresisM(thresholdM: number): number;

export function classifyAircraft(input: {
  altitudeM: number | null | undefined;
  groundElevationM: number | null | undefined;
  settings: AircraftSettings;
  previous?: AircraftPrevious | null;
}): AircraftClassification;

/** True only for a transition INTO the flagged state: prev !== true && next === true. */
export function isAircraftTransition(prev: boolean | null | undefined, next: boolean | null): boolean;

/** Coerce SQLite 0/1, PG/MySQL booleans, null → boolean | null. */
export function normalizeLikelyAircraft(v: unknown): boolean | null;

export function isAircraftDisplayMode(v: unknown): v is AircraftDisplayMode;
```

`classifyAircraft` rules (in order):
1. `altitudeM` not a finite number → `{ likelyAircraft: null, basis: 'unknown', groundElevation: g, heightAboveGround: null }`.
2. `groundElevationM` is a finite number → basis `'agl'`, `hag = altitude − ground`. Threshold `T = aglThresholdM`. If `previous?.likelyAircraft === true && previous.basis === 'agl'`, flagged = `hag > T − aircraftHysteresisM(T)`. Otherwise flagged = `hag > T` (strict).
3. Otherwise basis `'msl'`, `T = mslThresholdM`, same hysteresis rule against `altitudeM` with `previous.basis === 'msl'`. `heightAboveGround: null`.

It does **not** look at `settings.enabled`. The service handles disable. That keeps the function total and easy to test.

### 4.2 Queue service: `src/server/services/aircraftClassificationService.ts` (NEW)

```ts
export type AircraftClassifyReason = 'position' | 'backfill';

export interface AircraftClassificationDeps {
  getNode(nodeNum: number, sourceId: string): Promise<DbNode | null>;
  writeClassification(nodeNum: number, sourceId: string, c: AircraftClassificationWrite): Promise<void>;
  listForReclassify(sourceId: string): Promise<AircraftReclassifyRow[]>;
  listUnclassifiedWithAltitude(sourceId: string): Promise<number[]>;
  clearClassification(sourceId: string): Promise<number>;
  getSourceSetting(sourceId: string, key: string): Promise<string | null>;
  getGlobalSetting(key: string): Promise<string | null>;
  listSources(): Promise<Array<{ id: string; type: string }>>;
  resolveProvider(url: string | undefined): ElevationProvider;
  emitAircraft(data: NodeAircraftData, sourceId: string): void;
  now(): number;
  setTimer: typeof setTimeout; clearTimer: typeof clearTimeout;
}

export class AircraftClassificationService {
  constructor(deps?: Partial<AircraftClassificationDeps>);   // defaults wire databaseService / dataEventEmitter
  /** Sync, never throws, never awaits. Coalesces by `${sourceId}:${nodeNum}`; 'position' wins over 'backfill'. */
  schedule(sourceId: string, nodeNum: number, reason?: AircraftClassifyReason): void;
  /** D6/D7: silent, no network. Disabled → clearClassification. Returns rows written. */
  reclassifySource(sourceId: string): Promise<number>;
  /** D11: enqueue unclassified rows with altitude on eligible, enabled sources ('backfill'). */
  backfillAll(): Promise<void>;
  /** Test hooks. */
  drainForTest(): Promise<void>;
  resetForTest(): void;
}
export const aircraftClassificationService: AircraftClassificationService;
```

Constants: `MAX_BATCH = 100`, `MAX_PENDING = 20_000` (backstop; on overflow drop the new key and log `debug` once per minute), `SAMPLE_TIMEOUT_MS = 15_000`, `PROVIDER_BACKOFF_MS = 10 * 60_000`, `GROUND_MEMO_MAX = 20_000`, `BACKFILL_DELAY_MS = 120_000`.

Drain loop (single-flight): `schedule` puts the key into `pending: Map<string, AircraftClassifyReason>` and, if no drain is running, starts one with `setImmediate`/`queueMicrotask`. The drain loops while `pending` is not empty:
1. Take up to `MAX_BATCH` entries in insertion order.
2. For each, load settings for its source (memoised for this batch). If disabled, skip it. (If the row still carries a non-null flag, `clearClassification` for that source runs once per batch.)
3. `node = await getNode(nodeNum, sourceId)`. Skip if null. `eff = getEffectiveDbNodePosition(node)`. `previous = { likelyAircraft: normalizeLikelyAircraft(node.likelyAircraft), basis: node.aircraftBasis ?? null }`.
4. Ground resolution per job: no finite altitude → no ground needed. Bogus or missing lat/lon → `ground = null`. A ground-memo hit (same `latE4/lonE4`) → reuse. Otherwise add to `needsSample`.
5. If `needsSample` is non-empty, `elevationEnabled !== 'false'`, and `now >= backoffUntil`: `results = await withTimeout(provider.sample(points), SAMPLE_TIMEOUT_MS)`. On timeout, throw, or all-null: `backoffUntil = now + PROVIDER_BACKOFF_MS`, and log `warn` once per backoff window. Store non-null results in the ground memo.
6. `c = classifyAircraft(...)`. Write only when `likelyAircraft`, `basis` or `groundElevation` changed, `|Δhag| ≥ 1`, or `aircraftClassifiedAt` is null. The write sets `aircraftClassifiedAt = now()`.
7. If `reason === 'position' && isAircraftTransition(previous.likelyAircraft, c.likelyAircraft)`, call `emitAircraft({...}, sourceId)`.

Every per-job step sits in try/catch → `logger.debug`. One bad node must never stop the batch. Nothing escapes `schedule()`.

`reclassifySource`: read the settings. If disabled, return `clearClassification(sourceId)`. Otherwise, for each row from `listForReclassify`, recompute with the stored `groundElevation` (no fetch) and the effective altitude, and write if changed. No events.

`backfillAll`: sources filtered to `type` not in `{meshcore, meshcore_mqtt, reticulum}`, enabled only. `schedule(sourceId, n, 'backfill')` for each id from `listUnclassifiedWithAltitude`.

### 4.3 Repository: `src/db/repositories/nodes.ts` (add)

All of these take a **required** `sourceId` and scope with `and(eq(nodes.nodeNum, …), eq(nodes.sourceId, sourceId))` or `withSourceScope(nodes, sourceId)`. See the memory note "withSourceScope is opt-in per method".

```ts
export interface AircraftClassificationWrite {
  likelyAircraft: boolean | null; aircraftBasis: AircraftBasis | null;
  groundElevation: number | null; heightAboveGround: number | null; aircraftClassifiedAt: number | null;
}
export interface AircraftReclassifyRow {
  nodeNum: number; altitude: number | null; groundElevation: number | null;
  likelyAircraft: boolean | null; aircraftBasis: string | null; heightAboveGround: number | null;
  positionOverrideEnabled: boolean | null; latitudeOverride: number | null;
  longitudeOverride: number | null; altitudeOverride: number | null;
  latitude: number | null; longitude: number | null;
}
async setAircraftClassification(nodeNum: number, sourceId: string, c: AircraftClassificationWrite): Promise<void>; // does NOT bump updatedAt; syncCacheNode after
async getAircraftReclassifyRows(sourceId: string): Promise<AircraftReclassifyRow[]>; // rows where altitude IS NOT NULL OR likelyAircraft IS NOT NULL
async getUnclassifiedNodeNumsWithAltitude(sourceId: string): Promise<number[]>;     // altitude IS NOT NULL AND aircraftClassifiedAt IS NULL
async clearAircraftClassification(sourceId: string): Promise<number>;               // likelyAircraft/aircraftBasis/heightAboveGround := NULL; keep groundElevation; return affected; sync cache per row
```

Coerce `nodeNum` with `Number(...)` (BIGINT on PG/MySQL). No `updatedAt` bump: `updatedAt` is the merge tie-breaker and the list sort order, and a classifier write is not node activity.

### 4.4 Ingest hooks (the only RX-path edits)

All three are one synchronous line after the position is persisted. Nothing is awaited.

| Site | Edit |
|------|------|
| `meshtasticManager.ts` POSITION_APP, `else` branch after `await databaseService.upsertNodeAsync(nodeData, this.sourceId)` (~7866), next to the mobility call | `aircraftClassificationService.schedule(this.sourceId, fromNum);` Skipped in the local-node `fixedPosition` branch, which does not write lat/lon/alt. |
| `meshtasticManager.ts` NodeInfo, inside `if (positionTelemetryData) {` near the mobility call (~10076) | `aircraftClassificationService.schedule(this.sourceId, nodeNumForTelemetry);` |
| `mqttIngestion.ts` POSITION_APP (~528): `void databaseService.upsertNodeAsync(node).catch(…)` | Change to `void databaseService.upsertNodeAsync(node).then(() => { if (!positionIsBogus && typeof alt === 'number') aircraftClassificationService.schedule(sourceId, fromNum); }).catch(err => logger.error('MQTT upsertNode failed:', err));`. The chain puts the job after the write. |

### 4.5 Settings route: `src/server/routes/settingsRoutes.ts`

- Add `'aircraftDetectionEnabled'` and `'autoFavoriteExcludeAircraft'` to `STRICT_BOOLEAN_SETTINGS_KEYS` (:349).
- Add range checks next to the `maxNodeAgeHours` block, using `AIRCRAFT_AGL_RANGE` / `AIRCRAFT_MSL_RANGE`. Reject non-integers → `fail(res, 400, 'INVALID_AIRCRAFT_AGL_THRESHOLD' | 'INVALID_AIRCRAFT_MSL_THRESHOLD', msg)`.
- Per-source branch, after `setSourceSettings`: if any of the three **detection** keys is in `filteredSettings`, call `void aircraftClassificationService.reclassifySource(sourceId).catch(err => logger.warn(...))`. Do not await; the response must not wait. `autoFavoriteExcludeAircraft` triggers nothing: the sweep reads it.
- The GET back-fill exclusion (:284) needs **no edit**. It already skips everything in `NODE_DISPLAY_SETTING_KEYS`, so the three detection keys are covered once they join that constant.
- `autoFavoriteAircraftStrikes` is not in `VALID_SETTINGS_KEYS`, so POST drops it. No client can reset strikes.

### 4.6 Settings constants

**`src/server/constants/settings.ts`:**
- `VALID_SETTINGS_KEYS`: add `aircraftDetectionEnabled`, `aircraftAglThresholdMeters`, `aircraftMslThresholdMeters`, `autoFavoriteExcludeAircraft`.
- `PER_SOURCE_SETTINGS_KEYS`: add those four plus `autoFavoriteAircraftStrikes` (the last under the Auto-favorite group).
- `PER_SOURCE_KEYS_NOT_POSTABLE`: add `'autoFavoriteAircraftStrikes', // favoritesService.ts autoFavoriteSweep (#5364 two-strike rule)`.
- None go in `GLOBAL_ONLY_SETTINGS_KEYS`.

**`src/constants/nodeDisplayDefaults.ts`: split the frozen seed set from the routed set.** `NODE_DISPLAY_DEFAULT_STRINGS` is a `Record<NodeDisplaySettingKey, string>` that `nodeDisplayDefaults.test.ts` deep-equals against migration 131's frozen `NODE_DISPLAY_SEED`. If the three aircraft keys were added to `NODE_DISPLAY_SETTING_KEYS` alone, that record would need entries the seed does not have, and the seed test would fail. Migration 131 is a statement about a point in time and must not change. So:

```ts
/** The frozen ten keys seeded by migration 131. Do not add to this list. */
export const NODE_DISPLAY_SEEDED_KEYS = [ /* the existing ten, unchanged order */ ] as const;
export type NodeDisplaySeededKey = typeof NODE_DISPLAY_SEEDED_KEYS[number];

/** Likely-aircraft detection (#5364/#5365). Per-source, unseeded: unset → parseAircraftSettings default. */
export const AIRCRAFT_NODE_DISPLAY_KEYS = [
  'aircraftDetectionEnabled',
  'aircraftAglThresholdMeters',
  'aircraftMslThresholdMeters',
] as const;

/** Every key the Node Display section routes to the scoped ?sourceId= POST, and the GET back-fill skips. */
export const NODE_DISPLAY_SETTING_KEYS = [...NODE_DISPLAY_SEEDED_KEYS, ...AIRCRAFT_NODE_DISPLAY_KEYS] as const;
export type NodeDisplaySettingKey = typeof NODE_DISPLAY_SETTING_KEYS[number];

// Re-keyed on the seeded set only:
export const NODE_DISPLAY_DEFAULT_STRINGS: Readonly<Record<NodeDisplaySeededKey, string>> = { /* unchanged */ };
```

Consumer check (all verified on `cc60fe26`):
- `SettingsTab.tsx` partition and `settingsRoutes.ts` GET `:284` keep using `NODE_DISPLAY_SETTING_KEYS`, so they pick up the aircraft keys with no edit.
- `nodeDisplayStorage.ts` purges bare legacy keys named in `NODE_DISPLAY_SETTING_KEYS`. The aircraft keys were never stored bare, so that is a harmless no-op. `readNodeDisplayLocal`/`writeNodeDisplayLocal` are typed with `NodeDisplaySettingKey`, and the aircraft keys are never mirrored.
- `MeshCoreNodeDisplaySection.tsx` `satisfies readonly NodeDisplaySettingKey[]` still holds (a subset). **Do not add the aircraft keys there** (D2/D18).
- `useNodeDisplaySettings` is **not** extended. No frontend reader needs the thresholds outside the settings form.
- The "exactly ten" assertions move to `NODE_DISPLAY_SEEDED_KEYS` (§6).

### 4.7 Server wiring: `src/server/server.ts`

After `autoFavoriteManagementScheduler.initialize()` (:396): `setTimeout(() => { void aircraftClassificationService.backfillAll().catch(e => logger.warn('Aircraft backfill failed:', e)); }, 120_000).unref?.();`

### 4.8 Types and DTOs

- `src/db/schema/nodes.ts`: 5 columns × 3 dialects (§2.1). Use `integer('likelyAircraft', { mode: 'boolean' })`, `pgBoolean`, `myBoolean`, `…Bigint('aircraftClassifiedAt', { mode: 'number' })`.
- `src/db/types.ts DbNode` :31 **and** `src/services/database.ts DbNode` :115: `likelyAircraft?: boolean | null; aircraftBasis?: string | null; groundElevation?: number | null; heightAboveGround?: number | null; aircraftClassifiedAt?: number | null;`
- `src/types/device.ts DeviceInfo`: `likelyAircraft?: boolean; aircraftBasis?: 'agl' | 'msl' | 'unknown'; groundElevation?: number; heightAboveGround?: number;`
- `dbNodeMapper.ts` **and** `nodeDbMaintenanceService.ts` `mapDbNodeToDeviceInfo`: copy each field when non-null (`likelyAircraft` via `Boolean`). Use flat top-level names so the unified Dashboard rows and `DeviceInfo` agree.
- `nodeCacheService.fromRepoNode`: add the 5 fields (`?? undefined`). While there, also add the missing `isUnmessagable`/`isLicensed` (one-line fix, mention it in the PR).
- `mergeNodesAcrossSources.ts`: inside `if (bestPosition) { … }`, copy `likelyAircraft`, `aircraftBasis`, `groundElevation`, `heightAboveGround` from `bestPosition` **unconditionally** (including null), so the empty-field backfill loop above cannot splice in another source's flag.

### 4.9 Data event: `src/server/services/dataEventEmitter.ts`

```ts
// DataEventType union: | 'node:aircraft'
export interface NodeAircraftData {
  nodeNum: number;
  previous: boolean | null;     // persisted flag before this update
  current: true;
  basis: 'agl' | 'msl';
  altitude: number;             // m MSL used
  groundElevation: number | null;
  heightAboveGround: number | null;
  thresholdM: number;           // the threshold that was crossed (AGL or MSL)
  latitude: number | null;
  longitude: number | null;
}
emitNodeAircraft(data: NodeAircraftData, sourceId?: string): void;  // type 'node:aircraft', debug log
```

The websocket forwards every `data` event (`webSocketService.ts` :190-229). The frontend does not listen for `node:aircraft`, so it is harmless there.

### 4.10 Automation trigger `trigger.becameLikelyAircraft`

| File | Change |
|------|--------|
| `src/types/automation.ts` | Add to the trigger union (:28-40) and the list (:79-90). No params → no validation case. |
| `automationEngineSingleton.ts` | `case 'node:aircraft': { const d = event.data as NodeAircraftData; await e.onBecameLikelyAircraft(d, sourceId); break; }` |
| `automationEngineService.ts` | `async onBecameLikelyAircraft(d: NodeAircraftData, sourceId: string \| null): Promise<number> { return this.runTrigger(buildBecameLikelyAircraftContext(d, sourceId, this.now())); }`. Doc comment: no self-origin guard, same reasoning as `onNodeRebooted` (no action can cause it, so no loop). |
| `triggerContext.ts` | `buildBecameLikelyAircraftContext(d, sourceId, timestamp): TriggerContext` → `triggerType`, `subjectNodeNum: Number(d.nodeNum)`, `fields: { nodeNum, altitude, heightAboveGround, groundElevation, basis, thresholdM, latitude, longitude, previousLikelyAircraft: d.previous, sourceId, timestamp }`. |
| `catalog.ts` | Entry after `trigger.becameMobile`: label "A node becomes a likely aircraft". Description: fires once when a node's reported altitude puts it more than the source's AGL threshold above the terrain (or above the MSL fallback when terrain elevation is unavailable); sends nothing; fires again only after the node drops back below the threshold; narrow with "Source is one of…". Fields `[COOLDOWN, COOLDOWN_SCOPE]`. Add to `SUBJECT_NODE_TRIGGERS` (:339) and the field-picker map (:381 pattern): nodeNum, altitude, heightAboveGround, groundElevation, basis, thresholdM. Example text in the :616 map (optional, e.g. "{{ node.longName }} is {{ trigger.heightAboveGround }} m above the ground, probably flying"). |
| `substitutionNodeTokens.ts` | Add to the node-token trigger list (:35-40). |
| `SubstitutionsHelp.tsx` | Token help (:49-54 pattern) + label (:64-67 pattern). |

### 4.11 Auto-Favorite: `src/server/services/favoritesService.ts`

**Exclusion is active** for a source when `aircraftDetectionEnabled !== 'false'` **and** `autoFavoriteExcludeAircraft !== 'false'` (both default on). Put this in one private helper `private async isAircraftExclusionActive(): Promise<boolean>` that reads both keys with `getSettingForSource(this.mgr.sourceId, …)`. The flag is already null when detection is off (D7), but reading both keys keeps the rule explicit and stops a stale flag from acting in the window before `reclassifySource` finishes.

**Add gate (`checkAutoFavorite`):** after `if (targetNode.favoriteLocked) return;`:
```ts
if (normalizeLikelyAircraft(targetNode.likelyAircraft) === true && await this.isAircraftExclusionActive()) {
  logger.debug(`⭐ Skipping auto-favorite for ${nodeId}: likely aircraft`);
  return;
}
```
There is **no instant removal path** (§11 Q6). A plane auto-added before its first classified position leaves via the two-strike sweep.

**Sweep (`autoFavoriteSweep`): the two-strike rule (D19).**

New pure helper, exported for unit tests (same file or `src/server/services/autoFavoriteAircraftStrikes.ts`):
```ts
export const AIRCRAFT_STRIKE_MIN_GAP_MS = 45 * 60_000;
export const AIRCRAFT_STRIKES_TO_REMOVE = 2;
export interface AircraftStrike { count: number; lastAt: number; }
export type AircraftStrikes = Record<string, AircraftStrike>;   // key = String(nodeNum)

/** Parse the stored JSON; garbage / non-object / bad entries → dropped (never throws). */
export function parseAircraftStrikes(raw: string | null | undefined): AircraftStrikes;

/**
 * One node's strike update for one sweep.
 *  - not flagged              → entry deleted                    (streak broken)
 *  - flagged, no entry        → { count: 1, lastAt: now }
 *  - flagged, now - lastAt >= MIN_GAP → { count: count + 1, lastAt: now }
 *  - flagged, gap too short   → unchanged (same sweep window: boot sweep, reconnect sweep, stacked interval)
 * Returns the new entry (or null when deleted) and whether it reached STRIKES_TO_REMOVE.
 */
export function applyAircraftStrike(prev: AircraftStrike | undefined, flagged: boolean, now: number):
  { next: AircraftStrike | null; remove: boolean };
```

Sweep changes, inside the existing `try`, after the disabled-feature branch:
1. `const exclusionActive = await this.isAircraftExclusionActive();` and `const strikes = parseAircraftStrikes(await getSettingForSource(sourceId, 'autoFavoriteAircraftStrikes'));`, plus a `strikesDirty` flag.
2. In the per-node loop, after the `favoriteLocked` `continue` and **before** the staleness check (so the log names the real reason):
   ```ts
   const flagged = exclusionActive && normalizeLikelyAircraft(node.likelyAircraft) === true;
   const { next, remove } = applyAircraftStrike(strikes[String(nodeNum)], flagged, Date.now());
   // update/delete strikes[key] from `next`; set strikesDirty when it changed
   if (remove) { shouldRemove = true; reason = `likely aircraft at ${AIRCRAFT_STRIKES_TO_REMOVE} consecutive sweeps (${summary})`; }
   ```
   `summary` = "`N m above ground`" (agl) or "`N m MSL`" (msl). Removal goes through the existing `shouldRemove` block, so only nodes in the `autoFavoriteNodes` provenance list are ever touched, and `favoriteLocked` nodes are skipped **before** a strike is recorded.
3. After the loop: delete strike entries for every removed node and for any key not in the **remaining** provenance list (pruning). If `strikesDirty`, write back with `setSourceSetting(sourceId, 'autoFavoriteAircraftStrikes', JSON.stringify(strikes))`. Write only when changed.
4. Disabled-feature branch (`autoFavoriteEnabled !== 'true'`): also write `'{}'` for strikes, alongside the existing `autoFavoriteNodes = '[]'`.
5. **Exclusion switched off (or detection off):** `flagged` is false for every node, so step 2 deletes every entry at the next sweep. Turning the exclusion back on starts the count fresh (two new sweeps). That is an explicit "stop", not a reset by an unrelated save.

Guarantees (each gets a test in §6):
- A strike survives a restart, because it is stored in the settings table and not in an instance field.
- A settings save cannot reset it. The key is POST-dropped (not in `VALID_SETTINGS_KEYS`), `reclassifySource` never touches it, and no route writes it.
- A boot or reconnect sweep within 45 min of the last counted sweep does not add a strike.
- Clearing the flag between sweeps resets the streak.
- There is no upper bound on the gap. A node flagged at the last sweep before a 3-day outage and at the first sweep after it counts as two strikes. Both observations are real sweeps, and the user asked for "consecutive sweeps", not a time window.

`autoFavoriteSweep` already guards re-entry with `autoFavoriteSweepRunning`, so two stacked intervals cannot race on the strikes JSON within one process.

### 4.12 Remote auto-favorite: `autoFavoriteManagementService.ts`

The remote-favorites feature uses the **same per-source exclusion rule** (detection on **and** `autoFavoriteExcludeAircraft` on for `target.sourceId`). Read both once per cycle. It adds candidates only; it never removes remote favourites, so the two-strike rule does not apply. In the 3a loop (:363-367), which already fetches `node` per candidate: `if (exclusionActive && normalizeLikelyAircraft(node?.likelyAircraft) === true) aircraft.add(c);`. Then pass `excluded: new Set([targetNodeNum, ...aircraft])`. Unit test: `selectNewFavorites` already honours `excluded`, so add a `runCycleForTarget`-level test (or extract the exclusion builder as `buildExcludedSet(targetNodeNum, nodesByNum)` and test that). This reduces remote admin airtime.

### 4.13 Map preference: server

- `src/db/schema/misc.ts`: `aircraftDisplayMode: text('aircraft_display_mode')` / `pgText(...)` / `myVarchar('aircraft_display_mode', { length: 8 })` in all three `user_map_preferences` tables.
- `src/db/repositories/mapPreferences.ts`: read `aircraftDisplayMode: row.aircraftDisplayMode ?? null` (:54 pattern), type (:86), update `set` (:118), insert default null (:147).
- `src/services/database.ts` :5457 type: `aircraftDisplayMode?: 'show' | 'mark' | 'hide' | null`.
- `userPreferencesRoutes.ts`: destructure. Validate `aircraftDisplayMode === undefined || aircraftDisplayMode === null || isAircraftDisplayMode(aircraftDisplayMode)`, else `fail(res, 400, 'INVALID_PREFERENCE', 'aircraftDisplayMode must be show, mark, or hide')`. Pass it through to save.

---

## 5. Frontend design

### 5.1 Icon

- `UiIcon.tsx`: `import { Plane } from 'lucide-react'`; `aircraft: { lucide: Plane, emoji: '✈️', usage: 'likely-aircraft nodes' }`.
- `src/utils/roleGlyphSvg.ts`: `export function aircraftBadgeSvg(size: number): string`. It draws a white disc (like `unmessageableBadgeSvg`), then the Lucide Plane path `M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z` stroked (`fill="none" stroke="#1f6feb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`, scaled into the 24-box with `transform="translate(3 3) scale(0.75)"`). Comment the Lucide source + ISC licence, as the Ban badge does. Re-export from `markerIcons.ts` (:17).

### 5.2 `createNodeIcon` (`src/components/map/markerIcons.ts`)

- Option: `/** Overlay a "likely aircraft" badge (#5365). Meshtastic variant only. */ isLikelyAircraft?: boolean;`
- Badge placed **top-left** (`top:-2px; left:-2px`), the same size as the unmessageable badge (`round(size*0.4)`), `pointer-events:none`. It sits clear of the top-right unmessageable badge and the bottom-right official role badge. Inject it next to `unmessageableBadge` in **both** the `official` and `meshmonitor` pin branches. The MeshCore variant ignores it.
- When `isLikelyAircraft` is false the output must be byte-identical (existing snapshot/markup tests in `markerIcons.test.ts` must pass unchanged).

### 5.3 Shared control: `src/components/map/MapAircraftDisplayControl.tsx` + `.module.css` (NEW)

```tsx
interface MapAircraftDisplayControlProps {
  mode: AircraftDisplayMode;
  onChange: (mode: AircraftDisplayMode) => void;
  /** Count of likely-aircraft nodes in the current (pre-hide) set, for the hint line. */
  aircraftCount?: number;
}
```
It renders a `map-control-item` with the title `<UiIcon name="aircraft" /> Likely aircraft`, then a `role="radiogroup"` of three `<label><input type="radio" name=… /></label>` options (Show / Mark / Hide). A hint line reads "Flagged when a node is more than the source's threshold above the terrain." If `aircraftCount != null`, it adds "{{count}} on the map." It has a `data-testid="map-aircraft-mode"`. Styling uses the CSS module and `var(--color-*)` with **no fallbacks** (map sidebar epic rule). No emoji.

### 5.4 `MapContext.tsx`

- Type: `aircraftDisplayMode: AircraftDisplayMode; setAircraftDisplayMode: (m: AircraftDisplayMode) => void;`
- Initial state: `localStorage.getItem('aircraftDisplayMode')` validated by `isAircraftDisplayMode`, else `'mark'` (inside try/catch).
- Setter (pattern :249 + :286): set the state, mirror to `localStorage` (try/catch), and `void savePreferenceToServer({ aircraftDisplayMode: m })`. Add the same `eslint-disable-next-line react-hooks/exhaustive-deps -- #5365 …` comment the sibling setters carry, so the ratchet count does not grow.
- Loader (pattern :401): `if (isAircraftDisplayMode(preferences.aircraftDisplayMode)) setAircraftDisplayModeState(preferences.aircraftDisplayMode);`

### 5.5 NodesTab (`src/components/NodesTab.tsx`)

- Read `aircraftDisplayMode, setAircraftDisplayMode` from the map context (near `spreadNodes` :571).
- `visibleMapNodes` filter (:1785): `if (aircraftDisplayMode === 'hide' && node.likelyAircraft === true && !node.isFavorite) return false;` Place it after the transport checks. This feeds 3D too.
- Marker descriptor (:1893): `const markAircraft = aircraftDisplayMode !== 'show' && node.likelyAircraft === true;`. Append `-${markAircraft ? 1 : 0}` to `iconSig` and pass `isLikelyAircraft: markAircraft`.
- Map Features panel: render `<MapAircraftDisplayControl mode={aircraftDisplayMode} onChange={setAircraftDisplayMode} aircraftCount={…} />` directly **after** `<MapAgeFilterControl … />` (:2885). The count is `nodesWithPosition.filter(n => n.likelyAircraft === true).length`, memoised.
- Optional, cheap: node-list row badge next to `NodeUnmessageableBadge` (:2651): `{node.likelyAircraft && <UiIcon name="aircraft" size={12} title={t('nodes.likely_aircraft','Likely aircraft')} />}`.

### 5.6 DashboardMap (`src/components/Dashboard/DashboardMap.tsx`)

- Read the mode from `useMapContext()` (:318).
- In the `useMemo` (:372) chain after `.filter((n) => !n.hideFromMap)`: `.filter((n) => !(aircraftDisplayMode === 'hide' && n.likelyAircraft === true && !n.isFavorite))`. **Add `aircraftDisplayMode` to that memo's deps** (:415).
- Marker (:707): the same `markAircraft`, appended to `iconSig` (`|${markAircraft ? 1 : 0}`) and passed to `createNodeIcon`.
- Panel: `<MapAircraftDisplayControl …/>` right after `<MapAgeFilterControl …/>` (:990).

### 5.7 Unified dashboard merge (`src/hooks/useDashboardData.ts mergeNodeRecords`)

Inside `if (withPosition) { … }` (:371): copy `altitude`, `likelyAircraft`, `aircraftBasis`, `groundElevation`, `heightAboveGround` from `withPosition` (assign even when null). This is the client twin of §4.8's server merge.

### 5.8 Map Analysis

- `useAnalysisNodes.ts`: add `likelyAircraft?: boolean | null` to `NodeRecord` (:31 pattern). Read `const aircraftMode = useMapContextOptional()?.aircraftDisplayMode ?? 'mark';` (the :78 pattern), apply the Hide filter (favourites bypass), and add it to the memo deps (:165).
- `layers/NodeMarkersLayer.tsx`: `iconSig` (:123) + `isLikelyAircraft` (:151), using the same mode read.

Map Analysis has no Map Features panel. It follows the mode chosen on the other two maps, as `spreadNodes` does. This avoids the "shipped to one surface" bug (memory: #5177).

### 5.9 Popups and details

- `nodeCardModel.ts`: add `likelyAircraft: boolean`, `aircraftBasis`, `heightAboveGround` to the model and build them from flat fields.
- `sections.tsx SignalItems`: when `showAltitude && model.likelyAircraft`, add an item after the altitude row: `<UiIcon name="aircraft" /> {formatAircraftSummary(model, t)}`.
- `src/utils/aircraftClassification.ts` gains `export function formatAircraftSummary(m: { aircraftBasis?: string|null; heightAboveGround?: number|null; altitude?: number|null }, t: TFunction): string`. Output: AGL → "Likely aircraft · 1.2 km above ground" (below 1000 m: "850 m above ground"); MSL → "Likely aircraft · 6.1 km above sea level". Keep it metric, matching the altitude row beside it. i18n keys `node_popup.aircraft_agl` and `node_popup.aircraft_msl` with `{{height}}`.
- `NodeDetailsBlock.tsx` (:576): the same line under the altitude row.

### 5.10 Detection settings: Settings → Node Display (`src/components/SettingsTab.tsx`)

The keys follow the Node Display per-source pattern exactly (#4412 Phase 3). There is **no new section component**.

- **`SettingsDraft`** (~:88-165): add `aircraftDetectionEnabled: boolean; aircraftAglThresholdMeters: number; aircraftMslThresholdMeters: number;`, plus the matching entries in the initial draft object (~:465 block: `true`, `500`, `5000`).
- **Initial state:** `const [initialAircraftDetectionEnabled, …] = useState(true)`, `…Agl… = useState(500)`, `…Msl… = useState(5000)` (the ~:509 `initialCotFeed*` pattern).
- **Server load** (~:558-700, the block fetched with `sourceQuery`): parse with `parseAircraftSettings({ enabled: settings.aircraftDetectionEnabled, aglThresholdM: settings.aircraftAglThresholdMeters, mslThresholdM: settings.aircraftMslThresholdMeters })`, then `updateField(...)` + `setInitial…(...)` for each (the `elevationEnabled` ~:672 pattern). Absent keys (unset source) → defaults. The GET back-fill never supplies a global value (§4.5).
- **`buildBaseline`** (~:780-808): add the three `initial…` values and add them to its dependency list (it is a `useMemo`/`useCallback` over the `initial*` state; this is the one dep array you touch, the same as every `initial*` sibling).
- **`handleSave`'s `const settings = {…}` literal** (~:1040-1080): add
  ```ts
  aircraftDetectionEnabled: draft.aircraftDetectionEnabled ? 'true' : 'false',
  aircraftAglThresholdMeters: String(draft.aircraftAglThresholdMeters),
  aircraftMslThresholdMeters: String(draft.aircraftMslThresholdMeters),
  ```
  The existing partition (:1084-1112) routes them to the scoped `?sourceId=` POST because they are in `NODE_DISPLAY_SETTING_KEYS`. **Do not add a second literal or a special case.** `server.settings-persistence.test.ts` source-extracts this literal and runs the partition.
- **`applyDraft` / post-save** (~:993 `setInitialElevationEnabled(d.elevationEnabled)` pattern): set the three `initial…` values from the saved draft.
- **Client validation:** before save, if a threshold is not an integer inside `AIRCRAFT_AGL_RANGE` / `AIRCRAFT_MSL_RANGE`, show the inline error and block the save (the server also returns 400).
- **UI** inside `#settings-node-display` (~:2228), after the existing Node Display items, under a sub-heading `<h4><UiIcon name="aircraft" /> {t('settings.aircraft.title', 'Likely aircraft')}</h4>`:
  - Checkbox "Detect likely aircraft" (`updateField('aircraftDetectionEnabled', …)`).
  - Number "Height above ground threshold (m)" (min 50, max 20000, step 10), disabled when detection is off.
  - Number "Fallback: altitude above sea level (m)" (min 500, max 20000, step 100), disabled when detection is off.
  - Help text: "A node is flagged when its reported altitude is more than this height above the terrain at its position. When terrain data is unavailable, only the sea-level fallback applies." When `useElevationEnabled()` is false, add a warning line: "Terrain elevation is off (Global Settings → Elevation): only the sea-level fallback is used."
  - Help text: "Flagged nodes get an aircraft badge on the map and can be hidden in Map Features. Auto-Favorite exclusion is set in Automation → Auto Favorite."
- **Search:** add `'aircraft', 'plane', 'altitude', 'AGL', 'balloon', 'drone'` to the `settings-node-display` keywords in `src/components/search/configSections.ts` :129.
- **MeshCore:** do **not** touch `MeshCoreNodeDisplaySection.tsx` (Meshtastic-only, D2). `SettingsTab` never mounts under a MeshCore route.

### 5.11 Auto-Favorite exclusion switch (`src/components/AutoFavoriteSection.tsx`)

- State: `localExcludeAircraft` (default `true`), part of `initialSettings` and the `hasChanges` comparison (the existing :39-75 pattern). Also read `detectionEnabled = settings.aircraftDetectionEnabled !== 'false'` from the same `GET /api/settings${sourceQuery}` response (:48). Read-only here.
- Save (:79-90): add `autoFavoriteExcludeAircraft: localExcludeAircraft ? 'true' : 'false'` to the POST body. That body already goes to `?sourceId=`.
- UI: a checkbox next to the stale-hours input: "Exclude likely aircraft". Help text: "Likely aircraft are never auto-favorited. An auto-favorite that is flagged at two hourly sweeps in a row is removed. Your own and locked favorites are never touched."
  - When `detectionEnabled` is false: render the checkbox **disabled** (value kept), greyed out via the section's existing disabled styling, with: "Needs aircraft detection, which is off for this source (Settings → Node Display)." The text links to `#settings-node-display` using the same navigation style the section already uses for its links.
- The checkbox is independent of the Auto-Favorite enable toggle's disabled state only as far as the existing section already greys its sub-controls when Auto-Favorite is off. Follow that existing behaviour.

---

## 6. Test plan

All route tests use `createRouteTestApp` (`src/server/test-helpers/routeTestApp.ts`). Multi-backend suites use `createIsolatedPostgresDatabase` / `createIsolatedMysqlDatabase`. Run the PG/MySQL containers (CLAUDE.md) and confirm via the JSON reporter that nothing skipped.

| File | Cases |
|------|-------|
| `src/utils/aircraftClassification.test.ts` (NEW) | **Mountaintop:** alt 4300, ground 4250, T=500 → `false`, basis `agl`, hag 50. **3000 m AGL:** alt 3200, ground 200 → `true`, hag 3000. **Elevation null, above MSL:** alt 6000, ground null → `true`, basis `msl`, hag null. **Elevation null, below MSL:** alt 4300, ground null → `false`, `msl`. **Altitude missing:** null/undefined/NaN → `null`, `unknown`. Exact threshold (hag 500) → `false`. Negative hag → `false`. Hysteresis: prev true/agl, hag 460 → true; hag 440 → false; prev true/**msl** with agl hag 460 → false (basis change). MSL hysteresis at 5000 (H=500): 4600 stays, 4400 clears. `parseAircraftSettings`: nulls → defaults, `'abc'` → default, 10 → clamped 50, 99999 → 20000, `'false'` → disabled. `isAircraftTransition`: null→true ✓, false→true ✓, true→true ✗, true→false ✗, null→null ✗. `normalizeLikelyAircraft` for 0/1/true/false/null. `formatAircraftSummary` for both bases and the sub-km case. |
| `src/server/services/aircraftClassificationService.test.ts` (NEW, injected deps, fake timers) | Coalescing: 5 × `schedule` same key → 1 `getNode`. One batch in flight: the second `schedule` during a pending sample waits. Batch of 150 → 2 `sample` calls (100 + 50). Ground memo: same coords twice → 1 `sample`. Moved → 2. `elevationEnabled='false'` → 0 `sample`, basis `msl`. `sample` rejects / all-null / never resolves (15 s timeout) → basis `msl` + backoff: the next job within 10 min does not call `sample`, after 10 min it does. `schedule` never throws, even when `getNode` throws. Write-if-changed: identical classification → no write (except when `classifiedAt` is null). Event: `'position'` null→true emits once; true→true none; `'backfill'` null→true none. Override position is used (D17). Bogus lat/lon → no sample, `msl`. Disabled source → skipped, `clearClassification` called. `reclassifySource`: threshold 500→3000 flips a hag-1000 row to false with **no** `sample` call and **no** emit; disabled → `clearClassification`. `backfillAll`: skips meshcore/reticulum/disabled, enqueues only unclassified ids, emits nothing. |
| `src/db/repositories/nodes.aircraft.multiBackend.test.ts` (NEW; SQLite + isolated PG + isolated MySQL) | `setAircraftClassification` round-trips all 5 fields (boolean true/false/null, BIGINT ms). `upsertNode` on the same row does **not** clobber them (insert-conflict path). `getUnclassifiedNodeNumsWithAltitude` / `getAircraftReclassifyRows` / `clearAircraftClassification` (keeps `groundElevation`). |
| `src/db/repositories/nodes.aircraft.perSource.test.ts` (NEW) | Same `nodeNum` in sources A and B: a write to A leaves B null; `clearAircraftClassification(A)` leaves B; `getUnclassified…(A)` excludes B's rows. |
| `nodes.test.ts`, `nodes.transportHeard.multiBackend.test.ts`, `nodes.transportStampInsert.multiBackend.test.ts` | Add the 5 columns to every hand-written PG/MySQL `CREATE TABLE nodes`. No new cases. |
| `src/server/migrations/175_*.test.ts` / `175_*.pgmysql.test.ts`, `176_*.test.ts` / `176_*.pgmysql.test.ts` (NEW) | Columns exist with the right types; running twice is a no-op. |
| `src/server/utils/mergeNodesAcrossSources.test.ts` (extend) | The flag follows the `bestPosition` row, not the newest-`lastHeard` row; a null flag on the position row is not back-filled from another row. |
| `src/server/utils/dbNodeMapper.test.ts` + `nodeDbMaintenanceService` mapper test (extend or add) | The fields map; SQLite `1` → `true`. |
| `src/server/services/autoFavoriteAircraftStrikes.test.ts` (NEW, pure) | `parseAircraftStrikes`: null/`''`/`'[]'`/garbage/bad entries → `{}`, a valid object round-trips. `applyAircraftStrike`: no entry + flagged → count 1; count 1 + flagged + gap 45 min → count 2, `remove: true`; count 1 + flagged + gap 44 min 59 s → unchanged, `remove: false`; any entry + not flagged → `next: null`; gap of 3 days → still counts. |
| `src/server/services/favoritesService.test.ts` (extend; use `vi.setSystemTime`) | **Add gate:** flagged target + exclusion active → not favourited, `sendFavoriteNode` not called; flagged + `autoFavoriteExcludeAircraft='false'` → favourited; flagged + `aircraftDetectionEnabled='false'` → favourited; non-flagged → favourited. **Two-strike sweep:** (a) flagged once → **kept**, strikes `{n:{count:1}}` persisted. (b) flagged at T and T+60 min → **removed** at the second sweep, `sendRemoveFavoriteNode` called, list and strikes entry cleared, reason names the aircraft. (c) flagged at T, flag cleared at T+60, flagged at T+120 → kept at T+120 (count back to 1). (d) **Restart in between:** sweep at T on service instance A, build a fresh `FavoritesService` (new instance, same DB/settings) and sweep at T+60 → removed (the strike came from the settings table). (e) **Settings save in between:** at T+30 POST (via the harness or `setSourceSettings`) new thresholds, `autoFavoriteExcludeAircraft='true'`, and a body containing `autoFavoriteAircraftStrikes: '{}'` → the strikes value is unchanged (POST drops it), and the T+60 sweep removes. (f) Boot sweep at T+1 min after a sweep at T → no second strike, kept. (g) `favoriteLocked` flagged node → never struck, never removed. (h) A user favourite **not in `autoFavoriteNodes`** with the flag → untouched, never struck. (i) Exclusion switched off → the next sweep deletes all strikes; switched on again → two fresh sweeps needed. (j) Auto-Favorite disabled → strikes reset to `'{}'` with the list. (k) Strike keys for nodes that left the provenance list are pruned. |
| `src/server/meshtasticManager.autoFavorite.perSource.test.ts` (extend) | Aircraft in source A does not affect source B's auto-favorite of the same `nodeNum`. |
| `src/server/services/autoFavoriteManagementService.test.ts` (extend) | An aircraft candidate is excluded from new favourites when the exclusion is active; it is eligible when `autoFavoriteExcludeAircraft='false'` or detection is off. |
| `src/server/routes/settingsRoutes.aircraft.test.ts` (NEW, harness) | `?sourceId=A` POST valid detection keys → 200, stored per source, `reclassifySource('A')` called (spy); AGL 10 → 400 `INVALID_AIRCRAFT_AGL_THRESHOLD`; MSL 'x' → 400; `aircraftDetectionEnabled: 'yes'` / `autoFavoriteExcludeAircraft: 'yes'` → 400 `INVALID_BOOLEAN_SETTING`; `autoFavoriteExcludeAircraft` alone → no `reclassifySource` call; `autoFavoriteAircraftStrikes` in the body is dropped (stored value unchanged); source A save does not change source B. **GET back-fill:** with a legacy *global* `aircraftAglThresholdMeters='900'` row and no per-source row, `GET ?sourceId=A` omits the key (so the UI shows the default 500), which proves the `NODE_DISPLAY_SETTING_KEYS` exclusion covers it. |
| `src/server/constants/settings.allowlist.test.ts` (update) | The "every per-source key is POST-able or exempt" equality now includes `autoFavoriteAircraftStrikes` in `PER_SOURCE_KEYS_NOT_POSTABLE`. The two "all ten Node Display keys" tests (:98, :113) iterate `NODE_DISPLAY_SETTING_KEYS` (now 13) for the postable checks; the "exactly ten" count moves to `NODE_DISPLAY_SEEDED_KEYS`, and a new assertion checks `NODE_DISPLAY_SETTING_KEYS` equals `[...NODE_DISPLAY_SEEDED_KEYS, ...AIRCRAFT_NODE_DISPLAY_KEYS]`. |
| `src/constants/nodeDisplayDefaults.test.ts` (update) | "has exactly ten entries" → on `NODE_DISPLAY_SEEDED_KEYS`. The seed deep-equal is unchanged (`NODE_DISPLAY_DEFAULT_STRINGS` is now keyed by the seeded set). New: `NODE_DISPLAY_SETTING_KEYS` = seeded + the three aircraft keys, no duplicates, all in `PER_SOURCE_SETTINGS_KEYS` and `VALID_SETTINGS_KEYS`; the aircraft keys are **not** in migration 131's seed. |
| `src/server/server.settings-persistence.test.ts` (update) | The extracted `const settings` literal now contains the three aircraft keys, and they must be in `VALID_SETTINGS_KEYS` (automatic). The partition assertion ("routes exactly `NODE_DISPLAY_SETTING_KEYS`") must pass with the 13-key set. Update the fixture and any "ten" wording/counts it hard-codes. |
| `src/components/SettingsTab.nodeDisplay.perSource.test.tsx` (update + extend) | :304 "scoped POST carries exactly the ten" → exactly `NODE_DISPLAY_SETTING_KEYS` (13, by name). :343 global-mode case still includes them. New: loading source A with `aircraftAglThresholdMeters='800'` shows 800; an unset source shows 500/5000/checked; editing the threshold and saving sends it on the **scoped** POST only; out-of-range input blocks save; the elevation-off warning shows when `useElevationEnabled` is false; the aircraft block does not render any control when mounted outside `#settings-node-display`. |
| `src/utils/nodeDisplayStorage.test.ts` (check) | Purge still removes the ten legacy bare keys; the aircraft names in the loop are harmless. Update a hard-coded count if one exists. |
| `src/components/AutoFavoriteSection.test.tsx` (extend) | The switch loads from `autoFavoriteExcludeAircraft` (default checked when absent); toggling marks the section dirty and POSTs it with `?sourceId`; with `aircraftDetectionEnabled='false'` the switch is disabled and the "needs aircraft detection" text links to `#settings-node-display`. |
| `src/server/routes/userPreferencesRoutes.test.ts` (extend; convert to the harness if touched heavily) | `aircraftDisplayMode: 'hide'` saved + returned; `'bogus'` → 400 `INVALID_PREFERENCE`; missing → unchanged. |
| `src/server/mqttIngestion` test (extend the existing POSITION test) | A valid fix with altitude calls `schedule(sourceId, fromNum)` after the upsert resolves; a bogus fix does not. |
| `src/server/services/automation/becameLikelyAircraft.test.ts` (NEW, model `nodeRebooted.test.ts`) | A `node:aircraft` event fires a rule with `trigger.becameLikelyAircraft`; the tokens `{{ trigger.heightAboveGround }}`, `{{ trigger.basis }}`, `{{ trigger.altitude }}` interpolate; `{{ node.longName }}` hydrates; cooldown blocks a second fire inside the window; a source-filter condition blocks another source. |
| `src/types/automation.test.ts`, `catalog.showIf.test.ts`, `tokenHints.test.ts` | Update only where they enumerate every trigger. |
| `src/components/map/markerIcons.test.ts` (extend) | `isLikelyAircraft: true` adds the badge in both pin styles; `false` output equals today's (byte-identical); the meshcore variant ignores it. |
| `src/components/map/MapAircraftDisplayControl.test.tsx` (NEW) | Renders 3 radios, checks the current one, calls `onChange`, shows the count; no emoji in the text. |
| `src/components/NodesTab.test.tsx` (extend) | The control is in the Map Features panel; Hide removes a flagged non-favourite marker but keeps a flagged favourite; Mark passes `isLikelyAircraft`. |
| `src/components/Dashboard/DashboardMap.test.tsx` (extend) | Same three assertions on the Dashboard panel. |
| `src/components/map/mapPinColorMode.wiring.test.ts` pattern → new `mapAircraftMode.wiring.test.ts` | Source-grep guard: both panels render `MapAircraftDisplayControl`, and all three `createNodeIcon` call sites pass `isLikelyAircraft` and include it in `iconSig` (this catches the one-surface regression). |
| `src/hooks/useDashboardData.test.ts` (extend) | Unified merge carries `altitude` + aircraft fields from the position record. |
| `src/components/map/popups/*.test.tsx` (extend) | The aircraft row renders for AGL and MSL bases; hidden when not flagged. |
| `src/contexts/MapContext` test (extend if present) | Server pref wins over localStorage; invalid value ignored. |

**Browser validation (P1 exit criterion):** deploy with `docker-compose.dev.yml` + `docker-compose.dev.local.yml` (memory: dev deploy includes USB override) and log in as admin/changeme. Force a flagged node by setting a node row's `altitude` high and calling the reclassify path via a settings save. Then verify in **both** NodesTab and Dashboard: badge visible (Mark), gone (Show), marker removed (Hide), favourite kept in Hide; popup line; choice persists across a reload. Also check Settings → Node Display (the aircraft block saves per source; switch sources and confirm the values differ), and Automation → Auto Favorite (the "Exclude likely aircraft" switch greys out with the explanation after detection is turned off for that source). Use real mouse clicks (memory: synthetic `dispatchEvent` bypasses hit-testing). Attach a screenshot to the PR (memory: UI PRs need one).

---

## 7. Mesh impact checklist

**1. Airtime:** the feature sends **no mesh packets**. Classification is local maths plus outbound HTTPS tile fetches (not LoRa). The Auto-Favorite sweep's removal sends `set/remove_favorite_node` to the **local** node over TCP (`sendRemoveFavoriteNode` defaults `destNode` to the local node, `favoritesService.ts:171-173`). That is not airtime, and the sweep already does it for other reasons. The remote-favorites exclusion (§4.12) *reduces* airtime, because fewer remote admin packets go to aircraft.

**Outbound HTTP (not mesh, but quantified):** a z12 Terrarium tile covers about 9.8 km × 9.8 km·cos(lat) and weighs roughly 50–150 KB. Fixed nodes: one fetch per node per process lifetime at most (ground memo), and usually zero, because neighbours share a tile and the 64-tile LRU is warm. Moving aircraft: at most one fetch per position packet (default broadcast 15 min, smart-position faster), in batches of ≤100 points with ≤1 batch in flight. Offline or failing provider: one attempt per 10 min (backoff). The one-time backfill costs one sample per unclassified node, grouped by tile, once ever. Setting `elevationEnabled=false` stops all fetches.

**2. Spam:** the direct path is none. The indirect path is `trigger.becameLikelyAircraft`:
- It fires only on a transition into the flagged state (`previous !== true`), read from the **persisted** row, so a restart does not re-fire.
- Hysteresis (D8) stops threshold flapping.
- Backfill and settings recomputes are silent (D9), so a threshold change cannot burst events.
- **No `node:updated` emit** (D10), so `trigger.nodeUpdated` and `nodeOnline` recovery alerts cannot fire from classifier writes.
- Feedback loop: no automation action can change a node's reported altitude, so none exists. No self-origin guard is needed (same reasoning as `onNodeRebooted`).
- Rate: bounded by the existing per-automation `cooldownSeconds` / `cooldownScope` / `rateLimit`. The epic decided this (see "Mesh impact" in the plan). A wide MQTT feed can see many aircraft, so the catalog description tells users to narrow by source.
- No new notification path. Apprise/desktop/MQTT publish only fire through automations the user builds.

**3. Does a save reset a safety timer?** P1 adds no scheduled sends and no cooldown of its own.
- The provider backoff lives in memory by design: losing it on restart only costs one extra HTTP attempt and cannot touch the mesh.
- The Auto-Favorite sweep keeps its existing hourly interval, and saving aircraft settings does not restart it.
- **The two-strike state is a safety counter, so it is persisted** (`autoFavoriteAircraftStrikes`, per source, in the settings table). A restart keeps it. A settings save cannot write it (POST drops the key) and `reclassifySource` never touches it. "Consecutive" is measured by stored timestamps (≥ 45 min between counted sweeps), so the boot sweep 55 s after a restart or reconnect cannot count as the second strike. The reverse failure is covered too: nothing but a sweep that sees the flag cleared, or an explicit exclusion/detection/Auto-Favorite switch-off, resets a streak.
- The flag that gates the automation event is persisted, so neither a save nor a restart re-arms it.
- A save runs a silent recompute. That can *clear* flags (for example when the threshold is raised), and a later genuine re-crossing then fires once. That is the intended semantics, not a re-armed timer.

No new limit needs a user decision. The event reuses the per-automation limits the epic already chose.

---

## 8. Work packages

File ownership is exclusive within a wave. Every WP runs `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` (must be empty) and its own tests before handing back. WP2–WP5 code against the §4.3/§4.9 contracts that WP1 lands. WP4 and WP5 both edit frontend files but share none.

### Wave 1

**WP1: Data layer and contracts** (blocks everything)
Owns: `src/server/migrations/175_*`, `176_*` (+ tests), `src/db/migrations.ts`, `src/db/schema/nodes.ts`, `src/db/schema/misc.ts`, `src/db/types.ts`, `src/services/database.ts` (DbNode + map-prefs type only), `src/types/device.ts`, `src/db/repositories/nodes.ts`, `src/db/repositories/mapPreferences.ts`, the three hand-written-DDL test files, new `nodes.aircraft.multiBackend.test.ts` + `nodes.aircraft.perSource.test.ts`, `src/server/services/nodeCacheService.ts`, `src/server/utils/dbNodeMapper.ts`, `src/server/services/nodeDbMaintenanceService.ts`, `src/server/utils/mergeNodesAcrossSources.ts` (+ test), `src/server/services/dataEventEmitter.ts`, `src/server/constants/settings.ts` (all five keys per §4.6, including `autoFavoriteAircraftStrikes` in `PER_SOURCE_KEYS_NOT_POSTABLE`) + `settings.allowlist.test.ts` (the not-postable equality only; the Node Display assertions belong to WP5), `src/server/routes/userPreferencesRoutes.ts` (+ test), `src/utils/aircraftClassification.ts` (+ test; classifier, constants, `formatAircraftSummary`).
**WP1 does not touch `src/constants/nodeDisplayDefaults.ts`.** Changing `NODE_DISPLAY_SETTING_KEYS` before `SettingsTab`'s literal carries the new keys would break the partition test in `server.settings-persistence.test.ts`, so that change lands atomically in WP5.
Acceptance: migrations are idempotent on SQLite/PG/MySQL (containers up, nothing skipped); the repo round-trips and isolates per source; the allowlist test passes; the classifier suite covers every §6 case; `upsertNode` does not clobber the new columns.

### Wave 2 (parallel after WP1)

**WP2: Classification pipeline** (server)
Owns: `src/server/services/aircraftClassificationService.ts` (+ test), `src/server/meshtasticManager.ts` (two `schedule` lines only), `src/server/mqttIngestion.ts` (+ test edit), `src/server/routes/settingsRoutes.ts` (validation for all four POST-able keys + the reclassify hook) + new `settingsRoutes.aircraft.test.ts` (every §6 case **except** the GET back-fill case, which WP5 adds once the keys join `NODE_DISPLAY_SETTING_KEYS`), `src/server/server.ts` (backfill timer).
Acceptance: all service tests pass; RX paths only gain a synchronous `schedule` call; the settings save triggers a silent recompute; the backfill is silent and skips MeshCore/Reticulum; the 15 s timeout and 10 min backoff are proven with fake timers.

**WP3: Auto-Favorite exclusion and automation trigger**
Owns: `src/server/services/favoritesService.ts` (+ test; exclusion helper, add gate, two-strike sweep), new `src/server/services/autoFavoriteAircraftStrikes.ts` (+ test) if the pure helper is split out, `src/server/meshtasticManager.autoFavorite.perSource.test.ts`, `src/server/services/autoFavoriteManagementService.ts` (+ test), `src/types/automation.ts` (+ test), `src/server/services/automation/automationEngineSingleton.ts`, `automationEngineService.ts`, `triggerContext.ts`, new `becameLikelyAircraft.test.ts`, `src/components/automations/catalog.ts`, `substitutionNodeTokens.ts`, `SubstitutionsHelp.tsx` (+ any enumerating tests).
Acceptance: gate tests (both switches); the two-strike cases (a)–(k) in §6, including the restart case (fresh service instance) and the settings-save case; locked and user-favourite safety; per-source isolation (strikes in A never affect B); trigger fires once with tokens and honours cooldown/source filter; the catalog shows the trigger in the editor.

**WP4: Map UI**
Owns: `src/components/icons/UiIcon.tsx`, `src/utils/roleGlyphSvg.ts`, `src/components/map/markerIcons.ts` (+ test), new `MapAircraftDisplayControl.tsx/.module.css/.test.tsx`, new `mapAircraftMode.wiring.test.ts`, `src/contexts/MapContext.tsx`, `src/components/NodesTab.tsx` (+ test), `src/components/Dashboard/DashboardMap.tsx` (+ test), `src/hooks/useDashboardData.ts` (+ test), `src/components/MapAnalysis/useAnalysisNodes.ts`, `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx`, `src/components/map/popups/nodeCardModel.ts`, `sections.tsx` (+ tests), `src/components/NodeDetailsBlock.tsx`, `public/locales/en.json` (WP4's own keys only during Wave 2).
Acceptance: the §6 component and wiring tests pass; byte-identical markers when unflagged; mode persists (server + localStorage); the 3D view honours Hide via `visibleMapNodes`.

**WP5: Settings UI (Node Display + Auto-Favorite switch)**
Owns: `src/constants/nodeDisplayDefaults.ts` (the §4.6 seeded/routed split) + `nodeDisplayDefaults.test.ts`, the Node Display assertions in `src/server/constants/settings.allowlist.test.ts` (WP1's edits there are merged first), `src/components/SettingsTab.tsx` (§5.10), `src/components/SettingsTab.nodeDisplay.perSource.test.tsx`, `src/server/server.settings-persistence.test.ts`, `src/utils/nodeDisplayStorage.test.ts` (only if a count needs updating), `src/components/search/configSections.ts`, `src/components/AutoFavoriteSection.tsx` (+ test, §5.11), and the GET back-fill case appended to `settingsRoutes.aircraft.test.ts` (a test-only edit; WP2 owns the route file itself). It does **not** edit `public/locales/en.json`. It uses `t(key, defaultValue)` and lists its new keys in the hand-back for WP6.
Acceptance: `NODE_DISPLAY_SETTING_KEYS` change and the `SettingsTab` literal land in the **same commit**; the persistence/partition, per-source SettingsTab, defaults, allowlist and AutoFavoriteSection tests pass; `MeshCoreNodeDisplaySection.tsx` untouched.

### Wave 3

**WP6: Locale keys, docs, full-suite and browser validation**
Owns: `public/locales/en.json` (WP5's keys), `docs/features/settings.md` (Node Display: the likely-aircraft block), `docs/features/maps.md` (badge + Show/Mark/Hide control), `docs/features/automation.md` (Auto-Favorite "Exclude likely aircraft" switch + two-sweep rule), `docs/features/automation-engine.md` (trigger + tokens), and the epic status log in `AIRCRAFT_DETECTION_EPIC.md`.
Acceptance: the full Vitest suite passes with PG/MySQL up (0 failures; check `numPendingTests`); `lint:ci` clean; browser validation per §6 in both map panels, Node Display and Auto Favorite, with screenshots.

---

## 9. What Phase 2 adds (so P1 does not pre-build it)

- **Reclassify as fixed:** a flagged node that is still heard and stays within ~100 m (reuse `positionSpanKm`) over 24 h / N fixes gets a persisted override (new column, for example `aircraftFixedAt`) that forces `likelyAircraft=false` until it moves again. This is where `ground_speed` can confirm movement.
- **Age-out service** modelled on `autoDeleteByDistance`: likely aircraft + position older than 24 h + not heard recently → Ignore (or Delete, opt-in). The last-run time is persisted (checklist §3).
- A "Show aged-out" review toggle.
P1's `likelyAircraft` / `aircraftClassifiedAt` / `positionTimestamp` are enough inputs. P2 must make `classifyAircraft` honour the fixed override.

---

## 10. Risks

| Risk | Mitigation |
|------|------------|
| A hung tile fetch wedges the single-flight queue (`safeFetch` has no timeout) | 15 s `Promise.race` + backoff (D4). Follow-up issue: add an `AbortSignal` timeout inside `elevationProvider` for all callers. |
| DEM voids or the ocean (`sanitizeElevation` → null) near coasts, or the Terrarium ~0 m ocean for boats | Void → MSL basis (safe: needs > 5000 m). The ocean returns ~0 m, so a boat reports ~0 m and gets AGL ≈ 0 → not aircraft. |
| GPS altitude is WGS84 ellipsoid-ish on some firmware vs DEM orthometric (geoid offset up to ±100 m) | 500 m default dwarfs it; documented in the settings help. |
| Mountain nodes with bad GPS altitude (spikes) flagged briefly | Hysteresis only protects the exit. A single spike can still flag, and the next good fix clears it. The two-strike sweep (D19) means one spike cannot drop an auto-favourite. P2's stationary override is the lasting fix. |
| Growing the frozen Node Display key set breaks the migration-131 seed invariants | The seeded/routed split (§4.6) keeps `NODE_DISPLAY_DEFAULT_STRINGS` and the seed test on the frozen ten. The constant and the `SettingsTab` literal change in one commit (WP5). |
| The strikes JSON races between two stacked sweep intervals | `autoFavoriteSweepRunning` already serialises sweeps within one manager; strikes are per source, and one manager owns one source. |
| A missed call site shows the badge on one map only | The `mapAircraftMode.wiring.test.ts` source guard. |
| A new `nodes` column breaks PG/MySQL suites (#4250) | All three hand-written DDL files are listed in WP1. |
| Unified view shows a flag from another source's row | Server and client merges copy the flag from the position row (§4.8, §5.7). |
| Large MQTT feeds: thousands of nodes → fetch volume | Ground memo + batching + backoff. Per-source disable. |
| The NodeInfo-before-position race auto-adds a plane | Accepted (§11 Q6): the two-strike sweep removes it after about an hour (two sweeps ≥ 45 min apart). There is no instant path. |

---

## 11. User decisions (2026-09-26)

All eight questions are answered. The spec above reflects each answer.

1. **Settings location:** Settings → **Node Display** (per-source), routed through `NODE_DISPLAY_SETTING_KEYS`. Not the Automation tab, and not the MeshCore Node Display section. See D18, §4.6 and §5.10.
2. **Auto-Favorite exclusion:** its **own per-source switch** `autoFavoriteExcludeAircraft`, default on, in the Auto-Favorite section. The exclusion applies only when detection **and** the switch are on. The switch is greyed out with an explanation when detection is off. See D14, §4.11 and §5.11.
3. **Hide mode:** favourites stay visible (D13).
4. **MQTT sources:** classified by default (D2).
5. **Sweep removal:** only after **two consecutive sweeps at least 45 min apart**, with the state persisted in `autoFavoriteAircraftStrikes`. It survives restarts and cannot be reset by a settings save. See D19 and §4.11.
6. **Plane auto-added before classification:** removed by the two-strike sweep. No instant path.
7. **Startup backfill:** yes (D11).
8. **Hysteresis:** fixed at 10% of the threshold, minimum 50 m, and users cannot change it (D8).

No open policy questions remain for Phase 1.
