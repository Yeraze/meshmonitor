# ATAK / CoT Epic — Phase 2 Implementation Spec

**Issue:** #3691 · **Phase goal:** per-source ATAK contact persistence + map
rendering. Populate an `atak_contacts` table from the PLI variant of TAKPacket
(Phase 1 currently early-returns on PLI), serve it per-source via an API route,
and render it as a toggleable map layer on the data-map surfaces.

**Branch base:** `meshmonitor-atak-phase2` worktree (origin/main + Phase 1 PR
#4307). Latest migration in the registry is **126** → this phase adds **127**.

**Scope reminder (epic interview decisions):** RX-only; V1 only. This phase does
NOT touch V2/Forwarder, the CoT feed (Phase 3), or GeoChat (already persisted in
Phase 1). MeshCore has no ATAK format — ATAK contacts are **Meshtastic-only**.

---

## 1. Reuse inventory (verified — use these, do not reinvent)

### Decode / ingest path (Phase 1, already present)
- **`meshtasticManager.processTakPacket(meshPacket, tak, context)`** —
  `src/server/meshtasticManager.ts:6229`. Reached from the side-effect
  `switch (normalizedPortNum)` `case PortNum.ATAK_PLUGIN` at **:5789**. Today it
  handles only `tak.chat` (GeoChat) and **returns before doing anything with
  `tak.pli`**. Phase 2 adds the PLI branch here. The decoded `tak` object shape
  (camelCase from protobufjs, with snake_case fallbacks) is already handled
  defensively in this method — reuse the same dual-access idiom
  (`tak.contact?.deviceCallsign ?? tak.contact?.device_callsign`).
- **`ensureMessageEndpointNodes(fromNum, toNum)`** — `meshtasticManager.ts:5950`.
  Reuse to guarantee the carrying `nodeNum` has a `nodes` row (contacts store a
  carrying `nodeNum`; no FK is required, but keeping the from-node row is
  consistent). PLI is a broadcast SA beacon, so call `ensureMessageEndpointNodes(fromNum, fromNum)`
  (no broadcast pseudo-node needed) OR just `databaseService.upsertNodeAsync`
  the from-node minimally — see §2c. Not strictly required for the contact row.
- **Protocol fields (verified against `protobufs/meshtastic/atak.proto`):**
  - `TAKPacket`: `is_compressed`, `contact{callsign, device_callsign}`,
    `group{role: MemberRole, team: Team}`, `status{battery: uint32}`, oneof
    `{ pli=5, chat=6, detail=7 }`.
  - `PLI`: `latitude_i` / `longitude_i` (sfixed32, ×1e-7 deg), `altitude` (int32,
    HAE), `speed` (uint32, m/s), `course` (uint32, deg).
  - `Team` enum (int → color): 0 `Unspecifed_Color`, 1 White, 2 Yellow,
    3 Orange, 4 Magenta, 5 Red, 6 Maroon, 7 Purple, 8 Dark_Blue, 9 Blue,
    10 Cyan (default), 11 Teal, 12 Green, 13 Dark_Green, 14 Brown.
  - `MemberRole` enum (int → label): 0 Unspecifed, 1 TeamMember, 2 TeamLead,
    3 HQ, 4 Sniper, 5 Medic, 6 ForwardObserver, 7 RTO, 8 K9.
  - `Contact.device_callsign` = the ATAK EUD's **stable device UID**;
    `Contact.callsign` = the user-facing display name (can be changed by the
    user). This drives the identity-key choice in §2a.

### Persistence patterns to model on
- **Migration recipe:** `src/server/migrations/121_mqtt_packet_log.ts` is the
  canonical recent **table-creation** migration (SQLite `CREATE TABLE IF NOT
  EXISTS` + `CREATE INDEX IF NOT EXISTS`; PG `CREATE TABLE IF NOT EXISTS` with
  quoted `"camelCase"` + `BIGINT` for node/packet ids + `GENERATED ALWAYS AS
  IDENTITY`; MySQL via helpers). Registry entry pattern in
  `src/db/migrations.ts` (see the 121/124/125/126 blocks). Idempotency helpers
  in `src/server/migrations/helpers.ts` (`createTableIfMissingMysql`,
  `createIndexIfMissingMysql`). **`settingsKey` is required.**
- **Per-source repository model:** `src/db/repositories/ignoredNodes.ts` — the
  closest analog: per-source table, composite PK `(nodeNum, sourceId)`, upsert
  semantics, `withSourceScope`. Its multi-backend test
  `src/db/repositories/ignoredNodes.test.ts` is the exact template for the
  hand-written `POSTGRES_CREATE` / `MYSQL_CREATE` DDL blocks (§4).
- **Base repository:** `src/db/repositories/base.ts` — `withSourceScope(table,
  sourceId)` (fail-closed; throws on empty sourceId), `upsert(table, values,
  target, updateSet)` (normalizes SQLite/PG `onConflictDoUpdate` vs MySQL
  `onDuplicateKeyUpdate`), `normalizeBigInts`, `col()`.
- **Schema three-table shape:** `src/db/schema/mqttPacketLog.ts` — one file with
  `sqliteTable` + `pgTable` + `mysqlTable` exports; registered in
  `src/db/schema/index.ts` via `export * from './atakContacts.js'`.
- **DatabaseService exposure:** `src/services/database.ts` — repo field
  (`public atakContactsRepo: AtakContactsRepository | null = null`), a getter
  (`get atakContacts()` throwing if uninit), and construction in the init block
  (mirror the `mqttPacketLogRepo` lines at :484 / :671–673 / :915). Consumers
  call `databaseService.atakContacts.<method>()`. (The CLAUDE.md "`Async`
  suffix" rule applies to methods promoted onto `DatabaseService` directly;
  the modern repo-getter pattern — `databaseService.atakContacts.upsertContact()`
  — is what mqtt/meshcore packet logs use and is preferred here. The repo
  methods are all `async`.)
- **Cleanup scheduler:** `src/server/services/mqttPacketLogService.ts` — a
  singleton service whose constructor calls `startCleanupScheduler()` →
  `setInterval` (15 min) → repo `deleteXOlderThan(cutoff)`. Model the retention
  sweep on this (§2d).

### API route + permission patterns
- **Route model:** `src/server/routes/mqttPacketRoutes.ts` — `Router({
  mergeParams: true })` mounted under `/api/sources/:id/...`, `optionalAuth()` +
  `requirePermission('<resource>', 'read', { sourceIdFrom: 'params.id' })`,
  `ok(res, data)` / `fail(res, status, code, msg)` from
  `src/server/utils/apiResponse.ts`. Find where it is mounted (search the app
  wiring for `mqttPacketRoutes` / `/api/sources/:id/mqtt`) and mount the ATAK
  router the same way.
- **Permission resource — DECISION: reuse `'nodes'` (action `'read'`).**
  Enumerated resources live in `src/types/permission.ts` (`ResourceType` union)
  and `SOURCEY_RESOURCES`. `nodes` is already a per-source (`SOURCEY_RESOURCES`)
  resource. **Justification for reuse over a new `atak` resource:** (1) ATAK
  contacts are node-like map entities shown alongside nodes and gated by the map
  UI, so the existing map-data read grant is the correct semantic; (2) adding a
  new resource requires editing the `ResourceType` union **and** the permissions
  `CHECK (resource IN (...))` constraint (rebuilt in `006_add_packetmonitor_permission.ts`
  / migration 082) across three backends, **and** admin-UI wiring, **and**
  seeding for existing users — disproportionate surface for a read-only map
  overlay. If a future phase needs to hide ATAK independently of nodes, promote
  to a dedicated resource then. **This choice means no permissions migration is
  needed.**

### Frontend patterns
- **Data-fetch hook:** `src/hooks/useWaypoints.ts` — TanStack `useQuery` keyed
  `['waypoints', sourceId]`, `enabled: Boolean(sourceId)`, `staleTime`, raw
  `fetch` with `credentials:'include'`, and **unwraps `body.data`**
  (`Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []`).
  Raw `fetch` is allowed here — the raw-`fetch` ESLint ban applies only to
  `src/components/**` and `src/pages/**`, **not** `src/hooks/**`. Model
  `useAtakContacts(sourceId)` on this exactly.
- **Self-fetching per-source map layer:** `src/components/map/layers/WaypointsLayer.tsx`
  → `PerSourceWaypoints({ source })` calls `useWaypoints(source.id)` and renders
  `<Marker>`+`<Popup>` per row. This is the render model for `AtakContactsLayer`
  (contacts are sparse — one row per distinct ATAK device — so direct `<Marker>`
  rendering like waypoints is correct; do **not** route through
  `NodeMarkersLayer`'s spiderfier machinery, which exists for dense node piles).
- **Descriptor shape reference:** `NodeMarkersLayer.tsx` `NodeMarkerDescriptor`
  (`key`, `position`, `iconSig`, `buildIcon`, `opacity`, `eventHandlers`,
  `children`). Honor the descriptor idea (`AtakContactDescriptor`) for the icon
  builder, but render `<Marker>` directly per the waypoints model.
- **Icon builder:** `src/components/map/markerIcons.ts` — `L.divIcon`-based
  builders (`createNodeIcon`, `roleGlyphMarkerSvg`, `createTracerouteEndpointIcon`).
  Add `createAtakContactIcon({ color, callsign, stale })` here.
- **Multi-source wrapper:** `src/components/Dashboard/DashboardWaypoints.tsx`
  maps `sources[]` → `<PerSourceWaypoints>` for the unified dashboard. Model
  `DashboardAtakContacts` on this.
- **Toggle mechanism (two flavors):**
  - **Nodes + Dashboard maps** read `useMapContext()` booleans
    (`src/contexts/MapContext.tsx`): e.g. `showWaypoints` / `setShowWaypoints`,
    `showNeighborInfo`. The map-features checkbox panel in `NodesTab.tsx`
    (~:2428) and `DashboardMap.tsx` (~:841) drives them, and the render is
    gated `{showWaypoints && <DashboardWaypoints .../>}` (NodesTab :2659,
    DashboardMap :655). Add `showAtakContacts`/`setShowAtakContacts` to
    `MapContext` and mirror this.
  - **Map Analysis** uses its own config-layer system:
    `MapAnalysisCanvas.tsx` gates `{config.layers.<name>.enabled && <XLayer/>}`
    (:235–269). Add an `atakContacts` layer entry to the MapAnalysis layer
    config + its layers panel.
- **Popup family:** `src/components/map/popups/` (`NodeCard`, `sections`) exists
  for node popups; ATAK contact popups are simpler (a small field list), so
  build an inline `<Popup>` in `AtakContactsLayer` styled by a CSS module — do
  not force it through `NodeCard`.

### BaseMap surface enumeration (which get the ATAK layer)
`grep 'BaseMap'` lists 15 files; most are **not** data maps. The layer mounts
only on the Meshtastic data-map surfaces:

| Surface | File | Gets ATAK layer? | How it fetches / toggles |
|---|---|---|---|
| Nodes (per-source) | `NodesTab.tsx` | **Yes** | `AtakContactsLayer` w/ `sourceId=currentSourceId`; `showAtakContacts` from MapContext |
| Dashboard (unified + per-source) | `Dashboard/DashboardMap.tsx` | **Yes** | `DashboardAtakContacts` (multi-source wrapper) gated by `showAtakContacts` |
| Map Analysis | `MapAnalysis/MapAnalysisCanvas.tsx` | **Yes** | `config.layers.atakContacts.enabled` toggle; single active source |
| MeshCore map | `MeshCore/MeshCoreMap.tsx` | **No** | MeshCore sources have no ATAK data (Meshtastic-only) — always empty; skip |
| Embed map | `EmbedMap.tsx` | **No (defer)** | public embed; out of scope this phase |
| Editors/pickers | `GeofenceMapEditor`, `BBoxMapEditor`, `DefaultMapCenterPicker`, `EmbedSettings`, `MeshCoreMessageRouteModal` | **No** | not data maps |

---

## 2. File-by-file changes (signatures + verified anchors)

### 2a. `src/db/schema/atakContacts.ts` (NEW) — three-table schema

Model on `mqttPacketLog.ts`. Table `atak_contacts`. **Identity / PK: composite
`(uid, sourceId)`** (mirrors `ignored_nodes`' `(nodeNum, sourceId)`).

**`uid` definition (identity key):** `device_callsign` when present (stable EUD
UID), else `callsign`, else the carrying node fallback `!<nodeNum hex>`.
Justification vs alternatives: `device_callsign` is the ATAK-native stable
device identifier (callsign is user-mutable display text); keying on it means a
user renaming their callsign updates the same row rather than orphaning it.
Falling back to `callsign` then `nodeNum` guarantees a non-empty key when a
sender omits `device_callsign` (see §3 edge cases).

Columns (SQLite names; PG/MySQL use quoted camelCase):

| Column | SQLite type | PG type | Notes |
|---|---|---|---|
| `uid` | `TEXT NOT NULL` | `TEXT` | identity part 1 |
| `sourceId` | `TEXT NOT NULL` | `TEXT` | identity part 2; per-source scope |
| `nodeNum` | `INTEGER` | `BIGINT` | carrying Meshtastic node (unsigned 32-bit → BIGINT in PG/MySQL) |
| `callsign` | `TEXT` | `TEXT` | display callsign |
| `deviceCallsign` | `TEXT` | `TEXT` | stable device UID (may equal `uid`) |
| `team` | `INTEGER` | `INTEGER` | Team enum int (0–14); null if no Group |
| `role` | `INTEGER` | `INTEGER` | MemberRole enum int (0–8); null if no Group |
| `battery` | `INTEGER` | `INTEGER` | Status.battery; null if no Status |
| `latitude` | `REAL` | `REAL` | decimal deg; **null when bogus** (see §3) |
| `longitude` | `REAL` | `REAL` | decimal deg; null when bogus |
| `altitude` | `INTEGER` | `INTEGER` | HAE meters; null if absent |
| `speed` | `INTEGER` | `INTEGER` | m/s |
| `course` | `INTEGER` | `INTEGER` | degrees |
| `lastSeen` | `INTEGER NOT NULL` | `BIGINT` | ms epoch of latest PLI |
| `createdAt` | `INTEGER NOT NULL` | `BIGINT` | ms epoch first seen |

- PK: `PRIMARY KEY (uid, sourceId)`.
- Indexes: `idx_atak_contacts_source_lastseen (sourceId, lastSeen)`,
  `idx_atak_contacts_source_node (sourceId, nodeNum)`.
- **PG/MySQL BIGINT** for `nodeNum`, `lastSeen`, `createdAt` (nodeNum is unsigned
  32-bit; timestamps are ms). Coerce with `Number(...)` on read.
- Register in `src/db/schema/index.ts`: `export * from './atakContacts.js';`.

### 2b. `src/server/migrations/127_add_atak_contacts.ts` (NEW)

Copy the structure of `121_mqtt_packet_log.ts` exactly:
- `export const migration = { up(db), down(db) }` (SQLite `CREATE TABLE IF NOT
  EXISTS` + `CREATE INDEX IF NOT EXISTS`; composite PK inline).
- `export async function runMigration127Postgres(client)` — `CREATE TABLE IF NOT
  EXISTS` with quoted camelCase, BIGINT columns, `PRIMARY KEY ("uid","sourceId")`,
  then `CREATE INDEX IF NOT EXISTS`.
- `export async function runMigration127Mysql(pool)` — use
  `createTableIfMissingMysql(pool, 'atak_contacts', ...)` with inline
  `PRIMARY KEY` + `INDEX` clauses, then `createIndexIfMissingMysql` for any
  extra index (per the recipe — MySQL has no `CREATE INDEX IF NOT EXISTS`).
- Register in `src/db/migrations.ts`:
  ```ts
  registry.register({
    number: 127,
    name: 'add_atak_contacts',
    settingsKey: 'migration_127_add_atak_contacts',
    sqlite: (db) => addAtakContactsMigration.up(db),
    postgres: (client) => runMigration127Postgres(client),
    mysql: (pool) => runMigration127Mysql(pool),
  });
  ```
- Idempotent, non-destructive (pure `CREATE ... IF NOT EXISTS`). No backfill:
  the table starts empty and populates from live PLI traffic.

### 2c. `src/db/repositories/atakContacts.ts` (NEW) — repository

`export class AtakContactsRepository extends BaseRepository`. All methods async,
all scoped by `sourceId` via `withSourceScope`. Suggested surface:

```ts
export interface AtakContactRow {
  uid: string; sourceId: string; nodeNum: number | null;
  callsign: string | null; deviceCallsign: string | null;
  team: number | null; role: number | null; battery: number | null;
  latitude: number | null; longitude: number | null; altitude: number | null;
  speed: number | null; course: number | null;
  lastSeen: number; createdAt: number;
}

// Upsert on (uid, sourceId). Preserves createdAt on conflict; updates the rest.
async upsertContact(row: AtakContactRow): Promise<void>
// Newest-first, scoped. Used by the API route.
async getContacts(sourceId: string): Promise<AtakContactRow[]>
// Retention sweep (all sources) — used by the cleanup scheduler.
async deleteContactsOlderThan(cutoffMs: number): Promise<number>
// Source-scoped clear (parity w/ other repos; used by tests / source delete).
async deleteContactsForSource(sourceId: string): Promise<number>
// Distinct sourceIds present (for per-source retention loops if needed).
async getContactSourceIds(): Promise<string[]>
```

- `upsertContact` uses `this.upsert(this.tables.atakContacts, values, [uid,
  sourceId] target, updateSet)`. On conflict, **do not overwrite `createdAt`**;
  update `nodeNum, callsign, deviceCallsign, team, role, battery, latitude,
  longitude, altitude, speed, course, lastSeen`.
- `getContacts` → `.select().from(atakContacts).where(withSourceScope(...)).orderBy(desc(lastSeen))`,
  then `normalizeBigInts`.
- Wire into `DatabaseService` (`src/services/database.ts`): import repo, add
  `atakContactsRepo` field, `get atakContacts()`, and construct it in the init
  block alongside `mqttPacketLogRepo`.
- **Source-delete cleanup:** `DELETE /api/sources/:id` already purges per-source
  rows for other tables. Add an `atakContacts.deleteContactsForSource(id)` call
  to that handler (search the sources route for where it deletes per-source
  data — e.g. nodes/packet logs — and add the ATAK line). Low risk; keeps a
  deleted source's ghosts from lingering.

### 2d. `src/server/services/atakContactService.ts` (NEW) — mapping + retention

Small singleton, modeled on `mqttPacketLogService.ts`:
- `buildContactRow(meshPacket, tak, sourceId): AtakContactRow | null` — pure
  mapper from a decoded PLI TAKPacket to a row (testable in isolation). Returns
  `null` when there is no usable identity or no PLI (defensive). Handles:
  - `uid` derivation (§2a).
  - `nodeNum = Number(meshPacket.from)`.
  - camel/snake dual-access for every proto field.
  - coordinate conversion: `lat = pli.latitudeI * 1e-7` etc.; **bogus-position
    guard** (§3) → null lat/lon.
  - `lastSeen = createdAt = Date.now()` (caller preserves createdAt on upsert).
- `startCleanupScheduler()` in the constructor: `setInterval` (15 min) →
  `databaseService.atakContacts.deleteContactsOlderThan(Date.now() - RETENTION_MS)`.
  **Retention window: fixed 24h** (`ATAK_CONTACT_RETENTION_MS`). Justification:
  contacts are low-volume (one row per ATAK EUD per source) and always-on (not
  opt-in like packet logs), so no settings knob is warranted; 24h drops devices
  that have gone permanently silent while surviving normal outages.
- `stopCleanupScheduler()` for symmetry (test teardown).
- Export a shared **staleness constant** `ATAK_CONTACT_STALE_MS` (default
  **15 min**) used by the route to compute the `stale` flag. Justification: ATAK
  PLI beacons cadence is seconds-to-minutes; 15 min marks a contact "no longer
  actively reporting" without hiding it (retention still keeps it 24h).

### 2e. `src/server/meshtasticManager.ts` — PLI branch in `processTakPacket`

At the top of `processTakPacket` (:6229), **after** the existing
`if (!tak || typeof tak !== 'object' || tak instanceof Uint8Array) return;`
guard and **before** the `const chat = tak.chat` GeoChat logic, add the PLI
branch:

```ts
// Phase 2 (#3691): PLI variant → ATAK contact upsert (position/status/team).
// Compressed string fields are unishox2 (out of scope), but PLI ints and
// Group/Status/Contact scalars are still valid when is_compressed=true — the
// callsign/deviceCallsign strings may be garbage, so guard those (see spec §3).
const pli = tak.pli;
if (pli) {
  try {
    const row = atakContactService.buildContactRow(meshPacket, tak, this.sourceId);
    if (row) {
      await this.ensureMessageEndpointNodes(fromNum, fromNum); // carrying node row
      await databaseService.atakContacts.upsertContact(row);
      // Optional: emit a websocket event so the map refreshes live (see §2f).
    }
  } catch (error) {
    logger.error('❌ Error persisting ATAK PLI contact:', error);
  }
  return; // PLI does not become a Messages row
}
```

- Keep the existing GeoChat path untouched below this.
- `fromNum` is already computed earlier in the method for the GeoChat path —
  hoist its derivation above the PLI branch if needed
  (`const fromNum = Number(meshPacket.from)`).
- **No auto-responder / push-notification side effects** (RX-only, consistent
  with the GeoChat path's comment).

### 2f. Live-update event (optional but recommended)

`useWaypoints` relies on a `useWebSocket` `waypoint:*` event to invalidate its
cache. For parity, emit an `atakContact:updated` (or reuse a generic
`dataUpdated`) event after `upsertContact` via `dataEventEmitter`, and have
`useAtakContacts` invalidate on it. **If wiring a new socket event is
disproportionate, fall back to TanStack polling** (`refetchInterval: 30_000` on
the query) — acceptable given contacts are low-volume. Pick one; document it.

### 2g. `src/server/routes/atakRoutes.ts` (NEW) — API route

Model on `mqttPacketRoutes.ts`. `Router({ mergeParams: true })`, mounted at
`/api/sources/:id/atak` (mount next to where mqtt/meshcore per-source routers
are mounted).

```
GET /api/sources/:id/atak/contacts
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' })
  → rows = await databaseService.atakContacts.getContacts(sourceId)
  → decorate each with stale = (Date.now() - lastSeen) > ATAK_CONTACT_STALE_MS
  → ok(res, contacts)   // { success: true, data: [...] }
```

- Response envelope: `ok(res, contacts)` → `{ success:true, data:[...] }`.
  The frontend hook unwraps `body.data` (§useAtakContacts), so this is correct.
- On error: `fail(res, 500, 'ATAK_CONTACTS_FETCH_FAILED', msg)`.
- Deliberately does **not** check source manager type / liveness (mirror
  mqttPacketRoutes' comment) — a non-Meshtastic or disconnected source simply
  returns `[]`.

### 2h. `src/server/constants/settings.ts`

**No change.** Contact capture is always-on and retention/stale are fixed
constants — no new `VALID_SETTINGS_KEYS` entries, no Settings UI.

### 2i. Frontend — hook, layer, wrapper, icon, toggle

- **`src/hooks/useAtakContacts.ts` (NEW)** — copy `useWaypoints` structure:
  `useQuery(['atakContacts', sourceId ?? ''], () => fetch(...contacts), {
  enabled: Boolean(sourceId), staleTime: 30_000, refetchInterval: 30_000 })`;
  fetch `${appBasename}/api/sources/${id}/atak/contacts`, unwrap `body.data`.
  Return `{ contacts }`. Add a `types/atakContact.ts` `AtakContact` interface
  (mirrors `AtakContactRow` + `stale: boolean`).
- **`src/components/map/layers/AtakContactsLayer.tsx` (NEW)** — modeled on
  `WaypointsLayer`'s `PerSourceWaypoints`:
  - `export function AtakContactsLayer({ source }: { source: SourceInfo })`
    calls `useAtakContacts(source.id)`.
  - Renders one `<Marker>` per contact **with a valid lat/lon** (skip null-
    position rows), icon `createAtakContactIcon({ color: TEAM_COLORS[team],
    callsign, stale })`, `opacity` dimmed when `stale`.
  - `<Popup>` shows: callsign, team (name + swatch), role (name), battery %,
    course°, speed (m/s), altitude (m HAE), last-seen (relative), and a STALE
    badge when stale.
  - Provide a `AtakContactDescriptor` interface (key/position/iconSig/buildIcon)
    for internal clarity even though rendering is direct.
  - Use `UiIcon` for any interface glyphs; **no emoji/Unicode icon stand-ins in
    JSX** (CLAUDE.md hard rule). Team color swatch is a styled `<span>`, not an
    emoji.
- **`src/components/map/layers/AtakContactsLayer.module.css` (NEW)** — CSS module
  (containment rule): popup field grid, team swatch, stale badge. Do not touch
  global sheets.
- **`TEAM_COLORS` map** — put in `markerIcons.ts` or a small
  `src/utils/atakTeam.ts`: Team enum int → CSS color (White `#ffffff`, Yellow
  `#ffff00`, Orange `#ff7e00`, Magenta `#ff00ff`, Red `#ff0000`, Maroon
  `#7e0000`, Purple `#7e00ff`, Dark_Blue `#00007e`, Blue `#0000ff`, Cyan
  `#00ffff`, Teal `#007e7e`, Green `#00ff00`, Dark_Green `#007e00`, Brown
  `#7e3e00`, Unspecified/default → Cyan). Plus `ROLE_LABELS` int→string and
  `TEAM_LABELS` int→string.
- **`src/components/Dashboard/DashboardAtakContacts.tsx` (NEW)** — copy
  `DashboardWaypoints.tsx`: iterate visible sources → `<AtakContactsLayer
  key source={s}/>`.
- **`src/contexts/MapContext.tsx`** — add `showAtakContacts: boolean` +
  `setShowAtakContacts(show)` to `MapContextType` (:46), a
  `useState<boolean>(false)` (default **off**, matching `showNeighborInfo`), and
  expose in the provider `value`. Follow the exact `showWaypoints` wiring.
- **`src/components/NodesTab.tsx`** — destructure `showAtakContacts` from
  `useMapContext()` (:359 area), add a checkbox to the map-features panel
  (~:2428, next to Show Waypoints) with `t('map.showAtakContacts', 'Show ATAK
  Contacts')`, and render `{showAtakContacts && <AtakContactsLayer source={...}/>}`
  next to the waypoints render (:2659). `currentSourceId` is already in scope.
- **`src/components/Dashboard/DashboardMap.tsx`** — same: destructure
  `showAtakContacts` (:239 area), checkbox (~:841), render
  `{showAtakContacts && <DashboardAtakContacts sourceId={sourceId} />}` (:655).
- **`src/components/MapAnalysis/MapAnalysisCanvas.tsx`** — add an `atakContacts`
  entry to the MapAnalysis layer config (find the `config.layers` definition and
  its layers-panel), gate `{config.layers.atakContacts.enabled &&
  <AtakContactsLayer source={activeSource}/>}` (:235 area). If the MapAnalysis
  layer-config plumbing is heavier than expected, this surface may move to WP4
  as a follow-on — Nodes + Dashboard are the required surfaces.
- **i18n:** add `map.showAtakContacts` (+ any popup labels) to the locale
  files used by the other `map.*` keys.

---

## 3. Edge cases (each needs a test)

| Case | Expected behavior |
|---|---|
| **PLI with 0/0 coords (Null Island)** | Contact row still upserted (callsign/team/status useful), but `latitude/longitude = null` → not rendered on map, shown as position-less. Reuse the existing bogus-position guard — search `isBogusPosition` / "Null Island" / `precisionBits` in the Meshtastic position path and reuse it; else inline `(lat===0 && lon===0) \|\| abs(lat)>90 \|\| abs(lon)>180`. |
| **PLI with out-of-range coords** | Same as above → null lat/lon, row persists. |
| **`is_compressed = true`** | PLI ints (lat/lon/alt/speed/course) and Group/Status are still valid → persist them. But `contact.callsign`/`device_callsign` strings are unishox2 → treat as unreliable: still store them (labeled), but `uid` should prefer `device_callsign` only if it's plain ASCII; safest is to fall back to `!<nodeNum>` when `is_compressed`. Decide + test: **when compressed, key uid on `nodeNum` fallback** to avoid garbage-keyed rows. |
| **No `device_callsign`** | `uid = callsign ?? '!<nodeNum hex>'`. Row persists; callsign column may be null. |
| **No `pli` (chat/detail/no variant)** | PLI branch not entered — unchanged Phase 1 behavior (GeoChat persists / detail preview-only). No contact row. |
| **No `group` / `status`** | `team/role/battery = null`; icon uses default Cyan; popup omits missing fields. |
| **Same callsign from two sources** | Two rows: `(uid, sourceA)` and `(uid, sourceB)` — composite PK keeps them isolated; `getContacts(sourceA)` returns only A's. **`atakContacts.perSource.test.ts` asserts this.** |
| **Repeated PLI from same device** | Upsert updates position/lastSeen in place; `createdAt` preserved; one row. |
| **Malformed protobuf (decode threw upstream)** | `tak` is a raw `Uint8Array` → the existing `instanceof Uint8Array` guard returns early; `buildContactRow` never called. No crash. |
| **Retention** | `deleteContactsOlderThan(now-24h)` removes silent devices; 15-min stale flag dims but keeps recent-but-quiet contacts. |
| **Source deleted** | `deleteContactsForSource(id)` in the source-delete handler purges that source's contacts. |

---

## 4. Test plan

All in the standard Vitest suite (no standalone scripts). Multi-backend suites
only run with the PG (5433) / MySQL (3307) containers up — bring them up per
CLAUDE.md before claiming schema verification; confirm via `numPendingTests`.

- **Migration test** — `src/server/migrations/127_add_atak_contacts.test.ts`
  (model `121_mqtt_packet_log.test.ts`): asserts the table + indexes exist after
  `up`, and idempotency (running twice is a no-op). The registry-count invariant
  in `src/db/migrations.test.ts` is **registry-derived — no count bump needed**
  (confirmed: it asserts structural invariants, not a hardcoded number).
- **Repository multi-backend test** —
  `src/db/repositories/atakContacts.test.ts` (model `ignoredNodes.test.ts`):
  SQLite always; `describe.skipIf(!postgresAvailable)` + `!mysqlAvailable` via
  `createPostgresBackend(POSTGRES_CREATE)` / `createMysqlBackend(MYSQL_CREATE)`.
  Provide hand-written DDL blocks:
  ```
  POSTGRES_CREATE:  DROP TABLE IF EXISTS atak_contacts CASCADE;
                    CREATE TABLE atak_contacts (
                      "uid" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
                      "nodeNum" BIGINT, "callsign" TEXT, "deviceCallsign" TEXT,
                      "team" INTEGER, "role" INTEGER, "battery" INTEGER,
                      "latitude" REAL, "longitude" REAL, "altitude" INTEGER,
                      "speed" INTEGER, "course" INTEGER,
                      "lastSeen" BIGINT NOT NULL, "createdAt" BIGINT NOT NULL,
                      PRIMARY KEY ("uid","sourceId"));
  MYSQL_CREATE:     DROP TABLE IF EXISTS atak_contacts;
                    CREATE TABLE atak_contacts ( uid VARCHAR(191) NOT NULL,
                      sourceId VARCHAR(191) NOT NULL, nodeNum BIGINT,
                      callsign TEXT, deviceCallsign TEXT, team INT, role INT,
                      battery INT, latitude DOUBLE, longitude DOUBLE,
                      altitude INT, speed INT, course INT,
                      lastSeen BIGINT NOT NULL, createdAt BIGINT NOT NULL,
                      PRIMARY KEY (uid, sourceId));
  ```
  (SQLite DDL comes from `createTestDb()` via the migration registry — nothing
  hand-written there. Note MySQL PK columns must be bounded length →
  `VARCHAR(191)`, not `TEXT`.) Cover: upsert insert, upsert update (createdAt
  preserved, lastSeen advances), `getContacts` ordering/scoping,
  `deleteContactsOlderThan`, `deleteContactsForSource`, bogus-position → null
  lat/lon.
- **Per-source isolation test** —
  `src/db/repositories/atakContacts.perSource.test.ts`: same uid under two
  sources stays two rows; `getContacts(A)` excludes B; `withSourceScope` throws
  on empty sourceId.
- **Mapper test** — `src/server/services/atakContactService.test.ts`:
  `buildContactRow` for full PLI, missing group/status, no device_callsign,
  compressed (uid→nodeNum fallback), 0/0 coords (null lat/lon), no-pli → null.
- **Manager ingest test** — extend `meshtasticManager.atak.test.ts` (Phase 1) or
  add `meshtasticManager.atak.pli.test.ts`: a PLI TAKPacket calls
  `atakContacts.upsertContact` once and does **not** insert a Messages row;
  malformed input persists nothing and does not throw.
- **Route permission test** — `src/server/routes/atakRoutes.permissions.test.ts`
  via `createRouteTestApp()` (harness — mandatory for new route tests): grant
  `nodes:read` on sourceA only; assert 200 + scoped data for A, 403 for a user
  without the grant, and cross-source isolation (no B rows leak). Model on
  `sourceRoutes.permissions.test.ts` / `mqttPacketRoutes` tests.
- **Frontend layer test** —
  `src/components/map/layers/AtakContactsLayer.test.tsx` (model
  `WaypointsLayer.test.tsx` / `NodeMarkersLayer.test.tsx`): mocks the hook,
  asserts markers render for positioned contacts, position-less contacts are
  skipped, team color + stale dimming applied, popup fields present.
- **Full-suite + lint gate:** run the whole Vitest suite (0 failures) with PG +
  MySQL containers up; `npm run lint:ci` clean of in-repo `FAIL` lines
  (ignore `.claude/worktrees/*`); `tsc` clean. Do not grow the ESLint baseline —
  new components must use `ApiService`/hook fetch (hooks may use raw `fetch`),
  `UiIcon` (no emoji), CSS modules.

---

## 5. Work packages (ordered)

### WP1 — Schema + migration + repository (foundation) — FIRST
**Files:** `src/db/schema/atakContacts.ts`, `src/db/schema/index.ts` (export),
`src/server/migrations/127_add_atak_contacts.ts`, `src/db/migrations.ts`
(register), `src/db/repositories/atakContacts.ts`, `src/services/database.ts`
(field/getter/init), `127_add_atak_contacts.test.ts`,
`atakContacts.test.ts`, `atakContacts.perSource.test.ts`.
**Acceptance:** migration creates table+indexes on all three backends,
idempotent; repository upsert/get/delete pass on SQLite (+PG/MySQL when
containers up); per-source isolation test green; `migrations.test.ts` passes
with no count edit; full suite green.

### WP2 — PLI populate + service + API route (depends on WP1)
**Files:** `src/server/services/atakContactService.ts` (+ `.test.ts`),
`src/server/meshtasticManager.ts` (PLI branch in `processTakPacket`),
`src/server/routes/atakRoutes.ts`, route mount site, sources-delete handler
(add `deleteContactsForSource`), `meshtasticManager.atak.pli.test.ts`,
`atakRoutes.permissions.test.ts`.
**Acceptance:** a PLI TAKPacket upserts exactly one contact row (position/team/
role/battery), preserves `createdAt` on repeat, writes no Messages row;
compressed/no-device-callsign/bogus-coords/malformed handled per §3; `GET
/api/sources/:id/atak/contacts` returns `{success:true,data:[...]}` with `stale`
flags, enforces `nodes:read` per-source (403 without grant, isolation holds);
retention scheduler deletes >24h rows. §4 WP2 tests + full suite green.

### WP3 — Frontend layer + Nodes/Dashboard toggles (depends on WP2 API)
**Files:** `src/hooks/useAtakContacts.ts`, `src/types/atakContact.ts`,
`src/components/map/layers/AtakContactsLayer.tsx` (+ `.module.css` + `.test.tsx`),
`src/components/Dashboard/DashboardAtakContacts.tsx`,
`markerIcons.ts`/`utils/atakTeam.ts` (icon + TEAM_COLORS/labels),
`src/contexts/MapContext.tsx` (toggle), `NodesTab.tsx`, `Dashboard/DashboardMap.tsx`,
locale files.
**Acceptance:** Nodes + Dashboard maps show a "Show ATAK Contacts" toggle
(default off); enabling renders team-colored callsign markers for positioned
contacts, skips position-less ones, dims stale ones; popup shows callsign/team/
role/battery/course/speed/altitude/last-seen/stale; hook unwraps `body.data`, no
raw `fetch` in components/pages, uses `UiIcon`; layer test + full suite green;
lint:ci clean.

### WP4 — Map Analysis surface + browser validation + docs/polish (depends WP3)
**Files:** `src/components/MapAnalysis/MapAnalysisCanvas.tsx` (+ MapAnalysis
layer-config), epic doc Phase-2 checkboxes, this spec's decisions log, any
README/docs note.
**Acceptance:** Map Analysis exposes the ATAK layer via its config-layer toggle;
browser-validated on Nodes + Dashboard + Map Analysis (real markers, popup,
toggle, stale dimming) via deployed dev container; epic doc updated; full suite +
lint:ci + tsc green; PR opened, CI green, merged.

*(WP3 and WP4-MapAnalysis are parallelizable once WP2 lands; WP4-MapAnalysis can
fold into WP3 if the MapAnalysis config plumbing proves light.)*

---

## 6. Open questions / flags for the phase lead

1. **Live update vs polling (§2f):** recommend `refetchInterval: 30_000` on the
   query for simplicity unless a websocket `atakContact:updated` event is cheap
   to add. Confirm preference.
2. **Compressed-packet callsign trust (§3):** spec says key `uid` on `nodeNum`
   when `is_compressed=true` to avoid garbage-keyed rows. Confirm this is the
   desired trade-off (alternative: skip compressed PLI contacts entirely).
3. **Resource reuse (`nodes`):** confirm reusing `nodes:read` (no new permission
   resource / no permissions migration). If ATAK must be independently hideable,
   promote to a dedicated `atak` resource (adds a permissions CHECK-constraint
   migration + admin UI + seeding across three backends).
4. **Map Analysis surface:** required by "all map surfaces," but its config-layer
   plumbing differs from the MapContext toggle. Sized as WP4; confirm it's in
   scope for Phase 2 vs a fast-follow.
5. **EmbedMap:** intentionally excluded (public embed). Confirm.
