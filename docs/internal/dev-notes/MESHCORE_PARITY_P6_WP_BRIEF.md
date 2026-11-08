# P6 implementer brief (shared by WP2–WP8)

Worktree: `/home/yeraze/Development/meshmonitor/.claude/worktrees/mc-6263`, branch `feature/mc-parity-6263-api`
(submodules + node_modules set up). Read `CLAUDE.md`, then `docs/internal/dev-notes/MESHCORE_PARITY_P6_SPEC.md`
(maintainer decisions there are binding). Binding rule: one shared configurable implementation for all sources,
never a MeshCore copy of a Meshtastic component/handler.

## WP1 foundations (commit f3f5ca8b9) — use these
- `MeshCoreRepository` (`db/repositories/meshcore.ts`; the MeshCore packet log lives HERE, there is no
  meshcorePacketLog repo): `countNodesBySource(sourceId)`, `countActiveNodesBySource(sourceId, sinceMs)`,
  `getNodesHeardSince(sourceId, sinceMs, limit)` (lastHeard desc), `countMessagesSince(sourceId, sinceMs)`
  (createdAt, excludes reactions, NOT viewer-scoped → gate on messages:read),
  `listMessages({scopes, since?, limit=50, offset?, channelIdx?, fromPublicKey?, toPublicKey?})` (createdAt desc;
  same scope builder as searchMessages), `getPacketCountsByPayloadTypeSince(sourceId, sinceMs)` →
  `{payloadType, payloadTypeName|null, count}[]`, `getNodeActivity({sourceId, since})` →
  `{senders:{senderPubKey|null, srcHash|null, count, lastHeard}[], unattributed}` (srcHash only when no full key;
  prefix-ambiguity resolution is the caller's job), `getOldestTimestamp(sourceId)`,
  `getDirectHeardStats(sourceId, sinceMs)` → `{senderPubKey|null, srcHash|null, count, lastHeard, bestSnr, bestRssi}[]`.
- `MeshCoreHopSnrRepository.getInitiatedTraces(sourceId, sinceMs, limitTraces)` → `MeshCoreHopSnrRow[][]`
  (newest first, hop order); also P5's `getLatestInitiatedTraceFor`, `getResolvedLinks`.
- `server/utils/meshcoreViewOnMapMask.ts` `maskContactPositionsForViewOnMap(items, user, sourceId)`.
- `server/services/meshcoreNodeView.ts` `loadMeshCoreNodesForViewer(sourceId, access: NodeViewAccess,
  {positions, heardSinceMs?, limit?})` (access from `loadV1Access(req)`; DB-backed; override → viewOnMap mask →
  sign-flip; `positions:false` strips coords).
- `server/utils/protocolRows.ts`: `BROADCAST_NODE_NUM`, `BROADCAST_NODE_ID` ('!ffffffff'), `UNRESOLVED_NODE_NUM`
  (4294967295), `type Protocol`, `withMeshtasticProtocol(row)`, `meshcoreNodeKey(pk)`, `parseMeshcoreNodeId(id)`
  ('mc:<pk>' or bare 64-hex → lowercase pk|null), `meshcoreNodeToV1(row, sourceId?)`,
  `meshcoreMessageToV1(row, sourceId?)` (timestamp = sender clock ms; createdAt = arrival),
  `meshcoreTraceToV1(rows, {localPublicKey?})` (route/snrTowards JSON strings; snrTowards already dB×4; hops[] dB),
  `meshcorePacketToV1(row, {plaintext?})` (snake_case).
- `server/utils/transmitTarget.ts` `resolveTransmitTarget(sourceId)` → `{kind:'meshtastic'|'meshcore', sourceId,
  manager} | {kind:'refused', status, code, message}` (does not check MeshCore connectedness → handler returns 503).
- P5: `utils/meshcoreNodeNum.ts` `nodeNumFromPubkey`; `utils/nodeIdentity.ts` `unifiedNodeKey`;
  `components/map/RouteFlowMap.tsx`; `GET /api/sources/:id/meshcore/hop-snr/latest-trace?publicKey=`.

## Rules
- Other WP agents work in this worktree in parallel. Edit ONLY your WP's files (spec file list). Shared files
  (`public/locales/en.json`, openapi yaml): small targeted Edit insertions only, never rewrite.
- Never `git stash`. Never `git add -A` / rtk auto-staging. Commit with explicit pathspecs
  (`git add <new files>` then `git commit -m ... -- <paths>`). Trailers:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UrobAQTeP4VgugVc9vccFG
  ```
- `.js` on server relative imports; no raw SQL outside repositories; new handlers use `ok()/fail()` (existing v1
  contract shapes stay — additive fields only); CSS modules + `var(--color-*)`; `UiIcon`; flat `en.json` keys; no raw
  `fetch()` in components; react-hooks/exhaustive-deps per-file counts must not grow.
- MeshCore identity is `mc:<pk>` (nodeKey); never join/key on the synthetic nodeNum.
- Route tests use `createRouteTestApp` (`src/server/test-helpers/routeTestApp.ts`); repo tests multi-backend with
  `createIsolatedPostgresDatabase` / `createIsolatedMysqlDatabase` (mm-test-pg :5433 / mm-test-mysql :3307 running) —
  confirm 0 skipped. New MeshCore routes must be classified in `meshcoreRoutes.scope.test.ts`.
- Run ONLY targeted vitest files, with your own JSON output path
  (`--reporter=json --outputFile.json=<scratch path>`); the default `.vitest/json` is shared. No full suite.
- Before reporting: `npx tsc --noEmit -p tsconfig.json`, `npx tsc --noEmit -p tsconfig.server.json`,
  `node scripts/lint-ratchet.mjs 2>&1 | grep -v .claude/worktrees | tail` → no FAIL in your files.
- Report back: commits (sha + subject), files touched, tests added + pass counts, deviations/concerns.
