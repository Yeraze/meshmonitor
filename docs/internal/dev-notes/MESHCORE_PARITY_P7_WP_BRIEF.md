# P7a implementer brief (shared by WP1–WP5)

Worktree: `/home/yeraze/Development/meshmonitor/.claude/worktrees/mc-6254`, branch `feature/mc-parity-6254-security`
(submodules + node_modules set up). Read `CLAUDE.md`, then `docs/internal/dev-notes/MESHCORE_PARITY_P7_SPEC.md`
(maintainer decisions there are binding). Binding rule: one shared configurable implementation for all sources,
never a MeshCore copy of a Meshtastic component/handler.

## Context
P1–P6 are merged. Useful shared pieces: `utils/nodeIdentity.ts` `unifiedNodeKey` (`mt:<n>`/`mc:<pk>`),
`utils/meshcoreNodeNum.ts` `nodeNumFromPubkey`, `server/utils/protocolRows.ts`, `server/utils/transmitTarget.ts`,
`server/services/meshcoreNodeView.ts`, `utils/meshcorePath.ts`. Read the spec's Design + your WP list first.

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
