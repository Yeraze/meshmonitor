# Reticulum Phase 1a — Build Spec (Bridge + Backend)

**Epic:** #3960 · **Phase:** 1a (bridge + backend only; no frontend, messaging, map, radio config, or remote management)
**Worktree:** `/home/yeraze/Development/meshmonitor-reticulum-1a` · **Branch:** `feature/reticulum-phase-1a`
**Author:** Phase Architect (Opus) · **Date:** 2026-08-13 · **Status:** ready for implementers

> Implementers: this spec is the source of truth for Phase 1a. It was verified against the tree as it
> exists **now**, not against the design docs. Where the epic (`RETICULUM_SOURCE_EPIC.md`) and the
> current codebase disagree with the older research/design notes, the codebase wins.

---

## 0. Provenance corrections (READ FIRST)

The task brief cited four docs. Reality in this worktree:

| Cited doc | Status | Use instead |
|---|---|---|
| `RETICULUM_SOURCE_DESIGN.md` | **ABSENT** — does not exist on this branch | `RETICULUM_SOURCE_EPIC.md` (scope) + `RETICULUM_SOURCE_RESEARCH.md` (data-model rationale) |
| `RETICULUM_ATTACH_PHASE1_SPEC.md` (the "2026-08-04 spec", WP0–WP8, wire protocol v1) | **ABSENT** — never committed here | This document supersedes it; WP layout below is re-derived from the epic exit criteria |
| `RETICULUM_SOURCE_EPIC.md` | present, authoritative for scope | — |
| `ARCHITECTURE_LESSONS.md` | present | multi-source + migration rules applied below |

Because the two most detailed docs are missing, **the WP0–WP8 numbering, wire-protocol details, and
bridge module layout in this spec are newly authored** to satisfy the epic's Phase 1a exit criteria,
not "refinements" of a prior spec. Flag to the orchestrator if a canonical attach spec exists on
another branch and should be diffed in.

---

## 1. Reuse inventory (mandatory — reuse over duplication is a hard rule)

Every item below MUST be reused/extended, not re-created. Paths are current.

### 1.1 Manager + registry plumbing (mirror MeshCore exactly)
- `src/server/sourceManagerRegistry.ts` — the **single unified registry**. `ReticulumManager` registers
  here via `addManager()` / is removed via `removeManager()`. `ISourceManager` interface is defined at
  the top of this file (8 members — see §3.4). Do **not** create a `ReticulumManagerRegistry`. (The
  research doc's claim that MeshCore uses its own `MeshCoreManagerRegistry` is **stale**; MeshCore now
  lives in this unified registry as an `ISourceManager`.)
- `src/server/sourceManagerTypes.ts` — canonical type-guards `isMeshCoreManager` / `isMeshtasticManager`.
  **Add `isReticulumManager(m): m is ReticulumManager` here** (discriminant `m.sourceType === 'reticulum'`).
- `src/server/meshcoreManager.ts` (class `MeshCoreManager extends EventEmitter implements ISourceManager`)
  — the structural template for `ReticulumManager`. Mirror: `get sourceType()`, `async start()`,
  `async stop()`, `getStatus()`, `getLocalNodeInfo()` (returns `null` — copy this), `isConnected()`,
  `startDistanceDeleteScheduler()` / `stopDistanceDeleteScheduler()`, constructor `(sourceId, sourceName?)`.
- `src/server/meshcoreConfig.ts` — the template for `reticulumConfig.ts`. Mirror the three exports:
  `meshcoreConfigFromSource(source) -> Config|null`, `ensureMeshCoreManagerStarted(source, cfg)`
  (create-or-reconnect recipe used by both boot and routes), and the `MeshCoreSourceConfig` interface.
  Do **not** copy from the deprecated `meshcoreRegistry.ts`.
- `src/server/bootstrapSources.ts` — startup source loader. Add a `reticulum` branch (see §3.6).
- `src/server/utils/ownNodes.ts` — filters by `isMeshCoreManager`; leave as-is (Reticulum has no own nodes in 1a).

### 1.2 Persistence (reuse the repository/migration/schema machinery)
- `src/db/repositories/base.ts` — `BaseRepository`, `withSourceScope(table, sourceId)`. Every Reticulum
  query MUST scope by `sourceId` through this. Raw SQL outside repositories/migrations is ESLint-banned.
- `src/db/repositories/meshcore.ts` (`MeshCoreRepository`) + `src/db/repositories/atakContacts.ts` —
  precedents for a per-source domain repository with upsert/list/get. Model `ReticulumRepository` on these.
- `src/db/repositories/telemetry.ts` — `TelemetryRepository.insertTelemetry(DbTelemetry, sourceId?)` and
  `insertTelemetryBatch(rows, sourceId?)`. **Interface throughput history rides this shared table** per the
  epic (no new history table) — but see the FK caveat in §7 (Open Risks) before relying on it.
- `src/db/schema/` — Drizzle schema, per-dialect triplets (sqlite/postgres/mysql). New tables need schema
  entries here + registration in the schema barrel + `this.tables` wiring. Mirror `src/db/schema/*` for
  `atak_contacts` (migration 127) as the newest add-a-table precedent.
- `src/server/migrations/helpers.ts` — `createTableIfMissingMysql`, `createIndexIfMissingMysql`,
  `addColumnIfMissing*`. Use these; migrations must be idempotent on all three backends.
- `src/db/migrationRegistry.ts` + `src/db/migrations.ts` — registry. `registry.register({number,name,settingsKey,sqlite,postgres,mysql})`.
  `src/db/migrations.test.ts` is **registry-derived — do not edit it** (count/sequence assertions auto-cover new entries).

### 1.3 Routes + auth + envelope (reuse; do not hand-roll)
- `src/server/utils/apiResponse.ts` — `ok(res, data)` / `fail(res, status, code, message, extra?)`. All new
  handlers use these. `code` is SCREAMING_SNAKE; reuse existing codes where they fit.
- `src/server/auth/authMiddleware.ts` — `requirePermission('sources','read'|'write', { sourceIdFrom: 'params.id' })`
  and `optionalAuth()`. Status/read polling uses `optionalAuth()` (mirror the meshcore/source status route);
  writes use `requirePermission(...,'write', { sourceIdFrom: 'params.id' })`.
- `src/server/routes/meshcoreRoutes.ts` — the nested-router pattern to copy: `Router({ mergeParams: true })`,
  a guard middleware run first that resolves the manager into `res.locals`, then sub-routers `router.use(...)`.
  Mounted in `src/server/server.ts` at `apiRouter.use('/sources/:id/meshcore', meshcoreRoutes)` (line ~716).
- `src/server/routes/sourceRoutes.ts` — generic source lifecycle (create/update/connect/disconnect/delete).
  The `meshcore` branches here are the exact lifecycle points to mirror (see §3.5).
- `src/server/test-helpers/routeTestApp.ts` — `createRouteTestApp({ mount })` real-middleware harness.
  All new/changed route tests use it (CLAUDE.md hard rule).

### 1.4 Frontend touchpoints — NOT in Phase 1a
`SourceContext.tsx`, `DashboardPage.tsx`, `nodeTypeCategory.ts`, `main.tsx`, `DashboardSidebar`, `SearchModal`
all carry per-type conditionals. **Do not touch them in 1a** (Phase 1b). Note: `SourceContext.tsx:16` is a
JSDoc comment, not a type union; only the backend union in `sources.ts` changes in 1a (§3.3).

---

## 2. Corrections to the stale specs (numbers, paths, symbols)

| Item | Stale value (epic / research / absent 2026-08-04 spec) | Corrected value (verified now) |
|---|---|---|
| `reticulum_destinations` migration number | **135** (epic) | **140** — 135 is `backfill_meshcore_nodes_viewonmap` (taken) |
| `reticulum_interfaces` migration number | **136** (epic) | **141** — 136 is `add_meshcore_observer_credentials` (taken) |
| Current max migration | (assumed ~134) | **139** (`139_automation_home_anchors`); registry count == 139 |
| Migration count test edit | — | **None** — `migrations.test.ts` is registry-derived |
| Manager registry | "own `ReticulumManagerRegistry`" / "`MeshCoreManagerRegistry`" (research §4) | Unified `sourceManagerRegistry` + `ISourceManager`; MeshCore already migrated to it |
| Config mapper source file | `meshcoreRegistry.ts` (research) | `meshcoreConfig.ts` (registry file deprecated; config helpers extracted) |
| `Source['type']` union location | `sources.ts:14` (+ SourceContext:16, DashboardPage:127) | `src/db/repositories/sources.ts:14` is the **only** 1a change; SourceContext:16 is a comment; DashboardPage unions are frontend/1b |
| 1a table names | research: `reticulum_announces`, `reticulum_messages`, `reticulum_interfaces_stats`, `reticulum_paths` | epic (authoritative): **`reticulum_destinations`** + **`reticulum_interfaces`**. Messages = Phase 2, paths = Phase 4 |
| `ISourceManager` member count | "8 members" (epic) | **Confirmed 8** (see §3.4) |
| RNS pip version | 1.3.6 / June 2026 (research) | verify against current `rns` on pip during WP0; pin in `bridge/requirements.txt` |
| Disconnect semantics | MeshCore keeps manager registered | **Reticulum removes** manager on disconnect (epic); read routes must tolerate absence (§3.5) |

---

## 3. File-by-file changes

### 3.1 DB migrations (all three backends, idempotent, `settingsKey`, registered)

Create both files under `src/server/migrations/`, register both in `src/db/migrations.ts` immediately after
migration 139. Use the `/migration` skill to scaffold; follow `139_automation_home_anchors.ts` as the template
(SQLite `export const migration = { up, down }`; `runMigrationNNNPostgres(client)`; `runMigrationNNNMysql(pool)`
with `createTableIfMissingMysql` + `createIndexIfMissingMysql`).

#### Migration 140 — `reticulum_destinations` (`settingsKey: 'migration_140_create_reticulum_destinations'`)
Row per announced destination hash. **Phase 1a = destinations MINUS position/telemetry columns** (those are
Phase 3). Columns (sqlite types shown; PG `TEXT`/`BIGINT`/`DOUBLE PRECISION`/`BOOLEAN`, MySQL `VARCHAR`/`BIGINT`/`TINYINT`):

| column | sqlite | notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | PG `SERIAL`, MySQL `INT AUTO_INCREMENT` |
| `sourceId` | TEXT NOT NULL | per-source scope — MANDATORY |
| `destinationHash` | TEXT NOT NULL | 16-byte hash, hex (32 chars) |
| `identityHash` | TEXT | owning identity hash if known, else NULL |
| `appName` | TEXT | e.g. `lxmf.delivery`, `nomadnetwork.node` |
| `aspects` | TEXT | full aspect path when available |
| `displayName` | TEXT | decoded from announce app_data |
| `appDataB64` | TEXT | raw app_data (base64) for later decode; nullable |
| `hops` | INTEGER | last-known hop count, nullable |
| `nextHopInterface` | TEXT | interface name of next hop, nullable |
| `rssi` | INTEGER | per-packet RSSI on last announce, nullable (available in attach mode, design §8.1.1) |
| `snr` | REAL | per-packet SNR, nullable. PG `DOUBLE PRECISION`, MySQL `DOUBLE` |
| `quality` | INTEGER | normalised link quality `q`, nullable |
| `announceCount` | INTEGER NOT NULL DEFAULT 0 | |
| `firstSeen` | INTEGER NOT NULL | epoch ms |
| `lastSeen` | INTEGER NOT NULL | epoch ms |
| `lastAnnounceAt` | INTEGER | epoch ms of last announce |
| `isFavorite` | INTEGER NOT NULL DEFAULT 0 | boolean; PG BOOLEAN, MySQL TINYINT(1) |
| `createdAt` | INTEGER NOT NULL | |
| `updatedAt` | INTEGER NOT NULL | |

Indexes: `UNIQUE (sourceId, destinationHash)` (upsert key); non-unique `(sourceId, lastSeen)` for list ordering.
**Signal columns `rssi`/`snr`/`quality` ARE in Phase 1a**, per-packet RSSI/SNR/quality is available in attach mode (design §8.1.1) and is a core Destinations-view column (attach spec §7). Populate them from the announce event.
**Excluded (Phase 3, position only):** `latitude`, `longitude`, `altitude`, `speed`, `bearing`, `accuracy`, `positionUpdatedAt`.

**Retention (Phase 1a, day-one requirement, attach spec §11 risk 4):** a busy mesh can push thousands of destinations. Add setting `reticulum_destinations_max` (default `2000`), **register it in `src/server/constants/settings.ts` `VALID_SETTINGS_KEYS`** (CLAUDE.md hard rule: unregistered keys silently fail to save). In `upsertDestination`, after insert, prune oldest-by-`lastSeen` beyond the cap (skip favorites). Cover with a WP1 test.

#### Migration 141 — `reticulum_interfaces` (`settingsKey: 'migration_141_create_reticulum_interfaces'`)
Row per RNS interface (current snapshot / inventory — the `rnstatus` view). **Phase 1a = interfaces MINUS
LoRa-parameter columns** (frequency/bandwidth/SF/CR/txPower/airtime → Phase 3 own-mode radio config).

| column | sqlite | notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `sourceId` | TEXT NOT NULL | per-source scope — MANDATORY |
| `interfaceName` | TEXT NOT NULL | RNS interface display name |
| `interfaceType` | TEXT | class name: `TCPClientInterface`, `RNodeInterface`, `AutoInterface`, … |
| `interfaceHash` | TEXT | RNS interface hash if exposed, nullable |
| `mode` | TEXT | RNS interface mode (full/access-point/etc), nullable |
| `status` | TEXT NOT NULL | `up` / `down` |
| `online` | INTEGER NOT NULL DEFAULT 0 | boolean |
| `bitrate` | INTEGER | bits/sec, nullable |
| `txBytes` | INTEGER NOT NULL DEFAULT 0 | BIGINT on PG/MySQL |
| `rxBytes` | INTEGER NOT NULL DEFAULT 0 | BIGINT on PG/MySQL |
| `lastSeenAt` | INTEGER NOT NULL | epoch ms of last poll |
| `createdAt` | INTEGER NOT NULL | |
| `updatedAt` | INTEGER NOT NULL | |

Index: `UNIQUE (sourceId, interfaceName)`.
**Excluded (Phase 3):** `frequency`, `bandwidth`, `spreadingFactor`, `codingRate`, `txPower`, `channelUtil`, `airtimeShort/Long`.

Add a `*.test.ts` beside each migration (mirror `139_automation_home_anchors.test.ts`) and a
`*.pgmysql.test.ts` (mirror `131_seed_per_source_node_display.pgmysql.test.ts`) that runs against PG+MySQL containers.

### 3.2 Drizzle schema + repository
- **Create `src/db/schema/reticulum.ts`** — sqlite/postgres/mysql table definitions for both tables, matching
  the migration DDL exactly. Register in the schema barrel and the driver `tables` maps (mirror how
  `atak_contacts`/`meshcore_*` schema is wired). Without this the repository cannot query the tables.
- **Create `src/db/repositories/reticulum.ts`** — `ReticulumRepository extends BaseRepository`, all methods
  `sourceId`-scoped via `withSourceScope`:
  - `upsertDestination(sourceId, dest)` — insert-or-update on `(sourceId, destinationHash)`, bumps `announceCount`, `lastSeen`, `lastAnnounceAt`.
  - `listDestinations(sourceId, opts?)` — ordered by `lastSeen` desc; optional favorite/app filter.
  - `getDestination(sourceId, destinationHash)`.
  - `setDestinationFavorite(sourceId, destinationHash, favorite)`.
  - `upsertInterface(sourceId, iface)` — insert-or-update on `(sourceId, interfaceName)`.
  - `listInterfaces(sourceId)`.
  - `getInterface(sourceId, interfaceName)`.
  - Wire into `src/services/database.ts` facade (`databaseService.reticulum`).
- **Interface history**: served from the shared `telemetry` table (§7 risk 1, RESOLVED, no enforced FK). The
  interface poller writes throughput samples via `databaseService.telemetry.insertTelemetryBatch(rows, sourceId)`
  with `telemetryType` values like `reticulum_iface_tx_rate` / `reticulum_iface_rx_rate`, `nodeId =
  'rns:iface:<interfaceName>'`, and a **stable derived `nodeNum`** = crc32 of `if:<interfaceName>` (mirror
  MeshCore's `nodeNumFromPubkey` in `meshcoreTelemetryPo*`). WP1 keeps an insert-and-read-back regression test
  on all three backends; the shared-table decision is locked (no fallback table).

### 3.3 `Source['type']` union
- `src/db/repositories/sources.ts:14` — change the union to include `'reticulum'`:
  `type: 'meshtastic_tcp' | 'mqtt_broker' | 'mqtt_bridge' | 'meshcore' | 'reticulum';`
- Run `npm run typecheck` immediately: adding a union member can surface non-exhaustive `switch`/`never`
  assertions elsewhere. Handle any fallout with an explicit branch or default (do **not** touch frontend
  unions — those are 1b). `isMqttSourceType()` in the same file is unaffected.

### 3.4 `ISourceManager` — the 8 members `ReticulumManager` must implement
Confirmed current interface (`sourceManagerRegistry.ts`):
```
readonly sourceId: string;
readonly sourceType: Source['type'];        // getter returning 'reticulum'
start(): Promise<void>;
stop(): Promise<void>;
getStatus(): SourceStatus;                   // { sourceId, sourceName, sourceType, connected, nodeNum?, nodeId? }
getLocalNodeInfo(): {...} | null;            // return null in 1a (mirror MeshCore)
startDistanceDeleteScheduler(): Promise<void>;  // no-op in 1a (no positions yet) — comment "positions arrive Phase 3"
stopDistanceDeleteScheduler(): void;            // no-op
```

### 3.5 New backend modules (Node side)
- **`src/server/reticulumConfig.ts`** (mirror `meshcoreConfig.ts`):
  - `interface ReticulumSourceConfig { mode: 'attach' | 'tcp_peer'; bridgeUrl?: string; token?: string;
    autoConnect?: boolean; configDir?: string; /* attach */ peers?: {host:string;port:number}[]; /* tcp_peer */ }`
  - `reticulumConfigFromSource(source): ReticulumConfig | null` — returns null when required fields for the
    chosen mode are missing (attach needs `configDir` or a running shared instance; tcp_peer needs ≥1 peer).
    Defaults `bridgeUrl` to `ws://127.0.0.1:<BRIDGE_PORT>` and carries `PROTOCOL_VERSION`.
  - `ensureReticulumManagerStarted(source, cfg)` — create-or-reconnect recipe (mirror
    `ensureMeshCoreManagerStarted`): if no manager, `new ReticulumManager(id,name)` + `configure(cfg)` +
    `registry.addManager(...)`; if present & disconnected, `connect(cfg)`; else skip.
- **`src/server/reticulumBridgeClient.ts`** — typed WebSocket client to the Python bridge. `EventEmitter`.
  Responsibilities: connect to `bridgeUrl`; perform the `hello`/`welcome` handshake with `token` +
  `PROTOCOL_VERSION`; send `configure` (mode + params); emit typed events (`announce`, `interface_stats`,
  `status`, `error`, `close`); request/response with correlation `id`; heartbeat ping/pong; bounded
  exponential-backoff reconnect. Decodes/validates the wire envelope (§4). No RNS knowledge — pure transport.
- **`src/server/reticulumManager.ts`** — `class ReticulumManager extends EventEmitter implements ISourceManager`.
  Owns one `ReticulumBridgeClient`. On `announce` → `databaseService.reticulum.upsertDestination(...)`.
  On `interface_stats` → `upsertInterface(...)` (snapshot) + `insertTelemetryBatch(...)` (history). Tracks
  `connected` for `getStatus()`. `getLocalNodeInfo()` → `null`. Distance schedulers → no-op. `isConnected()`
  helper for routes. Constructor `(sourceId, sourceName?)`; `configure(cfg)`; `connect(cfg)`; `disconnect()`.
- **`src/server/sourceManagerTypes.ts`** — add:
  ```
  export function isReticulumManager(m: ISourceManager): m is ReticulumManager {
    return m.sourceType === 'reticulum';
  }
  ```
  (type-only import of `ReticulumManager` to avoid import cycles, same pattern as the existing guards).

### 3.6 Lifecycle wiring (mirror every `meshcore` branch)
- **`src/server/bootstrapSources.ts`** — add `if (source.type === 'reticulum') { ... ensureReticulumManagerStarted ... }`
  branch alongside the meshcore branch (respect `autoConnect`, `try/catch` continue-on-error). Update the
  source-sort tier comment/logic so `reticulum` sits in the same tier as `meshtastic_tcp`/`meshcore` (tier 1).
- **`src/server/routes/sourceRoutes.ts`** — mirror the meshcore branches at each lifecycle point:
  - `POST /` (create, ~line 609): add `'reticulum'` to the allowed-type list and the auto-connect branch.
  - `PUT /:id` (update, ~lines 837–1090): enable→start, disable→remove, config-change→reconfigure,
    autoConnect on/off transitions — mirror the meshcore else-if ladder.
  - `POST /:id/connect` (~line 1461): add `'reticulum'` to the allowed-types guard (currently
    `meshtastic_tcp`/`meshcore` only) and a reticulum branch (create-or-reconnect via `ensureReticulumManagerStarted`).
  - `POST /:id/disconnect` (~line 1507): add a reticulum branch that **`removeManager(source.id)`** (NOT the
    meshcore keep-registered behavior). Because the manager is removed, `/reticulum/*` read routes must not
    depend on a live manager (they read from the DB) and `/reticulum/status` returns `{connected:false}` when
    absent — see §3.7.
  - `DELETE /:id`: no reticulum-specific branch needed — the generic `removeManager(req.params.id)` already covers it.
- **`src/server/server.ts`** — import `reticulumRoutes` and mount:
  `apiRouter.use('/sources/:id/reticulum', reticulumRoutes)` (beside the meshcore mount ~line 716). No
  `refreshReceiveOnly`-style special-casing needed.

### 3.7 Routes — `src/server/routes/reticulumRoutes.ts`
Nested `Router({ mergeParams: true })` mounted at `/api/sources/:id/reticulum`. A guard middleware runs first
and resolves `sourceManagerRegistry.getManager(id)` narrowed by `isReticulumManager` into
`res.locals.reticulumManager` — but, unlike the meshcore guard, it **must not 404 when absent** for read
endpoints (the manager is removed on disconnect); it sets `res.locals.reticulumManager = undefined` and lets
handlers respond from the DB. All handlers use `ok()`/`fail()` and `requirePermission`/`optionalAuth` with
`{ sourceIdFrom: 'params.id' }`.

| Method + path | Auth | Behavior |
|---|---|---|
| `GET /status` | `optionalAuth()` | `{ connected, mode, bridgeVersion?, rnsVersion?, interfaceCount, destinationCount }`; `connected:false` when no manager |
| `GET /destinations` | `requirePermission('sources','read',{sourceIdFrom:'params.id'})` | `listDestinations(sourceId, filters)` |
| `GET /destinations/:hash` | read | `getDestination` or `fail(res,404,'DESTINATION_NOT_FOUND',...)` |
| `POST /destinations/:hash/favorite` | write | body `{ favorite:boolean }` → `setDestinationFavorite` |
| `GET /interfaces` | read | `listInterfaces(sourceId)` |
| `GET /interfaces/:name/history` | read | throughput series from shared `telemetry` (query by synthetic nodeId + telemetryType, sourceId-scoped) |

`connect`/`disconnect` are the generic `sourceRoutes` handlers (§3.6), satisfying the epic's
"status/connect/disconnect" under the source. (Optionally add thin `/reticulum/connect` + `/reticulum/disconnect`
that delegate, if the frontend in 1b prefers namespaced calls — not required for 1a.)

---

## 4. Bridge spec (`bridge/`)

### 4.1 Module layout
```
bridge/
  requirements.txt            # rns==<pinned>, websockets>=13 (sync server). lxmf added in Phase 2.
  Dockerfile                  # FROM python:3.12-alpine
  NOTICE                      # RNS non-OSI license disclosure (mandatory)
  README.md                   # run + rpc_key troubleshooting (minimal in 1a)
  meshmonitor_rns_bridge/
    __init__.py
    __main__.py               # entrypoint: parse env, start ws server, block
    config.py                 # env: BRIDGE_HOST, BRIDGE_PORT, BRIDGE_TOKEN, RNS_CONFIG_DIR,
                              #      RNS_MODE(attach|tcp_peer), RNS_TCP_PEERS, PROTOCOL_VERSION
    protocol.py               # PROTOCOL_VERSION=1, message-type + failure-code constants, encode/decode
    rns_manager.py            # Reticulum init per mode, AnnounceHandler, interface enumeration, path read
    ws_server.py              # websockets.sync.server.serve, handshake, token auth, dispatch
    pollers.py                # interface-stats poller + path-table poller (daemon threads)
  tests/
    test_protocol.py          # unit
    fixtures/                 # golden JSON emitted by the bridge (announce, interface_stats, welcome, error)
    conftest.py
    integration/
      test_dual_rnsd.py       # two rnsd over TCPServerInterface (CI, python job)
```

### 4.2 Threading model (no asyncio)
- **Main thread**: initializes `RNS.Reticulum(configdir=...)`, registers an `RNS.Transport`
  announce handler, then blocks on the ws server.
- **WS server thread(s)**: `websockets.sync.server.serve(handler, host, port)`; a single Node client at a
  time. The handler runs the handshake, then loops reading requests and draining an outbound `queue.Queue`.
- **Poller threads** (daemon): `interface_stats` (every N s, default 5) reads `RNS.Transport.interfaces` /
  `Reticulum` interface list → enqueues `interface_stats`. `path_table` (every M s, default 15) reads the
  path table → enqueues `path_table` (Node logs/ignores in 1a; persisted in Phase 4).
- **Announce handler**: RNS callback thread → enqueues `announce`. All cross-thread handoff via a single
  thread-safe outbound `queue.Queue`; the ws writer thread owns the socket.

### 4.3 Connection modes
- **`attach`**: connect to an **existing** `rnsd`/shared instance using `RNS.Reticulum(configdir=RNS_CONFIG_DIR)`
  as a non-transport shared-instance client. Requires a readable config dir and a matching `rpc_key`.
  Failure codes: `CONFIGDIR_UNREADABLE`, `NO_SHARED_INSTANCE` (no running rnsd to attach to),
  `RPC_AUTH_FAILED` (wrong/absent `rpc_key`).
- **`tcp_peer`**: run the bridge's **own** RNS instance with one or more `TCPClientInterface` peers (join a
  network over TCP without a local rnsd). Failure codes: `TCP_PEER_UNREACHABLE`, `RNS_INIT_FAILED`.

### 4.4 Wire protocol v1 (JSON over WS)
Envelope: `{ "v": 1, "type": <string>, "id"?: <string>, "ts": <epoch_ms>, ... }`.
- Handshake: Node→`{type:"hello", protocolVersion:1, token:"<BRIDGE_TOKEN>"}`;
  bridge→`{type:"welcome", protocolVersion:1, bridgeVersion, rnsVersion}` **or**
  `{type:"error", code:"PROTOCOL_VERSION_MISMATCH"|"AUTH_FAILED"}` then close.
- Configure: Node→`{type:"configure", mode, configDir?, peers?}`; bridge→`{type:"ready"}` or
  `{type:"error", code:<failure code from §4.3>}`.
- Bridge→Node events: `announce` `{destinationHash, identityHash?, appName?, aspects?, displayName?,
  appDataB64?, hops?, nextHopInterface?, rssi?, snr?, q?, isPathResponse?}`; `interface_stats`
  `{interfaces:[{name,type,hash?,mode?,status,online,bitrate?,txBytes,rxBytes}]}`; `path_table`
  `{paths:[...]}` (1a: informational).

**Announce enrichment (bridge side, load-bearing, from attach spec §4.6; do not skip):**
1. Set `receive_path_responses = True` on the announce handler, otherwise a quiet node vanishes from the
   list until its next announce. Set `isPathResponse` on the emitted event accordingly.
2. Key `get_packet_rssi/snr/q()` off the `announce_packet_hash` handler arg to populate `rssi/snr/q`.
3. Prefer the RPC path-table hop count over local `RNS.Transport.hops_to()`, a shared-instance client's
   local hop count can be off by one (design §8.1.1 caveat).
4. Parse `lxmf.delivery` app_data for the display name **defensively**, and ALWAYS carry `appDataB64` so
   Node can re-parse later without a bridge change. Split `appName`/`aspects` from the destination.
- Node→bridge requests: `{type:"get_status", id}` → `{type:"status", id, mode, interfaceCount, ...}`.
- Keepalive: WS ping/pong (native).
**Failure code set (documented in `protocol.py`):** `PROTOCOL_VERSION_MISMATCH`, `AUTH_FAILED`,
`CONFIGDIR_UNREADABLE`, `NO_SHARED_INSTANCE`, `RPC_AUTH_FAILED`, `TCP_PEER_UNREACHABLE`, `RNS_INIT_FAILED`,
`BRIDGE_UNREACHABLE` (Node-side, socket never opened).

### 4.5 License posture (hard rule)
RNS/LXMF carry the non-OSI Reticulum License; MeshMonitor is BSD-3. **RNS ships ONLY in this sidecar image.**
Never add `rns`/`lxmf` to the main `node:24` image or `package.json`. Include `bridge/NOTICE` stating the
license plainly.

---

## 5. Test plan (standard Vitest suite — never standalone scripts)

TypeScript (Vitest), all under `src/**`:
- `src/server/migrations/140_create_reticulum_destinations.test.ts` + `.pgmysql.test.ts`
- `src/server/migrations/141_create_reticulum_interfaces.test.ts` + `.pgmysql.test.ts`
  (mirror 131/139 tests; assert idempotency by running `up` twice; PG+MySQL container variants).
- `src/db/repositories/reticulum.perSource.test.ts` — **source isolation**: two sources, upsert
  destinations/interfaces into each, assert `list*` never leaks across `sourceId`.
- `src/server/reticulumConfig.test.ts` — `reticulumConfigFromSource` valid/invalid per mode; null on incomplete.
- `src/server/reticulumBridgeClient.test.ts` — handshake success; `AUTH_FAILED`; `PROTOCOL_VERSION_MISMATCH`;
  reconnect/backoff; **contract parse** of `bridge/tests/fixtures/*.json` (golden emitted by Python, parsed by TS).
- `src/server/reticulumManager.test.ts` — announce→destination upsert; interface_stats→interface upsert +
  telemetry history write; `getStatus()` connected transitions; `getLocalNodeInfo()===null`; scheduler no-ops.
- `src/server/reticulum.perSource.test.ts` — **manager-level isolation**: two `ReticulumManager`s, events on
  one never write the other's `sourceId`.
- `src/server/sourceManagerTypes.test.ts` — **extend**: add `'reticulum'` to the mutually-exclusive
  `types` array and add an `isReticulumManager` describe block (true for reticulum, false for the other four).
- `src/server/routes/reticulumRoutes.test.ts` — `createRouteTestApp`; status (connected + disconnected),
  destinations list/detail/favorite, interfaces list/history; permission scoping (403 without `sources:read`
  on that source); 404 on unknown destination.
- Extend `src/server/routes/sourceRoutes.*.test.ts` — create/connect/disconnect for a `reticulum` source,
  asserting disconnect **removes** the manager and read routes still serve from DB.

Python (pytest, CI job in the `python:3.12` sidecar image — not part of Vitest):
- `bridge/tests/test_protocol.py` — encode/decode + failure-code round-trips; **regenerate golden fixtures**
  consumed by the TS contract test (both sides assert the same bytes).
- `bridge/tests/integration/test_dual_rnsd.py` — **hardware-free CI harness**: launch two `rnsd` instances
  connected over `TCPServerInterface` on loopback; bridge `attach`es to instance A; announce emitted on B
  flows to the bridge and out the WS. Failure-path cases: (1) `rnsd` absent → `NO_SHARED_INSTANCE`;
  (2) wrong `rpc_key` → `RPC_AUTH_FAILED`; (3) `rnsd` restart mid-session → poller recovers; (4) bridge
  restart → Node client reconnects and re-`configure`s.

Container note: the migration `.pgmysql.test.ts` files require Postgres + MySQL containers up during the run
(same pattern the existing `*.pgmysql.test.ts` suites use); SQLite runs in-process.

---

## 6. Work-package decomposition (one Sonnet agent per WP)

Each WP is sized for a single agent and lists explicit deps + acceptance criteria.

- **WP0 — Spike (GATING, sequential first).** Prove `attach` against a real `rnsd` locally (Docker or venv;
  Python + Docker available). Install `rns` via pip, run an `rnsd`, run a throwaway attach script that prints
  interface stats + at least one announce. **Deliverable:** evidence notes appended to this doc + the pinned
  `rns` version; **no committed production code.** *Accept:* attach observed working; `rns` version pinned;
  the three attach failure codes reproduced (absent rnsd, wrong rpc_key, unreadable configdir). *Deps:* none.

- **WP1, Persistence.** Migrations 140 (destinations, incl. `rssi/snr/quality`) + 141 (interfaces) (+tests,
  +pgmysql tests), `src/db/schema/reticulum.ts`, `ReticulumRepository`, facade wiring,
  `reticulum.perSource.test.ts`. **Destinations retention:** `reticulum_destinations_max` setting registered in
  `VALID_SETTINGS_KEYS`, prune-oldest-by-`lastSeen` in `upsertDestination` (skip favorites), with a test.
  **Interface-history telemetry**: shared-table path with derived per-interface nodeNum (§3.2/§7 risk 1
  locked); keep the all-three-backend insert-and-read-back regression test. *Accept:* Vitest green incl. PG+MySQL
  migration tests; repo isolation test passes; retention test passes; `typecheck` clean. *Deps:* none (parallel
  with WP2).

- **WP2 — Bridge core.** `bridge/` layout (§4): config, protocol, rns_manager (attach+tcp_peer), ws_server,
  pollers, Dockerfile, NOTICE, requirements. pytest unit tests + golden fixtures. *Accept:* `pytest bridge/tests`
  green; fixtures generated; bridge starts and serves a WS handshake locally; both modes reach `ready` against
  a local rnsd (attach) and a local TCP peer (tcp_peer). *Deps:* WP0 gate.

- **WP3 — Bridge client + config (Node).** `reticulumBridgeClient.ts`, `reticulumConfig.ts`, protocol type
  defs, client + config tests (contract parse against WP2 fixtures). *Accept:* client tests green incl.
  handshake/auth/version-mismatch/reconnect and fixture parse. *Deps:* WP2 (for `protocol.py` + fixtures;
  may start against §4.4 in parallel, finalize after WP2).

- **WP4 — Manager + registry.** `reticulumManager.ts` (ISourceManager, 8 members), `isReticulumManager`,
  `sourceManagerTypes.test.ts` extension, manager unit + perSource tests. *Accept:* manager tests green;
  announce/interface persistence verified; guard test green. *Deps:* WP1 (repo) + WP3 (client).

- **WP5 — Lifecycle wiring.** `sources.ts` union (+typecheck fallout), `bootstrapSources.ts` branch,
  `sourceRoutes.ts` create/enable/disable/config/connect/disconnect branches (disconnect→remove), sourceRoutes
  test extensions. *Accept:* `typecheck` clean; sourceRoutes tests green; disconnect removes manager and read
  routes still serve. *Deps:* WP4.

- **WP6 — Reticulum routes.** `reticulumRoutes.ts` (+guard tolerating absent manager), mount in `server.ts`,
  `reticulumRoutes.test.ts`. *Accept:* route tests green incl. permission scoping + disconnected-source status.
  *Deps:* WP1 (repo) + WP4 (manager). Parallel with WP5.

- **WP7 — CI harness + docs.** `bridge/tests/integration/test_dual_rnsd.py` (+4 failure-path cases), CI job
  wiring for the python test in the sidecar image, contract golden cross-check, `bridge/README.md` +
  `bridge/NOTICE`. *Accept:* dual-rnsd integration passes in CI; failure paths asserted; NOTICE present.
  *Deps:* WP2 + WP3. Parallel with WP5/WP6.

**Dependency graph**
```
WP0 ─▶ WP2 ─▶ WP3 ─┬─▶ WP4 ─┬─▶ WP5
WP1 ───────────────┘        └─▶ WP6
WP2 ─┬─▶ WP7
WP3 ─┘
```
Parallelizable: {WP1 ∥ WP2}; after WP4: {WP5 ∥ WP6 ∥ WP7}.

---

## 7. Open risks / CLAUDE-invariant concerns, RESOLVED by orchestrator (2026-08-13)

1. **Interface-history telemetry FK, RESOLVED: use the shared `telemetry` table.** The `.references(() =>
   nodes.nodeNum)` in `src/db/schema/telemetry.ts` is **vestigial**. Migration **041**
   (`drop_legacy_telemetry_nodes_fk`) rebuilt the SQLite `telemetry` table **without** that FK, it became
   structurally invalid once migration 029 moved `nodes` to a composite PK (`foreign key mismatch` on every
   DML). PG/MySQL baselines **never declared it**. So **no backend enforces this FK.** MeshCore already writes
   telemetry rows with a derived nodeNum and no matching `nodes` row for exactly this reason
   (`src/server/services/meshcoreRemoteTelemetryScheduler.ts`, using `nodeNumFromPubkey`).
   **Directive:** the interface poller writes throughput history to the shared `telemetry` table. Derive a
   stable per-interface `nodeNum` (crc32 of `if:<interfaceName>`, mirroring MeshCore's `nodeNumFromPubkey`
   pattern) with `nodeId = 'rns:iface:<interfaceName>'` and `telemetryType` = `reticulum_iface_tx_rate` /
   `reticulum_iface_rx_rate` (extend as needed). No new history table; Dashboard reuse is preserved. WP1 keeps
   the insert-and-read-back test on all three backends as a regression guard, but the decision is locked, do
   **not** build the dedicated-history fallback.

2. **Disconnect-removes-manager, CONFIRMED.** A disconnected Reticulum source still answers read routes from
   persisted rows; `/status` returns `{connected:false}` when the manager is absent. Keep §3.7 exactly as
   written.

3. **Design docs, RESOLVED: both now present on this branch** (`RETICULUM_SOURCE_DESIGN.md`,
   `RETICULUM_ATTACH_PHASE1_SPEC.md`, committed 2026-08-13). This spec has been reconciled against them: signal
   columns (`rssi/snr/quality`) added to `reticulum_destinations` (§3.1); announce-enrichment details folded
   into §4.4; destinations retention added (§3.1). Migration numbers **135/136 in the design docs are
   superseded by 140/141** (they were taken by MeshCore). The wire-protocol envelope here (`{v,type,camelCase}`)
   intentionally supersedes the canonical `{t,snake_case}` sketch, **the golden contract fixtures are the
   single source of truth** so Python and TS cannot drift; the `announce` fixture MUST include `rssi/snr/q`.

4. **`Source['type']` union widening, CONFIRMED.** WP5 runs `npm run typecheck` and resolves non-exhaustive
   switch fallout without touching frontend unions (1b).

5. **RNS license in CI, CONFIRMED.** `rns` ships ONLY in the sidecar image; `bridge/NOTICE` present; never in
   `package.json` or the node image.

6. **Bridge image base, CONFIRMED.** Pin `python:3.12`, pin `rns` to the WP0-verified version. Verify
   `cryptography`/`pyserial` musl wheels on `python:3.12-alpine` during WP2; switch to `python:3.12-slim` if any
   wheel is missing.

7. **CLAUDE.md `.js`-extension rule (implementer reminder).** Relative imports in server-compiled code
   (tsconfig.server.json include set) MUST carry an explicit `.js` extension (#4596), extensionless specifiers
   pass tsx/Vitest/Vite locally but throw `ERR_MODULE_NOT_FOUND` in compiled `dist/`. ESLint-enforced but easy
   to miss in new `src/server/reticulum*.ts` files. Write `import x from './reticulumFoo.js'`.
