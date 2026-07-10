# Source-ID Enforcement Remediation

**Goal:** Every API endpoint that interacts with source-scoped data must **require** an
explicit `sourceId`. When absent, return a clean **HTTP 400** `{ success:false,
error, code:'MISSING_SOURCE_ID' }` — never an uncaught 500, and never a silent
all-sources fallback.

Driven by an audit (2026-07-10) of every handler touching source-scoped data.

## Scope decisions (owner: Randall)

- **Enforce on:** the `THROWS_500` bugs, the `UNSCOPED_BUG` leaks, and the
  **accidental** `SILENT_ALL_SOURCES` sites.
- **v1 legacy mounts:** harden the deprecated non-`/sources/:id` mounts to 400.
- **Device "send-to-device" ops (~18):** require `sourceId` (400), not
  default-to-primary.
- **Leave alone (global-by-design):** `channel_database` PSK store, unified
  aggregators, automations, `estimated_positions`, analysis
  `resolvePermittedSourceIds`, saved-regions, and the **deliberately-aggregate
  legacy list views** (`/api/messages`, `/api/nodes`, `/api/poll`,
  `/api/traceroutes`) that intentionally span sources via `ALL_SOURCES`.

## Foundation (Phase 0)

- Add `requireSourceId(from: 'query'|'body'|'either')` middleware
  (`src/server/utils/requireSourceId.ts`): validates presence + string type,
  emits `fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId is required')`, stashes
  `req.scopedSourceId`. Distinct from `resolveRequestSourceId` (which falls back
  to a default source — keep for the intentionally-lenient endpoints).
- Add optional `requireSourceId: true` to `requirePermission(resource, action,
  opts)` in `authMiddleware.ts` so a missing sourceId 400s centrally instead of
  leaving `scopedSourceId` undefined.
- Unit tests for both.

## Phase 1 — outright bugs + security/data-loss leaks (highest priority)

- [ ] `GET /api/telemetry/:nodeId/smarthops` — always-500 (service drops
      sourceId arg). Require sourceId + fix `getTelemetryByNode` call. (telemetryRoutes.ts:178)
- [ ] `GET /api/telemetry/:nodeId/linkquality` — always-500, same cause. (telemetryRoutes.ts:214)
- [ ] `DELETE /api/nodes/:nodeId/neighbors` — always-500 (handler has no
      sourceId). Thread + require. (server.ts:2047)
- [x] `DELETE /api/telemetry/:nodeId/:telemetryType` — **data-loss**: deletes
      across every source. Require + scope. (telemetryRoutes.ts:248) — PR #4053+1
- [x] `GET /api/channels/:id/export` — **PSK leak** across sources on omitted
      sourceId. Require. (channelRoutes.ts:320) — PR #4053+1
- [ ] `GET /api/v1/.../packets/:id` — cross-source read by id. Scope. (v1/packets.ts:97)
      — **deferred to Phase 4** (needs the v1 attachSource/getScopedSourceId pattern).
- [ ] `POST /api/security/nodes/:nodeNum/clear` — unscoped getNode/upsertNode. (securityRoutes.ts:281)
      — **moves to Phase 2** (security group).

## Phase 2 — accidental SILENT_ALL_SOURCES → 400

- [ ] `GET /api/telemetry/:nodeId` — unify SQLite/PG/MySQL; require. (telemetryRoutes.ts:34)
- [ ] `GET /api/neighborinfo/:nodeNum` — require (sibling `GET /` stays aggregate). (neighborInfoRoutes.ts:61)
- [ ] channel writes: `PUT /:id`, `POST /:slotId/import`, `POST /reorder`,
      `encode-url`, `import-config` — require. (channelRoutes.ts:447/716/837/1013/1094)
- [ ] `GET /api/nodes/:nodeId/position-override` — require (POST/DELETE already 400). (server.ts:1682)
- [ ] `GET /api/security/{issues,export,key-mismatches}` — replace hand-rolled
      ternary with require. (securityRoutes.ts:24/199/336)
- [ ] `GET /api/embed/:profileId/neighborinfo` — `?? ALL_SOURCES` like siblings. (embedPublicRoutes.ts:167)

## Phase 3 — device "send-to-device" ops → require sourceId

- [ ] ~18 `resolveSourceManager`-based ops in server.ts (`/config/*`, several
      `/admin/*`, meshRequest, channel writes) — 400 when omitted.

## Phase 4 — v1 legacy mounts → 400

- [ ] Harden the deprecated non-`/sources/:id` v1 mounts (`v1/index.ts:140-147`)
      and their handlers: messages/:id, telemetry count + `?type=` branch,
      network/direct-neighbors (#2773), messages/search MeshCore branch.

## Other UNSCOPED_BUG (assign a phase)

- [ ] `GET /api/telemetry/direct-neighbors` — cross-source aggregate; #2773. (telemetryRoutes.ts:17)
- [ ] `POST /api/admin/commands` — local-node position upsert mis-scoped to
      'default'. (server.ts:5617/5786)

## Verify facades (audit item E6)

- [ ] `markAllNodesAsWelcomedAsync(null)` (server.ts:4147) and
      `markChannelMessagesAsReadAsync(..., undefined)` (server.ts:2518) — confirm
      repo write scopes or throws; don't leave null-scoped writes.

## Testing

- Route tests via `createRouteTestApp()` harness; assert 400 `MISSING_SOURCE_ID`
  when sourceId omitted and correct scoping when present. Cover all 3 backends
  for the repo-level data-loss/leak fixes.
- Update `tests/api-exercise-test.sh` expectations once endpoints 400 instead of
  200-without-scope (coordinate with PR #4052's test scoping).
