# MeshMonitor 4.0: Multi-Source Architecture

## Context

MeshMonitor currently manages a single Meshtastic node via TCP. Users want to monitor multiple nodes and MQTT feeds from one instance. This requires transforming the singleton-based architecture into a multi-source platform where each source (TCP node, MQTT broker, MeshCore device) has its own isolated data, settings, automations, and permissions. This is a v4.0 effort on a `feature/4.0` branch.

## Current Architecture (Problems to Solve)

- **`meshtasticManager`** is a singleton (11,786 lines) with hardcoded transport creation
- **`databaseService`** is a singleton (10,411 lines) with no source scoping on any table
- **Settings** are a flat global key-value store — no per-source isolation
- **Permissions** are resource-based only — no source scoping
- **WebSocket** broadcasts all events to all clients — no filtering
- **Frontend** assumes one data source throughout all contexts and API calls

## Architecture Overview

### Source Model

New `sources` table in the existing database:

```
sources (
  id TEXT PRIMARY KEY,        -- UUID
  name TEXT NOT NULL,         -- "Home Node", "MQTT Feed"
  type TEXT NOT NULL,         -- 'meshtastic_tcp' | 'mqtt' | 'meshcore'
  config TEXT NOT NULL,       -- JSON: {host, port} or {brokerUrl, topic, username, password}
  enabled INTEGER DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER,
  created_by INTEGER REFERENCES users(id)
)
```

New files: `src/db/schema/sources.ts`, `src/db/repositories/sources.ts`, `src/server/routes/sourceRoutes.ts`

### Manager Registry (replaces singletons)

```
src/server/sourceManagerRegistry.ts     -- Map<sourceId, SourceManager>
src/server/transports/transport.ts      -- ITransport interface
src/server/transports/tcpTransport.ts   -- Existing, implements ITransport
src/server/transports/mqttTransport.ts  -- New, implements ITransport
```

`MeshtasticManager` constructor gains `sourceId` + injected `ITransport`. No more `export default new MeshtasticManager()`. The registry creates/destroys managers based on source configuration.

### Database Scoping

Add `source_id TEXT` column (nullable, NULL = legacy default) to all data tables: `nodes`, `messages`, `telemetry`, `traceroutes`, `channels`, `neighbors`, `packet_log`, `ignored_nodes`, `channel_database`. NOT on auth tables (`users`, `permissions`, `sessions`).

All repository methods gain an optional `sourceId` parameter. A `withSourceScope(sourceId)` helper on BaseRepository adds the WHERE clause.

### Permission Model

Add `source_id TEXT` (nullable) to `permissions` table. Unique constraint becomes `(user_id, resource, source_id)`. NULL source_id = global (all sources). Check logic: source-specific permission first, fall back to global.

New resource type: `'sources'` for managing source CRUD.

### Settings Scoping

Phase 1: Key namespacing — `source:{sourceId}:{key}` for per-source, plain `{key}` for global. Zero schema changes. Repository helpers: `getSourceSetting(sourceId, key)`, `setSourceSetting(sourceId, key, value)`.

Global settings: theme, units, date/time format, map tileset.
Per-source settings: traceroute config, automations, notification preferences, max node age.

### Frontend Architecture

Three-level navigation with React Router:

```
/                              → SourceListPage (cards with mini-dashboards)
/unified/messages              → Unified Messages view (combined feed across all accessible sources)
/unified/telemetry             → Unified Telemetry view (combined feed across all accessible sources)
/analysis                      → Analysis workspace (coming soon — future MeshManager migration)
/source/:sourceId              → Redirect to /source/:sourceId/dashboard
/source/:sourceId/:tab         → Existing App wrapped in SourceProvider
```

**Source List Page** includes:
- Source cards with mini-dashboards (connection status, node count, last activity)
- **Unified View** links: combined Messages and Telemetry feeds across all sources the user has access to. Each item is tagged with its source for context.
- **Analysis** section (placeholder/coming soon): future home for MeshManager analysis features (network health, coverage maps, historical trends)
- Admin: "Add Source" button

**Unified Views** query all sources the user has read permission for, merge results by timestamp, and tag each entry with its source name/color. WebSocket subscriptions join rooms for all accessible sources simultaneously.

**Analysis Workspace** is a top-level section (not per-source) for cross-source analytics. Initially a "coming soon" placeholder. Future MeshManager features (network topology analysis, coverage mapping, historical trends) will land here.

New `SourceContext` provides `sourceId` to all child components. API calls include sourceId: `GET /api/sources/:sourceId/nodes`. TanStack Query keys include sourceId: `['poll', sourceId]`. Single-source deployments auto-redirect past the source list.

### Unified Views API

Cross-source endpoints for the unified views:

```
GET /api/unified/messages?limit=50    → Messages from all accessible sources, merged by timestamp
GET /api/unified/telemetry?hours=24   → Telemetry from all accessible sources, merged by timestamp
```

Each response item includes `sourceId` and `sourceName` fields. The server filters to sources the authenticated user has `messages:read` or `telemetry:read` permission for. Pagination works across the merged set.

### WebSocket Multiplexing

Socket.io rooms per source. Client joins `source:{sourceId}` on navigation. Server emits events to the room. Source list page and unified views join rooms for all accessible sources simultaneously. A lightweight `source:all:status` room carries connection status updates only.

### v3 → v4 Migration

Additive migrations only (safe to rollback):
1. Create `sources` table
2. Add `source_id` columns to data tables
3. Add `source_id` to permissions table
4. On first startup: if `MESHTASTIC_NODE_IP` env var is set and `sources` table is empty, auto-create a "Default" source and assign all NULL `source_id` rows to it

## Implementation Phases

### Phase 1: Foundation
- `feature/4.0` branch
- `ITransport` interface, refactor `TcpTransport`
- `sources` table + CRUD API
- `SourceManagerRegistry` (wraps existing singleton initially)
- `MeshtasticManager` accepts `sourceId` + `ITransport` via constructor
- Auto-create default source from env vars
- **Tests pass, single-node behavior unchanged**

### Phase 2: Database Scoping
- Add `source_id` columns via migration
- `BaseRepository.withSourceScope()` helper
- All repository methods accept `sourceId`
- Assign existing data to default source
- **Tests pass, single-node behavior unchanged**

### Phase 3: Multi-Manager Backend
- Remove singleton export from `meshtasticManager.ts`
- `server.ts` reads sources from DB, creates managers via registry
- Source CRUD triggers manager start/stop
- `dataEventEmitter` includes sourceId in events
- Socket.io room-based multiplexing
- API routes gain `/sources/:sourceId/` prefix (old routes = default source)

### Phase 4: Frontend Multi-Source
- React Router for three-level navigation
- `SourceListPage` with source cards + unified view links + analysis placeholder
- `SourceProvider` context
- API service includes sourceId
- WebSocket room join/leave
- Source management admin UI
- Unified Messages view (cross-source, merged by timestamp, source-tagged)
- Unified Telemetry view (cross-source, merged by timestamp, source-tagged)
- Analysis page (coming soon placeholder)

### Phase 5: MQTT + Settings
- `MqttTransport` (uses `mqtt` npm package, receives `ServiceEnvelope` protobufs)
- Per-source settings UI (source vs global tabs)
- Per-source permission management UI

### Phase 6: MeshCore + Polish
- Wrap `MeshCoreManager` as `MeshCoreSourceManager`
- End-to-end multi-source testing
- v3 → v4 migration testing
- Performance testing (N sources concurrently)

## Verification

Each phase should be verified by:
1. `npx tsc --noEmit` — type check
2. `./node_modules/.bin/vitest run` — unit tests pass
3. `./tests/system-tests.sh` — system tests pass (single-source backward compat)
4. Manual testing with dev container (add/remove sources, verify isolation)

Phase 3+ additionally:
5. Run 2+ sources simultaneously, verify data isolation
6. Verify per-source permissions prevent cross-source access
7. Verify WebSocket events only reach subscribed clients

## Key Files to Modify

| File | Change |
|------|--------|
| `src/server/meshtasticManager.ts` | Accept sourceId + ITransport, remove singleton export |
| `src/services/database.ts` | Source-scoped query methods |
| `src/server/server.ts` | Use SourceManagerRegistry instead of singleton |
| `src/server/tcpTransport.ts` | Implement ITransport interface |
| `src/server/services/webSocketService.ts` | Room-based per-source events |
| `src/server/services/dataEventEmitter.ts` | Include sourceId in all events |
| `src/main.tsx` | Add React Router |
| `src/App.tsx` | Wrap in SourceProvider, extract to reusable component |
| `src/hooks/usePoll.ts` | Include sourceId in query keys |
| `src/hooks/useWebSocket.ts` | Join/leave source rooms |
| `src/services/api.ts` | Include sourceId in all data requests |

## New Files to Create

| File | Purpose |
|------|---------|
| `src/server/sourceManagerRegistry.ts` | Factory + lifecycle for source managers |
| `src/server/transports/transport.ts` | ITransport interface |
| `src/server/transports/mqttTransport.ts` | MQTT transport implementation |
| `src/db/schema/sources.ts` | Sources table schema |
| `src/db/repositories/sources.ts` | Sources CRUD |
| `src/server/routes/sourceRoutes.ts` | Source management API |
| `src/server/migrations/020_create_sources.ts` | Migration |
| `src/server/migrations/021_add_source_id_columns.ts` | Migration |
| `src/server/migrations/022_add_source_id_to_permissions.ts` | Migration |
| `src/contexts/SourceContext.tsx` | Source provider for frontend |
| `src/pages/SourceListPage.tsx` | Multi-source landing page with unified view links |
| `src/pages/UnifiedMessagesPage.tsx` | Cross-source combined message feed |
| `src/pages/UnifiedTelemetryPage.tsx` | Cross-source combined telemetry feed |
| `src/pages/AnalysisPage.tsx` | Analysis workspace (coming soon placeholder, future MeshManager features) |
