# Remediation Epic — Phase 0 + Phase 1 (issue #3962)

**Status doc for the epic orchestration run started 2026-07-06.** Canonical plan: [REMEDIATION_PLAN.md](./REMEDIATION_PLAN.md) / issue [#3962](https://github.com/Yeraze/meshmonitor/issues/3962). This file is the durable state for the `/epic` harness — update it at every phase boundary so a restarted session can resume from the first unchecked phase.

## Scope and decisions (user interview, 2026-07-06)

- **Scope of this run:** Phase 0 (all five tasks) + Phase 1 (all six tasks). Phases 2–5 are future epic runs.
- **PR granularity:** each numbered task is its own PR, per the plan's ground rules.
- **Merge policy:** auto-merge each PR once CI is green and orchestrator review passes (via `/merge`); post a summary per phase.
- **Task 0.2 (trust-proxy):** proceed as planned — default `trust proxy` to `false` when `TRUST_PROXY` is unset, keep the startup warning, document prominently in release notes/README.
- **Plan doc:** merged to main first (this branch) so plan + epic state live on main.

## Phase checklist

Each unchecked phase = one worktree → architect spec → implementation → review → PR → CI → merge cycle.

- [x] **P0-docs** — Merge `docs/remediation-plan` (REMEDIATION_PLAN.md + this file) to main.
- [x] **0.1** — Process-level safety net: `unhandledRejection`/`uncaughtException` handlers in `server.ts`, logging with full context and routing through `gracefulShutdown()`. Exit: deliberate `Promise.reject()` in dev logs and shuts down gracefully.
- [x] **0.2** — Trust-proxy default → `false` when `TRUST_PROXY` unset; keep startup warning; release-notes/README documentation for proxied deployments.
- [x] **0.3** — Pin `meshcore.js` fork dependency to a commit SHA; lockfile regenerated; `npm ci` reproducible.
- [x] **0.4** — Strip/gate the hot-path `console.log`s in `src/services/api.ts` (CSRF token status + token prefix on every mutation); kept diagnostics behind a debug flag.
- [x] **0.5** — `@typescript-eslint/no-floating-promises` as `error` for non-test code; violations fixed or explicitly `void`/`.catch()`ed.
- [x] **1.1** — `withSourceScope` fails closed: omitting `sourceId` throws; explicit `ALL_SOURCES` sentinel for the documented global-by-design consumers (channel decryption, estimated positions, automations); full call-site audit.
- [x] **1.2** — Type-check the tests: `tsconfig.tests.json` (full strict — see phase log deviation), wired into CI non-blocking first; flip to blocking once clean.
- [x] **1.3** — Integration-grade route-test harness: in-memory SQLite + real Express app with real `requirePermission`/session/auth wiring; 3–5 representative route test files converted (source-scoped permission coverage); no mass conversion.
- [x] **1.4** — Lint ratchets: `no-explicit-any` → `error` with checked-in baseline; forbid raw `fetch(` in `src/components/**`/`src/pages/**` (baselined); `react-hooks/exhaustive-deps` + `prefer-const` → `error`.
- [x] **1.5** — Response-envelope convention: `ok(res, data)` / `fail(res, status, code, msg)` helper for the `{ success, error, code }` envelope; documented in CLAUDE.md; new/modified handlers must use it.
- [x] **1.6** — Schema-drift tripwire: CI test diffing `createTables()` schema vs full migration replay (001→latest), normalized `sqlite_master`, fail on divergence.

## Phase 2 checklist

Phase 2 started 2026-07-07. Decisions carried forward from the Phase 0+1 interview: behavior-preserving; each numbered sub-task is one PR; full suite green before merge.

- [ ] **2.1** — `MeshCoreManager implements ISourceManager`: one unified `sourceManagerRegistry` for all source types; `meshcoreRegistry.ts` reduced to a `@deprecated` shim (delete after one release). WP1 (interface+guards+config move) → WP2+WP3a (lifecycle+loop hardening) → WP3b (read-site migration) → WP4 (shim+tests+docs). See `task21_spec.md` and PR on branch `feature/3962-p2-meshcore-isourcemanager`.
- [ ] **2.2a** — Heartbeat/status-probing: extract shared service parameterized by `ISourceManager` (plan §2.2 ¶1).
- [ ] **2.2b** — Auto-announce: MeshCore + Meshtastic cycles → one `autoAnnounceService` with per-protocol adapters (plan §2.2 ¶2).
- [ ] **2.2c** — Auto-responder: `checkAutoResponder` in both managers → shared service (plan §2.2 ¶3).
- [ ] **2.2d** — Distance-delete scheduling: MeshCore's `DistanceDeleteScheduler` construction → unified ownership in `services/` (plan §2.2 ¶4).
- [ ] **2.3** — Singleton retirement: enumerate legacy-singleton branches in `meshtasticManager.ts`; create a registry-managed default source from env config; reduce `export default` to a pure alias; delete last special-casing (plan §2.3).

## Ordering notes

- Phase 0 tasks are independent; executed serially in numeric order (one phase in flight at a time).
- 0.5 and 1.4 both touch `eslint.config.mjs` — keep sequential.
- Phase 1 tasks run after Phase 0, in numeric order; 1.6 is the prerequisite for future Phase 3.3.

## Phase log

Record per-phase: PR link, deviations from plan, follow-ups.

- **P0-docs** — PR #3966 merged (plan + epic doc on main). No deviations.
- **0.1** — PR #3967 merged (processSafetyNet.ts + idempotent gracefulShutdown with exitCode param). Deviation: NodeJS.* type annotations replaced with inference/unknown due to ESLint no-undef.
- **0.2** — PR #3968 merged (trust-proxy default → false + docs/CHANGELOG BREAKING entry). No deviations.
- **0.3** — PR #3969 merged (SHA pin b98fc338, matched existing lockfile resolution). No deviations.
- **0.4** — PR #3970 merged (token-prefix leak removed; diagnostics → logger.warn/debug). No guard test added (no api.test.ts exists; nothing asserted on the removed lines).
- **0.5** — PR #3972 merged (418 violations: 409 `void`, 9 `.catch(logger.error)`; rule scoped to src non-test). Deviation: "npm run lint exits 0" unmet — 367 pre-existing errors in tests/-dir files; CI lint is non-blocking (continue-on-error) — make blocking in 1.4. mqttBridgeManager "deferred parent broker attach" test observed flaky in CI (passes on rerun).
- **1.1** — PR #3976 merged (ALL_SOURCES unique-symbol sentinel; runtime throw + Tier-2 required params; 3 real leaks fixed: server.ts getNodeCount refresh, deleteNode→deleteNeighborInfoInvolvingNode, meshtasticManager pending-DM fetch). Review-loop correction: implementer's repo-body `?? ALL_SOURCES` normalization (silent fail-open) reverted; explicit per-call-site decisions instead. CI: Quick Tests outgrew its 15-min cap (#3385 redux) → raised to 25 min in this PR.
  **Follow-up findings (1.1 architect §10, epic backlog):** hand-rolled fail-open `if (sourceId)` filters bypass the helper — all of `meshcore.ts`, `notifications.ts` subscriptions, parts of `channels.ts`, `nodes.ts:getAllNodesSqlite`; legacy `*Sync`/`*Sqlite` twins partially covered (Phase 3.4 deletes them); facade `getNode(nodeNum)` single-source-assumption chain (revisit with Phase 2).
- **1.2** — PR TBD (tsconfig.tests.json + `typecheck:tests` script + non-blocking CI steps in ci.yml/pr-tests.yml). Deviations: (a) kept FULL strict incl. noImplicitAny — plan's "noImplicitAny off" injects ~50 false-positive errors into prod src via evolving-any inference; (b) top-level `tests/` dir NOT included — its files pull @types/node into the program and poison frontend inference (~60 spurious errors). Baseline: 283 errors, all in src test files, 0 prod. Flip-to-blocking when count reaches 0 (burndown is a follow-up; top ~8 files hold ~150 errors).
- **1.3** — PR #3986 merged (createRouteTestApp() real-middleware harness + 4 conversions). Ride-alongs: real prod bug fixed (v1/messages GET 500'd without sourceId under fail-closed — missing ?? ALL_SOURCES) + harness anonymous-user race fix. 3 CodeQL alerts on the test fixture left open for human triage (recommend dismiss as used-in-tests).
- **1.4** — PR #3989 merged (count-based lint ratchet, eslint-baseline.json 410 files/2,515 violations; no-explicit-any/exhaustive-deps/prefer-const → error; raw-fetch ban in components/pages; CI lint now BLOCKING — closes the 0.5 deviation). Census correction: 727 pre-existing errors (468 config false-positives fixed at config level, not baselined).
- **1.5** — PR #3990 merged (ok()/fail() helpers + 2 exemplar conversions + CLAUDE.md convention; ApiService does-not-unwrap constraint documented). No deviations.
- **1.6** — PR TBD (schemaDrift.test.ts + schemaDrift.allowlist.ts; 15-entry allowlist; census confirmed 15 divergences — 10 onlyInBootstrap, 3 onlyInReplay, 2 sqlMismatch — matching the architect spec exactly). Finding flagged for Phase 3.3: 7 createIndexes()-only indexes (idx_messages_createdAt/fromNodeId/toNodeId, idx_nodes_updatedAt, idx_route_segments_distance/recordholder/timestamp) are silently lost on a replay-only fresh install; Phase 3.3 must add migrations creating each before deleting createIndexes(). No deviations.
