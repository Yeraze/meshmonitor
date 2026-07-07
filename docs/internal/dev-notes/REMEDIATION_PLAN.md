# MeshMonitor Remediation Plan

**Origin:** Full-codebase architecture/quality review (2026-07-06).
**Theme:** Almost every major abstraction in the codebase is *half-migrated* — the correct pattern exists (ISourceManager, repositories, services layer, TanStack Query, ApiService) but the oldest/biggest files never adopted it. This plan finishes those migrations in dependency order: guardrails first, then the highest-leverage structural unification, then the god-file decompositions that depend on it.

**Ground rules for every phase:**
- Each numbered task is intended to be one PR (or a small stack). No mega-PRs.
- Full Vitest suite green before merge (per CLAUDE.md). New structural work adds tests in the same PR.
- Behavior-preserving refactors only, except where a task explicitly says otherwise.
- Phases 0–1 are prerequisites. Phases 2–5 can partially interleave, but respect the noted dependencies.

---

## Phase 0 — Quick hardening wins (days; no structural change)

Small, independent, high-value fixes. Ship each as its own PR; no ordering constraints.

| # | Task | Detail |
|---|------|--------|
| 0.1 | **Process-level safety net** | Add `process.on('unhandledRejection')` and `process.on('uncaughtException')` in `server.ts` that log with full context and route through `gracefulShutdown()`. Currently an unhandled rejection kills the process silently, bypassing teardown. |
| 0.2 | **Trust-proxy default** | Default `app.set('trust proxy', false)` when `TRUST_PROXY` is unset (currently defaults to `1`, `server.ts:~111`). Combined with `validate: false` on the rate limiters, the current default lets a direct-connected client spoof `X-Forwarded-For` to rotate `req.ip` past the auth brute-force limiter and poison audit attribution. Keep the startup warning; document the change in release notes (proxied deployments must set `TRUST_PROXY` explicitly — most already should). |
| 0.3 | **Pin meshcore.js fork to a SHA** | `package.json`: `github:Yeraze/meshcore.js#feat/meshmonitor-helpers` → pin to a commit SHA. Branch refs are mutable → reproducibility/supply-chain risk. |
| 0.4 | **Strip hot-path console logging in `api.ts`** | Remove/gate the 9 `console.log`s in the request path, especially CSRF token status + 8-char token prefix logged on every mutation. Gate any kept diagnostics behind a debug flag. |
| 0.5 | **ESLint: `no-floating-promises`** | Enable `@typescript-eslint/no-floating-promises` as `error` for non-test code (type-aware linting is already configured). Fix or explicitly `void`/`.catch()` the violations. This is the lint counterpart to 0.1. |

**Exit criteria:** all five merged; a deliberate `Promise.reject()` in dev logs and shuts down gracefully; `npm ci` reproducible from lockfile.

---

## Phase 1 — Guardrails before refactoring (1–2 weeks)

Build the safety net that makes Phases 2–5 safe, and stop new debt from accruing.

### 1.1 `withSourceScope` fails closed
- Change `src/db/repositories/base.ts:withSourceScope` so omitting `sourceId` **throws** (or requires an explicit `ALL_SOURCES` sentinel for the few legitimate cross-source consumers: `channelDecryptionService`, `estimated_positions`, automations — the documented global-by-design exceptions).
- Audit all call sites; annotate intentional cross-source queries with the sentinel.
- This converts the #1 hard rule (per-source isolation) from caller-discipline to compiler/runtime enforcement.

### 1.2 Type-check the tests
- Add a `tsconfig.tests.json` that includes `**/*.test.ts*` (can be looser than prod: `strict` but `noImplicitAny` off initially).
- Wire into CI as a separate non-blocking check first; flip to blocking once clean.
- Rationale: 557 test files currently get **zero** type-checking, so mock shapes silently drift from real signatures.

### 1.3 Integration-grade route-test harness
- Build one shared fixture: in-memory SQLite via the existing `createTestDb()` + a real Express app with the **real** `requirePermission` middleware and real session/auth wiring (seeded users/permissions), replacing the monkey-patch pattern (`(databaseService as any).checkPermissionAsync = vi.fn()...`).
- Convert 3–5 representative route test files as the template (pick ones covering source-scoped permissions).
- Do **not** mass-convert yet — new/changed routes must use the harness; old tests convert opportunistically as their routes are touched in later phases.

### 1.4 Lint ratchets
- `@typescript-eslint/no-explicit-any`: `error` with a checked-in baseline/allowlist (e.g. eslint-baseline or per-file disable header) so existing ~1,160 occurrences don't block, but **new** `any` does. Burn down opportunistically.
- Add a `no-restricted-syntax`/`no-restricted-globals` rule forbidding raw `fetch(` in `src/components/**` and `src/pages/**` (must go through `ApiService` or a query hook). Baseline existing violations; migrate in Phase 5.
- Promote `react-hooks/exhaustive-deps` and `prefer-const` from `warn` to `error` (the exhaustive-deps one matters for the SettingsTab class of bug).

### 1.5 Response-envelope convention
- Pick the `{ success, error, code }` envelope (already used by ~33 route files), codify it in a tiny shared helper (`ok(res, data)` / `fail(res, status, code, msg)`), document in CLAUDE.md.
- New/modified handlers must use it; existing bare-`{error}` handlers convert as they're touched in Phases 2 and 4. Frontend `ApiService` already tolerates both.

### 1.6 Schema-drift tripwire (prerequisite for Phase 3.3)
- CI test: create one DB via `createTables()` and one via full migration replay (001→latest), diff the resulting SQLite schemas (`sqlite_master` normalized). Fail on divergence.
- This makes the three-sources-of-truth problem *visible* before Phase 3 removes it.

**Exit criteria:** withSourceScope fail-closed merged with full call-site audit; test tsconfig in CI; harness exists with ≥3 converted route tests; lint ratchets active; schema-diff test green.

---

## Phase 2 — Unify the multi-source architecture (2–4 weeks; highest structural leverage)

**Goal:** one registry, one source-manager interface, no singleton special-casing. This unblocks all downstream dedup and is a prerequisite for shrinking both managers.

### 2.1 `MeshCoreManager implements ISourceManager`
- It already structurally has `sourceId`, `getStatus`, `getLocalNodeInfo`; formalize the interface (extend `ISourceManager` if MeshCore needs additional lifecycle members — prefer widening the interface over a parallel one).
- Register MeshCore managers in `sourceManagerRegistry`; delete `meshcoreRegistry.ts`.
- Update every call site that branches "which registry do I ask" to a single `sourceManagerRegistry.getManager(sourceId)` + type-narrowing on `sourceType` only where protocol-specific behavior is genuinely needed.
- **Risk:** wide blast radius across routes/server.ts. Mitigate: keep a temporary re-export shim for `meshcoreManagerRegistry` for one release, marked deprecated, then delete.

### 2.2 Extract the duplicated cross-protocol subsystems
One PR each, in this order (smallest → largest):
1. **Heartbeat/status probing** — shared service parameterized by `ISourceManager`.
2. **Auto-announce** — MeshCore's cycle (`meshcoreManager.ts:~5300`) + Meshtastic's into one `autoAnnounceService` with per-protocol send adapters.
3. **Auto-responder** — same treatment (`checkAutoResponder` exists in both managers).
4. **Distance-delete scheduling** — MeshCore constructs its own `DistanceDeleteScheduler` (`meshcoreManager.ts:~734`); unify ownership/scheduling in one place.
- Each extraction: move logic to `src/server/services/`, inject the manager, keep manager methods as thin delegates initially, add/port tests.

### 2.3 Retire the singleton's special-cased behavior
- Enumerate the "legacy singleton" branches in `meshtasticManager.ts` (~lines 724, 946, 1037, 1180, 2038 — e.g. env/runtime IP override only for the singleton).
- Make the env-var/single-source startup path create a **registry-managed default source** with the env config injected as ordinary per-source config, instead of a behaviorally-special instance.
- Once no behavior depends on singleton identity, reduce `export default` to a pure alias of the registry's default source; migrate remaining importers; delete last.
- **Risk:** the env-var deployment path is the most common install. Cover with explicit startup tests (env-only, DB-sources-only, both) before switching.

**Exit criteria:** one registry; `ISourceManager` implemented by both managers; the four duplicated subsystems live in `services/` with tests; no `isLegacySingleton`-style branches remain; adding a hypothetical third source type requires implementing `ISourceManager` only.

---

## Phase 3 — Data-layer consolidation (2–4 weeks; parallelizable with Phase 2)

### 3.1 Split `misc.ts` by domain
- `src/db/repositories/misc.ts` (2,195 lines, 82 methods, 10+ domains) → `solarEstimates.ts`, `packetLog.ts`, `upgradeHistory.ts`, `newsCache.ts`, `backupHistory.ts`, `autoTraceroute.ts`, `mapPreferences.ts`, `keyRepair.ts`, `themes.ts`, `timeSync.ts`.
- Mechanical moves, one or two domains per PR; `DatabaseService` facade methods keep their names so callers don't churn.

### 3.2 Key-repair backend parity decision
- The `*Sqlite` key-repair methods throw on Postgres/MySQL — the feature silently doesn't exist on two of three backends.
- **Decide:** port to Drizzle 3-backend (preferred; the queries aren't exotic) **or** formally declare it SQLite-only: capability flag surfaced to the frontend (hide the UI), documented in README, and a clean "not supported on this backend" API response instead of a thrown error.

### 3.3 Single source of truth for schema bootstrap
- Replace `createTables()`'s ~770 lines of hand-written DDL with **migration replay**: fresh installs run migrations 001→latest, same as upgrades. (The Phase 1.6 tripwire proves equivalence first.)
- Measure fresh-install time; if replaying 112 migrations is too slow, generate a snapshot baseline *from* the migration chain in CI rather than maintaining one by hand.
- Delete `createTables()`/`createIndexes()` once replay is the only path. This eliminates the new-install vs upgraded-install divergence risk permanently.

### 3.4 Sync/async API burn-down in `database.ts`
- Inventory the paired `xxx()` / `xxxAsync()` methods; the sync variants are SQLite-only legacy.
- Migrate remaining sync callers to async (most already are, per the Async-suffix convention), delete the sync twins in batches.
- Target: `database.ts` under ~4k lines, pure delegation + bootstrap orchestration only. Move the compute-heavy stragglers (`updateNodeMobility`, `calculatePacketRates`, `getNodeNeedingTracerouteAsync`, node cache) into repos/services.

### 3.5 Migration ergonomics (small, ongoing)
- Shared idempotency helpers (`addColumnIfMissing(db|client|pool, ...)` per dialect) to replace the three hand-rolled idioms — apply to *new* migrations only; don't rewrite history.
- Replace the hardcoded `count() === 112` test with an assertion derived from the registry (highest number == count, names unique) to kill the merge-conflict magnet.

**Exit criteria:** `misc.ts` deleted; key-repair parity resolved either way; fresh installs build via migrations; schema-diff tripwire retired (nothing left to diff); `database.ts` sync twins gone.

---

## Phase 4 — Backend god-file decomposition (4–8 weeks, incremental; depends on Phase 2)

### 4.1 `server.ts` → route modules (mechanical, low risk, do first)
- Move the ~150 inline `apiRouter` handlers into `src/server/routes/` modules by domain (nodes, messages, poll, config, favorites, positionOverrides, notes, remoteAdmin, configImport, …), adopting the Phase 1.5 envelope and `requirePermission({ sourceIdFrom })` pattern as they move.
- Extract embedded business logic to services in the same PR **only when trivially separable** (e.g. `transformDbMessageToMeshMessage`, `resolveSourceConnectionConfig`); otherwise move-then-refactor in a follow-up. The config-import handler (~line 5500, with its `setTimeout` pacing and rollback logic) becomes `channelImportService` and reconciles with the duplicate `/channels/import-config` route.
- Target: `server.ts` < 800 lines — bootstrap, middleware wiring, router mounting, error handler, shutdown only.

### 4.2 `meshtasticManager.ts` — extract leaves first, reconnect last
Order by decreasing independence (one PR each):
1. MQTT proxy bridging (helpers already isolated at file tail).
2. Cron scheduling (`scheduleCron`) + auto-announce/auto-responder delegates (mostly done via Phase 2.2 — finish by removing the delegate bodies).
3. Favorites management.
4. Admin-ack correlation (`pendingAdminAcks`) → an `adminTransactionService` usable by config flows.
5. Config/channel/LoRa admin flows → `deviceAdminService`.
6. NodeDB maintenance.
7. **Last:** the reconnect state machine. Convert the dozens of boolean flags/latches to an explicit state enum (`Disconnected | Probing | Connecting | ConfigSync | Connected | Cooldown | ManualResync…`) with a single transition function. Preserve every issue-referenced behavior (#3270/#3276 teardown-before-reconnect, #3122 startup grace, want_config rate-limiting) as named transitions with tests. **Do not attempt this before the leaves are out** — it needs the file small enough to reason about.
- Target: manager < 4k lines = transport + protobuf dispatch + state machine + thin service delegation.

### 4.3 `meshcoreRoutes.ts` (3,682 lines) split by concern
- Device/status, contacts, channels, messaging, admin/CLI, packets — mechanical split, keep the existing (good) permission/envelope discipline.

**Exit criteria:** `server.ts` < ~800 lines; `meshtasticManager.ts` < ~4k with an enum-based reconnect state machine and dedicated transition tests; no route file > ~1,200 lines.

---

## Phase 5 — Frontend consolidation (4–8 weeks, incremental; independent of 2–4)

### 5.1 Finish the DataContext → TanStack migration (correctness first)
- `DataContext`'s `useState` copies of nodes/channels/messages/connectionStatus vs the `usePoll` query cache is the frontend's dual source of truth.
- Per data domain: point all consumers at the `useServerData` selectors (`useNodes`, `useChannels`, …), delete the corresponding context state. Messages likely last (most consumers).
- Fold the `useTelemetry`/`useVersionCheck` hand-rolled `setInterval`s into TanStack `refetchInterval` while in there.

### 5.2 Memoize context values
- All providers (`DataContext`, `MessagingContext`, `UIContext`, `SourceContext`, `AutomationContext`, `MapContext`, …): wrap `value` in `useMemo` with stable setter identities. Cheap PR, real win on a 1-second-poll app.

### 5.3 SettingsTab/settings-form rewrite (kills the 81-dep `handleSave`)
- Replace the 57 mirrored `local*` `useState`s with a single draft object (`useReducer` or one `useState<SettingsDraft>` + field updater), diffed against the context on save.
- `handleSave` then depends on `[draft, saveFns]` — two deps, not 81. Update the CLAUDE.md "Adding New Settings" recipe accordingly (removes two of its four manual steps).
- Apply the same draft pattern to `ConfigurationTab`'s 205 `useState`s as a follow-up, section by section.

### 5.4 Converge on react-router; dissolve `App.tsx`
1. Move each `activeTab === 'x' && <XTab/>` body into a route component under the existing `main.tsx` router; `setActiveTab` becomes `navigate()`. One tab per PR; delete the duplicated hand-rolled URL parsing (App.tsx:267, :5475) when the last tab moves.
2. As each tab moves, its slice of App's 38 `useState`/38 `useEffect` moves into the tab or an existing context/hook. NodesTab's 19 props shrink to what's genuinely per-render.
- Target: `App.tsx` < ~500 lines (shell, providers, layout).

### 5.5 One fetch paradigm
- Migrate the raw `fetch()` call sites (NodesTab, SettingsTab, EmbedMap, `configuration/*Section` family) to `ApiService`/query hooks; then flip the Phase 1.4 lint baseline to zero. Type the `any` request bodies in `ApiService` while touching each endpoint.

### 5.6 CSS containment (pragmatic — don't boil the ocean)
- New components use CSS modules; the global sheets are frozen (additions discouraged, `!important` additions lint-flagged via stylelint if adopted).
- One targeted fix: reorder/annotate `nodes.css` so the mobile `@media` block follows the base rules it overrides (the twice-bitten #3532 cascade trap), with a comment banner.

**Exit criteria:** single data source of truth (DataContext holds no server data); no raw fetch in components; `handleSave` dep array gone; all tabs are routes; `App.tsx` < ~500 lines.

---

## Phase 6 — Ongoing hygiene (continuous, no end date)

- **`any` burn-down:** ratchet the Phase 1.4 baseline down with a monthly "reduce by N files" habit; protobuf decode boundaries get typed wrappers first (`protobufService`, manager decode paths).
- **Route-test conversion:** every route touched in Phases 2/4 converts to the Phase 1.3 harness; track the count down.
- **Envelope completion:** last bare-`{error}` handlers converge as touched.
- **bcrypt rounds 10 → 12** next time auth is touched (cheap, low priority).
- **`engines` field** in package.json (Node >= 20) — one-liner, do anytime.

---

## Sequencing summary

```
Phase 0 (days)          ──────▶ immediately, all parallel
Phase 1 (1–2 wks)       ──────▶ before any structural work
Phase 2 (2–4 wks)       ──┬───▶ highest leverage; blocks 4.2
Phase 3 (2–4 wks)       ──┘     parallel with Phase 2 (different files)
Phase 4 (4–8 wks incr.) ──────▶ 4.1 anytime after Phase 1; 4.2 after Phase 2
Phase 5 (4–8 wks incr.) ──────▶ independent; can interleave with 2–4
Phase 6                 ──────▶ continuous
```

**Biggest-bang-for-buck if time is scarce:** Phase 0 entirely, 1.1 (fail-closed scoping), 2.1–2.2 (one registry + dedup), 3.3 (schema single source of truth), 5.1 (frontend single source of truth). Those six eliminate every *correctness*-class risk from the review; everything else is maintainability.
