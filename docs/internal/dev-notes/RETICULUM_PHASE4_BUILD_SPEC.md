# Reticulum Phase 4 Build Spec, Topology and Remote Monitoring (#3960)

Status: APPROVED for implementers. Worktree: /home/yeraze/Development/meshmonitor-reticulum-4, branch feature/reticulum-phase-4. Wire protocol currently v3; Phase 4 bumps it to v4.

Critical formatting note for whoever edits this file later: keep every identifier, path, table/column name and protocol constant as plain text. Do not add backticks or code fences, they have previously corrupted this file into NUL bytes.

## 0. Orchestrator rulings (RESOLVED, build against these)

- R1 Remote fleet monitoring + rnprobe are CONTRACT/UNIT-ONLY, validated with a mocked RNS instance/adapter plus golden wire fixtures, same precedent as own-mode radio in Phase 3, and consistent with the epic's hardware-free interview decision. Any dual-rnsd integration test is OPTIONAL, hard-timeboxed, and must live under bridge/tests/integration OFF the default suite path. Never let it block CI. The exact RNS remote-management / rnprobe client API surface must be pinned by WP2 against the vendored RNS in the bridge image and hidden behind a small adapter so a mock replaces it in tests.
- R2 CONFIRMED: exactly ONE new table (reticulum_paths). No reticulum_remote_status table. Remote status is an on-demand request/response with no persistence. If persisted fleet history is ever wanted, it rides the shared telemetry table keyed rns:remote:<hash> with zero schema change, explicitly a future stretch, NOT a Phase 4 requirement.
- R3 CONFIRMED: migration number is 146. Verified the current max in src/server/migrations and src/db/migrations.ts is 145. The migration skill updates the registry-derived count test; verify it after scaffolding.
- R4 CONFIRMED: path table write semantics = snapshot replace scoped by sourceId per poll (the bridge emits the whole table each poll). replacePaths must never touch other sources' rows.
- R5 CONFIRMED: the remote allowlist RNS_REMOTE_ALLOWED is sourced from sources.config via reticulumConfig.ts and forwarded to the bridge. The small reticulumConfig.ts config-schema addition is in-scope for Phase 4.

## 1. Reuse inventory (compose, do not reinvent), MANDATORY FIRST SECTION

Everything Phase 4 MUST reuse or extend. New subsystems are justified against the closest existing one.

Bridge (Python), reuse:
- The path-table poll ALREADY EXISTS end-to-end at v3. pollers.py runs a path_table_poller thread (track_health=False) calling RNSManager.refresh_path_table (rns_manager.py ~L1210), which calls self.reticulum.get_path_table(), normalizes rows (destinationHash / via / hops / interface / expires, with a hops_to fallback), caches under _path_table_lock, and broadcasts protocol.path_table_message. protocol.py already defines TYPE_PATH_TABLE, path_table_message() and the path_table.json golden fixture. Phase 4 does NOT rebuild path polling, it only bumps the fixture/protocol to v4 and consumes the event on the Node side.
- protocol.py envelope helpers (envelope(), the server->client and client->server builder blocks), PROTOCOL_VERSION constant, the FAILURE_CODES set, and the OWN_MODE_REQUIRED / *_COMMAND_FAILED typed-error precedent. New probe/remote builders and failure codes go in the same blocks.
- ws_server.py per-command handler pattern (_handle_send_lxmf, _handle_get_radio_config etc.): a handler function that catches typed errors and reports an error frame rather than dropping the connection. New _handle_probe and _handle_get_remote_status follow this exactly.
- rns_manager.py: RNS.Transport.request_path / hops_to (already used), the _guard_not_started poller wrapping, broadcast(), and the RNSStartupError typed-error plumbing. Remote-management and probe methods live here.
- config.py env-var loader (load_config, DEFAULT_PATHS_INTERVAL_S, _parse_* helpers). New remote-management env vars parse here.
- bridge/tests: fixture_builders.py, generate_fixtures.py, conftest.py, and the golden-fixture-per-message-type convention under bridge/tests/fixtures. New probe_result.json, remote_status.json, get_remote_status.json, probe.json fixtures join them; path_table.json / status.json / get_status.json get their v bumped to 4.

Node backend (TypeScript), reuse:
- src/server/reticulumProtocol.ts, the TS mirror of protocol.py. MESSAGE_TYPE already contains PATH_TABLE. Add the new PROBE / PROBE_RESULT / GET_REMOTE_STATUS / REMOTE_STATUS types + envelope decoders here; bump the mirrored PROTOCOL_VERSION to 4. This file is the fixture-drift anchor (its header calls bridge/tests/fixtures the single source of truth).
- src/server/reticulumBridgeClient.ts, pendingRequests map, nextRequestId(), and the generic sendIdCorrelatedRequest<T>() plumbing (used by requestStatus, sendLxmf, getRadioConfig, getDeviceInfo). probe() and getRemoteStatus() are new thin methods over sendIdCorrelatedRequest, do NOT add a second correlation mechanism. Also add a client.on('path_table') passthrough (the client already fans announce / interface_stats / delivery_state up to the manager).
- src/server/reticulumManager.ts, the event-to-repository fan-out (client.on('interface_stats') -> upsertInterface, client.on('announce') -> upsertDestination). Add client.on('path_table') -> databaseService.reticulum.replacePaths. Model the own-mode-gated command wrappers getRadioConfig/getDeviceInfo (L646-680) for the new probe() and getRemoteStatus() manager methods (these are NOT mode-gated, see 3.3/4).
- src/db/repositories/reticulum.ts, the ReticulumRepository, withSourceScope (fail-closed on empty sourceId), normalizeBigInts, the upsertInterface atomic-upsert pattern (onConflictDoUpdate SQLite/PG, onDuplicateKeyUpdate MySQL) and the pruneDestinations delete pattern. New listPaths / replacePaths / (optional getPath) methods reuse all of this.
- src/db/schema/reticulum.ts, the three-backend table-triple convention (sqliteTable / pgTable / mysqlTable with the $inferSelect/$inferInsert type exports). Add the reticulum_paths triple alongside the existing three.
- Migration recipe: migration 143_create_reticulum_messages.ts is the exact template (SQLite db.exec CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS; PostgreSQL runMigrationNNNPostgres; MySQL createTableIfMissingMysql / createIndexIfMissingMysql; LABEL/TABLE constants; PER-SOURCE comment). src/db/migrations.ts registration block. src/cli/migrationTables.ts TABLE_ORDER + SOURCE_SCOPED_TABLES (reticulum_destinations/interfaces/messages already listed, append reticulum_paths in both). The migration skill scaffolds all three backends and the count test.
- src/server/routes/reticulumRoutes.ts, the mounted-under-/api/sources/:id/reticulum guard, ok()/fail() envelope, and requirePermission('nodes','read'|'write',{ sourceIdFrom: 'params.id' }) for source-scoped data (NOT the global sources resource; identical to atakRoutes). The async command-error helper near L416 (maps a ReticulumBridgeError to fail(res, status, err.code)). New /paths, /paths/probe, /remote-status routes reuse these.

Node frontend (React), reuse:
- src/types/reticulum.ts, the server-shape-mirroring convention. Add ReticulumPathRow, ReticulumProbeResult, ReticulumRemoteStatus; extend the ReticulumView union with 'paths'.
- src/components/Reticulum/ReticulumSubToolbar.tsx, the fixed ITEMS list rendered through the shared SourceNav primitive, plus the sourceMode filter precedent (configuration is own-mode-only). Add the paths nav item (NOT mode-gated). UiIcon name from src/components/icons.
- src/components/Reticulum/ReticulumMap.tsx, composes the shared BaseMap + NodeMarkersLayer + createNodeIcon, null-island filtered, with an empty state. The path-graph overlay MUST extend this composition (add a react-leaflet Polyline layer as BaseMap children), NOT introduce a second map component.
- src/components/Reticulum/hooks/useReticulum.ts, the prefix = /api/sources/:id/reticulum + api.get poll loop (POLL_INTERVAL_MS), enabled short-circuit, and the fetchAll fan-out. Extend fetchAll to also fetch /paths; add loadProbe/loadRemoteStatus imperative helpers (on-demand, like loadConversation).
- Existing Reticulum view components (ReticulumInterfacesView.tsx and its.module.css, ReticulumDestinationsView.tsx) are the exact template for the new ReticulumPathsView (table layout, CSS module with semantic --color-* tokens only, inline t(key, fallback) i18n, mono hash styling). ApiService (src/services/api.ts) has NO reticulum-specific methods today, the hook uses api.get directly; keep that convention (no ApiService additions).

New subsystems introduced and their justification:
- reticulum_paths table + ReticulumPathsView: net-new but unavoidable (path topology is a distinct entity; there is no existing table that models next-hop routes). Both follow the destinations/interfaces table + view templates exactly.
- Path-graph overlay: NOT a new component, an extension of ReticulumMap.
- Remote status: NOT a new table and NOT a new manager subsystem, an on-demand request/response over the existing bridge client, surfaced in the paths view (see 3.3).

## 2. Bridge changes (Python)

### 2.A Protocol version bump 3 -> 4 (protocol.py + reticulumProtocol.ts mirror)
- Bump PROTOCOL_VERSION to 4, with a header note mirroring the prior 1->2 / 2->3 rationale: fail-closed strict-equality handshake; Phase 4 adds probe + remote-status command/response pairs. Add matching bump note to reticulumProtocol.ts.
- Add message-type constants: TYPE_PROBE (command, Node->bridge), TYPE_PROBE_RESULT (event/response, bridge->Node), TYPE_GET_REMOTE_STATUS (command, Node->bridge), TYPE_REMOTE_STATUS (response, bridge->Node). The path_table event already exists.
- Add server->client builders probe_result_message(destination_hash, ok, rtt_ms, hops, error=None) and remote_status_message(destination_hash, ok, status, path, error=None). Add client->server reference builders probe_message(destination_hash, timeout_s) and get_remote_status_message(destination_hash) in the client-builders block (used by tests / reference client), matching the existing camelCase-fields convention.

### 2.B probe handler (rnprobe reachability), net-new, all modes
- rns_manager.py: add probe(destination_hash, timeout_s) that resolves the path (RNS.Transport.request_path if unknown, reusing the existing request_path call site), sends an RNS proof-seeking packet to the destination and waits up to timeout_s for the returned proof, then returns a dict { ok, rttMs, hops }. Mirror the utility RNS ships as rnprobe. On no-proof/timeout return { ok: false }. Wrap exceptions as a typed failure (new PROBE_FAILED code) rather than raising through the poller.
- ws_server.py: _handle_probe validates req.destinationHash, calls manager.probe(...), replies with protocol.probe_result_message correlated by req id; on exception emits an error frame with PROBE_FAILED (same pattern as _handle_send_lxmf).
- No mode gate: probe is valid in own / attach / tcp_peer (any mode where the bridge holds a live RNS instance).

### 2.C remote transport-node status handler, net-new, all modes
- config.py: add remote-management config. New env vars: RNS_REMOTE_ALLOWED (comma-separated remote destination hashes we are permitted to query, the fleet allowlist) parsed into a list, and optional RNS_REMOTE_STATUS_INTERVAL_S. Store on BridgeConfig with DEFAULT_REMOTE_STATUS_INTERVAL_S. This is our identity-ACL surface on the querying side; the answering side's allowlist lives in the remote instance's own RNS config, not ours.
- rns_manager.py: add get_remote_status(destination_hash) that issues the RNS remote-management /status and /path requests against the target's rnstransport.remote.management destination over a Link/Request, waits for the response, and returns { ok, status: <interface-stats payload>, path: <remote path table> }. On denial/timeout return { ok: false, error }. Implementer MUST verify the exact RNS remote-management client API against the vendored RNS in the bridge image (import RNS is unavailable in this shell) and pin it behind a small adapter so a mock can replace it in tests.
- ws_server.py: _handle_get_remote_status -> manager.get_remote_status, reply remote_status_message correlated by id; typed error REMOTE_STATUS_FAILED / REMOTE_MANAGEMENT_DENIED on failure.
- Failure codes to add to protocol.py FAILURE_CODES: PROBE_FAILED, REMOTE_STATUS_FAILED, REMOTE_MANAGEMENT_DENIED.

### 2.D Golden fixtures
- Bump v to 4 in the existing path_table.json, status.json, get_status.json (and any other fixtures that carry v). Regenerate via generate_fixtures.py rather than hand-editing where possible.
- Add fixtures: probe.json (command), probe_result.json (event), get_remote_status.json (command), remote_status.json (response). Include one ok:true and one ok:false shape for probe_result and remote_status (either two fixtures or a documented pair) so the Node decoder tests both branches. remote_status.json's status field should be a representative interface-stats payload and path an array of path rows matching the path_table row shape.

### 2.E pytest additions
- test_protocol.py: assert PROTOCOL_VERSION == 4; round-trip the new builders; assert every fixture's v == 4.
- test_ws_server.py: _handle_probe and _handle_get_remote_status happy path (mocked manager) + typed-error path.
- test_rns_manager.py: probe() and get_remote_status() against a mocked RNS instance/adapter (no real networking), ok and failure branches. refresh_path_table already covered; extend only if the row shape changes (it should not).

## 3. Backend changes (Node)

### 3.1 Migration 146_create_reticulum_paths (three backends, idempotent, settingsKey, PER-SOURCE)
Model 143 exactly. Columns (identical across backends, backend-appropriate types):
- id, surrogate PK (SQLite INTEGER PRIMARY KEY AUTOINCREMENT; PostgreSQL INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY; MySQL INT AUTO_INCREMENT PRIMARY KEY), matches the destinations/interfaces surrogate-id convention.
- sourceId, TEXT / TEXT / VARCHAR(191), NOT NULL.
- destinationHash, TEXT / TEXT / VARCHAR(64), NOT NULL.
- viaHash, TEXT / TEXT / VARCHAR(64), nullable (the next hop / via).
- hops, INTEGER / INTEGER / INT, nullable.
- interfaceName, TEXT / TEXT / VARCHAR(191), nullable (via-interface).
- expiresAt, INTEGER / BIGINT / BIGINT, nullable (ms epoch; from the wire expires seconds * 1000).
- updatedAt, INTEGER / BIGINT / BIGINT, NOT NULL (ms epoch, set on write; this is the age source).
Indexes: unique index reticulum_paths_source_dest_idx on (sourceId, destinationHash); secondary index reticulum_paths_source_updated_idx on (sourceId, updatedAt).
Idempotent helpers exactly as 141/143 (SQLite IF NOT EXISTS; PostgreSQL to-regclass/createTableIfMissing helper used in the sibling migrations; MySQL createTableIfMissingMysql / createIndexIfMissingMysql). settingsKey set so completion is recorded. Register in src/db/migrations.ts in the same block as 141-145. The migration skill will also update the migration count test, verify the new expected count.
migrationTables.ts: append 'reticulum_paths' to TABLE_ORDER (right after 'reticulum_messages') and to SOURCE_SCOPED_TABLES.

### 3.2 Schema (src/db/schema/reticulum.ts)
Add the reticulum_paths triple (sqlite/pg/mysql) mirroring the reticulum_interfaces definitions, with the unique index on (sourceId, destinationHash) and the (sourceId, updatedAt) index, plus the six $inferSelect/$inferInsert type exports. Update the file header's "Three tables" note to four. Wire the new tables into whatever tables object ReticulumRepository consumes (the repo reads this.tables.reticulumInterfaces etc.).

### 3.3 Repository (src/db/repositories/reticulum.ts)
- Add exported interface ReticulumPathRow { id?: number; sourceId: string; destinationHash: string; viaHash: string | null; hops: number | null; interfaceName: string | null; expiresAt: number | null; updatedAt: number } and UpsertPathInput.
- replacePaths(sourceId, paths: UpsertPathInput[]): Promise<void>, the path table is a full snapshot each poll, so replace-all-for-this-source is the correct semantic (delete rows for sourceId then bulk insert). Do it inside the existing withSourceScope fail-closed guard; reuse the pruneDestinations delete pattern for the sweep. Must never touch other sources' rows. Batch the insert rather than one round-trip per row.
- listPaths(sourceId: SourceScope): Promise<ReticulumPathRow[]>, withSourceScope + normalizeBigInts, ordered by hops then destinationHash.
- (Optional) getPath(sourceId, destinationHash) if the probe UI wants a single-row lookup.
- All methods async, per-source scoped, no raw SQL outside this file.

### 3.4 Manager (src/server/reticulumManager.ts)
- Register client.on('path_table',...) -> map wire rows (destinationHash, via, hops, interface, expires) to UpsertPathInput (viaHash <- via, interfaceName <- interface, expiresAt <- expires*1000, updatedAt <- Date.now()) and call databaseService.reticulum.replacePaths(this.sourceId, rows). Guard/log like the interface_stats handler.
- Add async probe(destinationHash, timeoutS?) -> this.client.probe(...) and async getRemoteStatus(destinationHash) -> this.client.getRemoteStatus(...). These are NOT own-mode gated (unlike getRadioConfig/setRadioConfig). Surface the bridge's typed errors upward as ReticulumBridgeError so the route maps them.

### 3.5 Bridge client (src/server/reticulumBridgeClient.ts)
- Add probe(params) and getRemoteStatus(params) using sendIdCorrelatedRequest, returning the decoded ProbeResultMessage / RemoteStatusMessage envelopes. Add a client.on('path_table') emit so the manager can subscribe. Add the new MESSAGE_TYPE entries and envelope decoders in reticulumProtocol.ts.

### 3.6 Routes (src/server/routes/reticulumRoutes.ts), all under /api/sources/:id/reticulum
- GET /paths, requirePermission('nodes','read',{ sourceIdFrom: 'params.id' }); returns ok(res, await repo.listPaths(sourceId)). Read from the DB (poll-populated), do NOT round-trip the bridge for the list.
- POST /paths/probe, requirePermission('nodes','write',{ sourceIdFrom: 'params.id' }); body { destinationHash, timeoutS? } validated (hex, bounded timeout); calls manager.probe(...); ok(res, probeResult) or the async command-error helper (maps PROBE_FAILED). This is the on-demand action.
- GET /remote-status/:hash (or POST /remote-status with body hash), requirePermission('nodes','read',{ sourceIdFrom: 'params.id' }); calls manager.getRemoteStatus(hash); ok(res, remoteStatus) or command-error helper (REMOTE_STATUS_FAILED / REMOTE_MANAGEMENT_DENIED -> 403). Not mode-gated.
- Envelope discipline: every handler returns ok()/fail(); remember the ApiService-doesn't-unwrap-.data gotcha, the frontend reads response.data.

Remote fleet note: the "fleet" is the set of remote destination hashes the operator wants to monitor. Keep that list in the source config (sources.config) consumed by reticulumConfig.ts and forwarded to the bridge as RNS_REMOTE_ALLOWED; the /remote-status route queries them on demand. Persisting remote /status history is OUT OF SCOPE for the required exit criteria (R2).

## 4. Frontend changes

### 4.1 Types (src/types/reticulum.ts)
- Extend ReticulumView union to add 'paths'.
- Add ReticulumPathRow (mirror of the server row), ReticulumProbeResult { destinationHash; ok; rttMs?; hops?; error? }, ReticulumRemoteStatus { destinationHash; ok; status?; path?; error? }.

### 4.2 ReticulumPathsView (new component +.module.css)
- Template: ReticulumInterfacesView.tsx / ReticulumDestinationsView.tsx. A table: destination hash (mono, shortened) -> via / next hop -> via-interface -> hops -> age (now - updatedAt, humanized). Empty state when no rows. Inline t(key, fallback) i18n; CSS module referencing only DEFINED semantic --color-* tokens (no var(--color-x, fallback); the semanticTokens test bans it). UiIcon for any icons.
- Probe action: a per-row or header "Probe" button (nodes:write) that POSTs /paths/probe and shows the ProbeResult (ok / rttMs / hops) inline. Reuse the hook's imperative helper.
- Remote status: a small panel/section listing configured remote targets with an on-demand "Query" button hitting /remote-status/:hash, rendering the returned interface-stats summary and remote path count. This is the fleet-monitoring surface.

### 4.3 Path-graph overlay (extend ReticulumMap.tsx, do NOT add a new map)
- Add an optional paths prop to ReticulumMap. When provided, render a react-leaflet Polyline layer as BaseMap children drawing an edge from each path's destination position to its via/next-hop position, ONLY when BOTH endpoints exist in the positioned destinations set (design section 7: dest -> next-hop when both have positions). Null-island filtered via the existing shouldDiscardPosition. Reuse RETICULUM_COLOR / createNodeIcon. A toggle (show path links) is acceptable but keep it lean. No new BaseMap.

### 4.4 Nav + page wiring
- ReticulumSubToolbar.tsx: add { id: 'paths', labelKey: 'reticulum.nav.paths', fallback: 'Paths', icon: a valid UiIconName such as 'network' or 'route' if defined, verify against src/components/icons/UiIcon.tsx }. NOT mode-gated (path table exists in all modes). Place it near interfaces/map (plumbing/topology cluster).
- ReticulumPage.tsx: route the 'paths' view to ReticulumPathsView; pass paths (and destinations for the overlay) from useReticulum.
- useReticulum.ts: add paths to fetchAll (GET /paths on the existing poll), plus imperative probe(destinationHash) and queryRemoteStatus(destinationHash) helpers (on-demand, mirroring loadConversation). Expose paths, probe result state, and remote-status state on UseReticulumState.

## 5. Test plan (standard Vitest suite + bridge pytest, never standalone scripts)

Migration / schema / repository:
- src/server/migrations/146_create_reticulum_paths.test.ts (SQLite), table + indexes created, idempotent (run twice), columns present.
- The PostgreSQL + MySQL DDL idempotency covered following the 141-145 pgmysql test pattern. Requires the PG/MySQL containers up.
- src/db/repositories/reticulum.perSource.test.ts, EXTEND with replacePaths/listPaths cross-source isolation (writing paths for source A never returns under source B; empty sourceId fails closed). Add a dedicated per-source assertion block for the new table (this is the required *.perSource coverage).
- Migration count test, bump expected count (migration skill handles this; verify).

Backend:
- src/server/reticulumManager.test.ts, path_table event -> replacePaths called with mapped rows; probe()/getRemoteStatus() delegate to client and surface typed errors.
- src/server/reticulumBridgeClient.test.ts, probe/getRemoteStatus id-correlation happy + timeout/error; path_table emit fan-out.
- reticulumRoutes: extend the routes test for GET /paths (nodes:read scoping via sourceIdFrom), POST /paths/probe (nodes:write, PROBE_FAILED -> mapped status), GET /remote-status (REMOTE_MANAGEMENT_DENIED -> 403). Assert envelope shape. Use the createRouteTestApp harness.
- Fixture-drift guard: extend the reticulumProtocol.ts fixture-contract test (the file that treats bridge/tests/fixtures as source of truth) to assert v==4 on all fixtures and to decode probe_result / remote_status / path_table fixtures into the mirrored types, this is the drift guard that keeps protocol.py and reticulumProtocol.ts in lockstep.

Frontend:
- src/components/Reticulum/ReticulumPathsView.test.tsx, renders rows, age formatting, empty state, probe action calls the endpoint and renders the result, remote-status query.
- ReticulumSubToolbar.test.tsx, EXTEND: paths item present in all modes.
- ReticulumMap.test.tsx, EXTEND: path-link polylines drawn only when both endpoints positioned; none when paths absent.
- useReticulum.test.tsx, EXTEND: paths fetched on poll; probe/queryRemoteStatus helpers.

Bridge pytest: as in 2.E (test_protocol, test_ws_server, test_rns_manager).

Gate: full Vitest green on SQLite + PG + MySQL, bridge pytest green, typecheck + lint:ci clean.

## 6. Work-package decomposition

WP1, Data model. Deps: none. Scope: migration 146 (three backends, idempotent, settingsKey, count test), schema triple, repository replacePaths/listPaths, migrationTables.ts (TABLE_ORDER + SOURCE_SCOPED_TABLES). Accept: migration tests (SQLite + pgmysql) green; reticulum.perSource.test.ts extended and green; count test updated. Can run in parallel with WP2.

WP2, Bridge probe + remote status + v4. Deps: none. Scope: protocol.py v3->4, new types/builders/failure codes; ws_server.py _handle_probe + _handle_get_remote_status; rns_manager.py probe() + get_remote_status() behind a mockable RNS adapter; config.py remote-management env vars; fixtures (bump v to 4 on existing; add probe/probe_result/get_remote_status/remote_status, ok+fail shapes); pytest additions. Accept: pytest green, all fixtures v==4, handlers hardware-free (mocked RNS). Parallel with WP1.

WP3, Backend wiring. Deps: WP1, WP2. Scope: reticulumProtocol.ts mirror (new MESSAGE_TYPE + decoders + version 4); bridgeClient probe/getRemoteStatus + path_table emit; manager path_table->replacePaths + probe/getRemoteStatus (not mode-gated); routes /paths, /paths/probe, /remote-status (correct requirePermission scoping + envelope); reticulumConfig.ts RNS_REMOTE_ALLOWED from sources.config; fixture-drift guard extended. Accept: manager/client/route tests + fixture-drift test green; typecheck clean.

WP4, Frontend paths view + probe + remote fleet. Deps: WP3. Scope: types (ReticulumView += 'paths', new interfaces); ReticulumPathsView + CSS module; sub-toolbar item; useReticulum paths fetch + probe/queryRemoteStatus; ReticulumPage wiring; remote-status panel. Accept: component/hook tests green; lint:ci clean (semantic tokens).

WP5, Path-graph overlay + polish. Deps: WP4. Scope: extend ReticulumMap with the optional path-link Polyline layer (both-endpoints-positioned rule), map test, i18n fallbacks, docs (epic decisions log + design doc topology notes). Accept: map test green; full suite + typecheck + lint:ci green.

Sizing note: 5 WPs, one new table, bridge + backend + frontend + overlay + fleet UI. WP4 is the heaviest (paths view + probe + remote fleet panel). If WP4 proves too large in practice, split the remote-fleet panel into WP4b sequenced after WP4a; do NOT split the phase itself.

WP dependency graph: WP1 (data) parallel WP2 (bridge) -> WP3 (backend wiring, needs both) -> WP4 (frontend) -> WP5 (overlay + polish + docs).
