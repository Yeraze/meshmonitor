# P11 implementer brief (shared by WP1–WP4)

Worktree: `/home/yeraze/Development/meshmonitor/.claude/worktrees/mc-6253`, branch `feature/mc-parity-6253-notifications`
(submodules + node_modules set up). Read `CLAUDE.md`, then `docs/internal/dev-notes/MESHCORE_PARITY_P11_SPEC.md`
(maintainer decisions there are binding). Binding rule: one shared configurable implementation for all sources,
never a MeshCore copy of a Meshtastic component/handler.

## Context
P1–P10 are merged. Read docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md (CLI, credential store, danger guard, CliConsoleBody).
Useful pieces: `server/utils/meshcoreCliRedact.ts`, `server/services/meshcoreOwnIdentityTracker.ts` (expectChange from P8a),
`server/errors/meshcoreDeviceCommandError.ts`, `components/shared/config/FactoryResetWipeList.tsx`, `TypedConfirmDialog`.
NO real radio: never send to a device; tests mock the serial transport / manager. Firmware evidence clone:
/tmp/claude-1000/-home-yeraze-Development-meshmonitor/95d1a848-1ce0-4732-8d0a-72e3b4f29f64/scratchpad/fw/MeshCore (81dbae59).
New CSS: only DEFINED --color-* tokens; run src/styles/semanticTokens.test.ts.

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

