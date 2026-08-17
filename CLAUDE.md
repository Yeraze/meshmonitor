# MeshMonitor — Claude Agent Brief

**Version:** 4.13.x (multi-source architecture)
**Stack:** React 19 + TS + Vite frontend / Node.js 22+ (Docker image ships Node 24; armv7 image ships Node 22 — the lowest supported runtime, since Node 24 has no ARMv7 build; CI matrix covers 22/24/25) + Express 5 + TS backend / SQLite (default), PostgreSQL, MySQL via Drizzle ORM / Meshtastic protobuf-over-TCP and MeshCore (native `meshcore.js` for companion, serial CLI for repeater) through a per-source manager registry.

## Read order for new agents

1. **This file** — invariants, rules, and gotchas. Skim end-to-end.
2. **`docs/internal/dev-notes/ARCHITECTURE_LESSONS.md`** — MUST-READ before touching node communication, state management, backup/restore, async operations, multi-database, or multi-source.
3. **`docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md`** — MUST-READ before touching MeshCore CLI/admin routes, the credential store, the danger guard, or the shared `CliConsoleBody` primitive.
4. **`src/server/sourceManagerRegistry.ts`** + **`src/server/meshtasticManager.ts`** + **`src/server/bootstrapSources.ts`** — read these before any feature touching nodes/messages/telemetry. There is no global `meshtasticManager` singleton and no default export; everything is per-source — resolve the primary via `getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager` (see Multi-Source section below). Connection lifecycle runs through the explicit state machine in `src/server/meshtastic/connectionStateMachine.ts` (#3962 4.2b).
5. **One repository under `src/db/repositories/`** (e.g. `auth.ts`) — read before adding a query. Raw SQL outside this directory is ESLint-banned.

## Where things live

| Subsystem | Primary files |
|-----------|---------------|
| Multi-source registry | `src/server/sourceManagerRegistry.ts` (single unified registry — both Meshtastic TCP and MeshCore managers live here as `ISourceManager`), `src/server/meshtasticManager.ts`, `src/server/meshcoreManager.ts`, `src/server/sourceManagerTypes.ts` (type-guard predicates `isMeshCoreManager`/`isMeshtasticManager`, plus `getPrimaryMeshtasticManager`), `src/server/bootstrapSources.ts` (startup source-loading seam — extracts the boot loop for testability; designates the primary TCP source), `src/contexts/SourceContext.tsx`. |
| Auth + permissions | `src/server/auth/`, `src/db/repositories/auth.ts`, `src/db/repositories/permissions.ts` |
| Database backends | `src/db/drivers/{sqlite,postgres,mysql}.ts`, `src/db/schema/`, `src/db/repositories/` |
| Migrations | `src/server/migrations/NNN_*.ts` (75+ total), registry in `src/db/migrations.ts` |
| Backup/restore | `src/server/services/systemBackupService.ts`, `systemRestoreService.ts` |
| Routes | `src/server/routes/*` |
| Packet monitors | Meshtastic: `packet_log` table + `packetLogService.ts` + `packetRoutes.ts` + `PacketMonitorPanel.tsx`. MeshCore (OTA via `LogRxData`): `meshcore_packet_log` table + `meshcorePacketLogService.ts` + `/packets` routes in `meshcorePacketRoutes.ts` (mounted via the `meshcoreRoutes.ts` barrel) + `MeshCorePacketMonitorView.tsx`. MQTT (per-gateway receptions, N rows per packet, deduped at query time): `mqtt_packet_log` table + `mqttPacketLogService.ts` + `mqttPacketRoutes.ts` (`/api/sources/:id/mqtt/packets`), hooked via the `ingestServiceEnvelope` wrapper. All opt-in (`*_packet_log_enabled`). |
| Frontend pages | `src/pages/*` (`Unified*Page` = multi-source aware) |
| Shared map shell | `src/components/map/` — `BaseMap` (MapContainer + raster/vector tile branch + optional TilesetSelector/resize). New map surfaces MUST compose `BaseMap` instead of hand-rolling `MapContainer`; shared layers land here during epic #4047. |
| ESLint config | `eslint.config.mjs` (raw-SQL ban lives here) |

## Hard rules

- **Backend talks to nodes; frontend never does.** All node IO goes through `sourceManagerRegistry.getManager(sourceId)`.
- **Per-source scoping is mandatory.** Every query against nodes/messages/telemetry/traceroutes/etc. must take a `sourceId`. Search `src/db/schema/` for `sourceId` to enumerate.
- **No raw SQL outside `src/db/repositories/` and `src/server/migrations/`.** ESLint-enforced via `no-restricted-syntax` in `eslint.config.mjs`.
- **Relative imports in server-compiled code need an explicit `.js` extension** (#4596). `package.json` is `"type": "module"`, so Node's ESM loader does no extension inference: `import x from './foo'` compiles into `dist/` unchanged and throws `ERR_MODULE_NOT_FOUND` at runtime even with `foo.js` sitting beside it. Write `'./foo.js'` — TypeScript maps `.js` back to the `.ts`/`.tsx` source, and Vite/Vitest resolve it too. ESLint-enforced by `meshmonitor-ui/require-relative-import-extension`, scoped to tsconfig.server.json's include set. **`tsx`, Vite, and Vitest all resolve extensionless specifiers, so dev and the test suite never see this failure — only a deployment running compiled `dist/` does.**
- **All DatabaseService methods are async** (`Async` suffix). Tests mock with `mockResolvedValue`.
- **Never push directly to main. Always use a branch.**
- **App-owned interface icons use `UiIcon`.** Do not hardcode emoji or Unicode icon stand-ins in JSX or locale UI copy. Use `BrandIcon` for supported Simple Icons brand marks. User/content/protocol emoji require an issue-referenced exception when the distinction is not obvious.
- **CSS containment (#3962 Task 5.6).** New components style with CSS modules (`Component.module.css`) scoped to that component, not the global sheets. The legacy global sheets (`src/styles/nodes.css` and siblings) are frozen — additions are discouraged; extend a CSS module instead where practical. `src/styles/nodes.css` in particular carries a hard ordering constraint: a mobile `@media` override must be declared *after* any unconditional base rule for the same selector, or it is silently shadowed by the cascade (issue #3532, bitten twice). See the banner comment at the top of that file before moving or adding rules there.
- After bulk find-and-replace or sed, verify modified functions have correct `async`/`await` signatures. Route handlers and callbacks need `async` if `await` was added inside.
- **Run the [Mesh impact checklist](#mesh-impact-checklist) on any feature that sends packets, fires notifications, or arms a timer.** Ask the user before you pick a limit.

### Response envelope
API handlers use a shared envelope helper — `src/server/utils/apiResponse.ts`:
- Success: `ok(res, data)` → `{ success: true, data }` (omit `data` for `{ success: true }`).
- Error: `fail(res, status, code, message, extra?)` → `{ success: false, error, code, ...extra }`.

**New or modified handlers must use these.** `code` is a SCREAMING_SNAKE machine
code; reuse an existing one where it fits.

**Gotcha:** the frontend `ApiService.request()` returns the raw JSON body and
does **not** unwrap `data`. So `ok(res, x)` is only correct for handlers that
already return `{ success: true, data }` — converting a bare-payload handler
(`res.json(array)`) breaks its consumer. `fail()` is always safe: `ApiService`
reads only `error`/`code`/`retryAfterSeconds` and ignores `success` on errors.
Existing bare-`{error}` handlers convert opportunistically as they're touched
(Phases 2/4); this is not a mass conversion.

## Mesh impact checklist

LoRa is a shared, slow, half-duplex medium. A feature that looks cheap on a
desk with one node becomes mesh-wide congestion on a busy channel with 200. Work
through these three questions **before** you write the code, and put the answers
in the plan and the PR body.

### 1. What does this cost in airtime?

Every packet we send takes the channel away from everyone else on it. LongFast
runs at 1.07 kbps, about **134 bytes/sec** of raw on-air rate for the whole
mesh, before headers, retries, and rebroadcasts. Every packet also carries a
16-byte LoRa header on top of its payload.

Meshtastic uses managed flooding: every rebroadcast-eligible node that hears a
packet and has not already seen it rebroadcasts it. So `hop_limit=3` costs **at
least** 4 transmissions, and in a dense mesh many more, because the real count
scales with node count rather than hop count.

Ask:
- How many packets does this send, and how often?
- Does it scale with node count? A per-node ping is O(n) packets and will not
  survive a large mesh.
- Does it run on a timer, so the cost is permanent rather than one-off?
- Does it fire on every source? N sources means N times the traffic.

**Budgets to measure against.** The firmware hard-codes these in
`src/airtime.h` with no config binding:

| Figure | Value | Window |
|--------|-------|--------|
| Channel utilization, polite ceiling | 25% | rolling 60s, counts TX + RX including non-Meshtastic energy |
| Channel utilization, impolite ceiling | 40% | same |
| `airUtilTx` "stop doing this" threshold | 7-8% | rolling 1 hour, TX only |
| Background traffic share of duty cycle | 50% of the region limit | rolling 1 hour |

The 7-8% figure comes from Meshtastic's own ROUTER_LATE blog post, not the docs
proper. Note the two windows differ: channel utilization is a rolling 60
seconds and includes everything the radio hears, while `airUtilTx` is a rolling
hour of our own transmissions.

**Duty cycle is a hard block, and only in some regions.** `RegionInfo.dutyCycle`
(table in `src/mesh/RadioInterface.cpp`) is 100, meaning no limit, everywhere
except EU_433, EU_868, TH and UA_433 at **10%**, and UA_868 at **1%**. Where a
limit applies, `Router::send()` drops the packet, NAKs
`Routing.Error.DUTY_CYCLE_LIMIT`, and notifies the client. It gates **user text
messages too**, not just background traffic.

US and the other 100% regions get **no** duty-cycle enforcement, and the
firmware implements no dwell-time or channel-hopping substitute. Two rules
follow: never write an EU limit into code as if it were universal, and never
assume the firmware will stop us elsewhere. It will not.

The firmware's soft gates (channel utilization and `airUtilTx`) cover Position,
NodeInfo, NeighborInfo, Telemetry, StoreForward, RangeTest and MeshBeacon. They
do **not** cover user text messages. Anything we send on a text port is
ungoverned except by the duty-cycle block above, so our own limits are the only
thing standing between a feature and the mesh.

Prefer passive data we already receive over anything we have to ask for.
Traceroutes, telemetry requests, and NodeInfo exchanges are expensive, so batch
them, spread them out, or make them on-demand.

### 2. Can this spam the mesh or the users?

Spam is not only a flood of channel messages. Count the indirect paths too:

- **Direct:** text messages, DMs, auto-responses, announcements, traceroutes,
  admin packets.
- **Indirect:** rows that trigger an automation, events on `dataEventEmitter`
  that fan out to Apprise / desktop / MQTT publish, or notification-worthy state
  changes (node online, position moved, key mismatch).
- **Feedback loops:** our own sends re-enter the event bus. An automation that
  reacts to a message and sends a message can trigger itself. See the
  self-origin guard in the automation engine (#3914).
- **Retries:** a failed send that retries forever is a flood with extra steps.

If any of these fire automatically or repeatedly, the feature needs a limit. A
single send the user explicitly asked for does not. Reuse what exists rather
than inventing a new mechanism:

| Need | Use |
|------|-----|
| HTTP-side cap | `src/server/middleware/rateLimiters.ts` (`messageLimiter`, etc.) |
| Per-automation cap | `rateLimit: { maxActions, windowSeconds }` + `cooldownSeconds` / `cooldownScope` in `automationEngineService.ts` |
| Scheduled sends | Clamp the interval, like `autoAnnounceService` (3–24 hours) |

Default to conservative. A limit the user can raise beats a flood they have to
notice. Where a setting could plausibly hurt the mesh, warn in the UI next to
the input, not in a doc nobody reads.

### 3. Does a save reset a safety timer?

This is the bug we keep re-introducing. Most schedulers restart when settings
are saved. If the "time since last fire" lives only in memory, every save
re-arms the timer, so a user tweaking a settings page sends a burst of
announcements, or a cooldown never expires and the feature silently stops.

Rules:
- **Persist the last-fire timestamp to the database**, not to an instance field.
  `autoAnnounceService` stores `lastAnnouncementTime` in settings and checks the
  elapsed time on startup for exactly this reason
  (`src/server/services/autoAnnounceService.ts`).
- Restarting a scheduler must **not** count as a trigger.
- Check the reverse failure too: does a save clear a cooldown that was
  protecting the mesh, letting the next event fire immediately?
- Restart the container and confirm the timer survives. In-memory state looks
  correct until the process restarts.

### Ask before you decide

These limits are policy, not implementation detail. When the checklist says a
feature needs a cap, a cooldown, or a warning, **bring the numbers to the user
and ask**. Do not pick a limit, ship a default, or decide something is "safe
enough" on your own. State the airtime cost you calculated and propose an
option; let the user choose.

## Multi-Source Architecture (4.x)

MeshMonitor 4.x supports **N concurrent node connections** ("sources"), covering Meshtastic TCP, MQTT broker/bridge, and MeshCore. All manager types implement `ISourceManager` (`src/server/sourceManagerRegistry.ts`) and live in the **single unified `sourceManagerRegistry`**.

There is no global `meshtasticManager` singleton and no default export from `src/server/meshtasticManager.ts` (the live Proxy alias was retired in #3962 Phase 4.2a WP4). Consumers that need the "current primary Meshtastic TCP source, or the unconfigured fallback if none is registered" resolve it explicitly: `getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager` (both from `src/server/sourceManagerTypes.ts` / `src/server/meshtasticManager.ts`). A named `fallbackManager` export remains the concrete unconfigured instance used when no primary is registered (S4 env-IP fallback, #4020) — it is load-bearing for `bootstrapSources.ts` and must not be deleted. Consumers that need atomicity across multiple calls (e.g. a disconnect→reconnect sequence) MUST capture the resolved manager once at the top of the operation, not re-resolve per call site, since the registry's primary can change between calls.

### Critical Rules
- **No global `meshtasticManager` singleton.** Look up per-source instances via `sourceManagerRegistry.getManager(sourceId)`.
- **One registry: `sourceManagerRegistry`.** MeshCore managers are registered here alongside Meshtastic/MQTT managers. To narrow a manager by type, use the type-guard predicates in `src/server/sourceManagerTypes.ts`: `isMeshCoreManager(m)` and `isMeshtasticManager(m)`. **Never** use `instanceof` or `as any[]` casts for this purpose. Loops over `getAllManagers()` that call meshtastic-specific methods must filter first (`getAllManagers().filter(isMeshtasticManager)`).
- **MeshCore disconnect semantics differ.** Calling `/disconnect` on a MeshCore source calls `manager.disconnect()` directly and **leaves the manager registered** (so `/api/sources/:id/meshcore/*` routes keep working). This is intentional: it is the one place where meshcore lifecycle deliberately DIVERGES from meshtastic (disconnect keeps the manager registered rather than removing it).
- **Every packet/node/message/telemetry/traceroute/neighbor/channel/embed-profile/ignored-node/distance-delete/time-sync/meshcore row carries a `sourceId`.** Migrations 020–062 are mostly source-scoping work. Repository queries that don't scope by `sourceId` will leak data across sources. **Exceptions (global-by-design):** (1) the `channel_database` (server-side decryption PSKs) — `channelDecryptionService` tries every enabled row regardless of source, and migration 063 dropped its dead `sourceId` column. (2) the `estimated_positions` table (issue #3271) — one row per physical `nodeNum`, pooled from traceroute + neighbor observations across ALL Meshtastic sources (incl. MQTT) by the scheduled `positionEstimationService`; estimation is **Meshtastic-only** (MeshCore excluded) and runs as a global batch job (`positionEstimationScheduler`), not in realtime. (3) the `automations` / `automation_runs` / `automation_variables` / `automation_variable_values` tables (issue #3653, Automation Engine) — automations and their user-defined variables are **global** (no `sourceId`); a workflow evaluates against events from every source, and a `condition.sourceFilter` block inside its `config` graph scopes it to a subset. Variable values are keyed by an explicit `scopeKey` (global/source/node/sourceNode) rather than a row-level `sourceId`. See `docs/internal/dev-notes/AUTOMATION_ENGINE_PLAN.md`. Adding a new per-source data type should still get a `sourceId` column unless you have a concrete cross-source-by-design reason like decryption.
- **Permissions are per-source.** `permissions.sourceId` was added in migration 022, refined in 033. `requirePermission(resource, action)` middleware honors source scoping.
- **Frontend uses `SourceContext`** (`src/contexts/SourceContext.tsx`). `useSource()` returns `{ sourceId, sourceName }`; `sourceId` is `null` outside a `SourceProvider` (legacy/single-source views).
- **`Unified*Page` components are cross-source consumers** (`UnifiedMessagesPage`, `UnifiedTelemetryPage`, `DashboardPage`).

### Adding a Per-Source Feature
1. Decide: global (one row regardless of source) or per-source.
2. If per-source: add `sourceId` to all three schemas in `src/db/schema/<table>.ts`.
3. Write a migration that backfills existing rows with the default source (see migration 050 `promote_globals_to_default_source`).
4. Scope every query by `sourceId` via `withSourceScope(table, sourceId)` (in `src/db/repositories/base.ts`).
5. Add a `*.perSource.test.ts` asserting source isolation.

## Multi-Database Architecture (SQLite/PostgreSQL/MySQL)

Three backends. Default is SQLite. PG triggered by `DATABASE_URL` (postgres://), MySQL by `DATABASE_URL` (mysql://). Check `databaseService.drizzleDbType` for runtime backend (`'sqlite' | 'postgres' | 'mysql'`).

### Critical Rules
- **Use Drizzle ORM** — never write raw SQL that isn't database-agnostic.
- **Test with SQLite first** — it's the default and most common deployment.
- **Node IDs / packet IDs are BIGINT in PostgreSQL/MySQL.** Always coerce to `Number` when comparing (`Number(row.nodeNum)`). PG/MySQL `INTEGER` is signed 32-bit; nodeNum is unsigned 32-bit.
- **Boolean columns differ:** SQLite uses 0/1, PostgreSQL uses true/false. Drizzle handles this.
- **Schema definitions live in `src/db/schema/`** — one file per domain, three table definitions per backend.
- **Column naming:** SQLite uses `snake_case`, PostgreSQL/MySQL use `camelCase` (quoted in PG raw SQL).
- **A local "full suite" run does NOT cover PostgreSQL/MySQL unless those containers are running.** The multi-backend suites are `describe.skipIf(!postgresAvailable)` / `!mysqlAvailable`, and the probes in `src/db/repositories/test-utils.ts` check `localhost:5433` and `localhost:3307`. With nothing listening they **skip silently** — the run still reports success, just ~1,500 fewer tests. CI runs both as service containers, so schema bugs surface there instead. Before claiming a schema/migration change is verified:
  ```bash
  docker run -d --rm --name mm-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=meshmonitor_test -p 5433:5432 postgres:16
  docker run -d --rm --name mm-test-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_USER=test \
    -e MYSQL_PASSWORD=test -e MYSQL_DATABASE=meshmonitor_test -p 3307:3306 mysql:8.4
  ```
  Confirm coverage via `numPendingTests` (skipped) in the JSON reporter, not just `success`.
- **Adding a column to `nodes` also means updating the hand-written PG/MySQL DDL in `src/db/repositories/nodes.test.ts`** (`POSTGRES_CREATE` / `MYSQL_CREATE`). Only the SQLite suite builds its schema from the migration registry; the other two use literal `CREATE TABLE` blocks. Drizzle's `select()` enumerates every schema column, so one missing column fails *every* query in those suites (this cost ~92 CI failures in #4250). Repositories that select explicit column lists are unaffected.

### Architecture
```
src/services/database.ts      # Main service - facade over repositories
src/db/
  schema/                     # Drizzle schema (database-agnostic)
  repositories/               # Domain-specific async repositories
  drivers/{sqlite,postgres,mysql}.ts
```

### Adding a New Database Method
1. Add async method to the appropriate repository in `src/db/repositories/`.
2. Expose through DatabaseService with `Async` suffix.
3. Use Drizzle query builders — they generate correct SQL for each backend.
4. For unavoidable raw SQL inside a repo, branch on `db.drizzleDbType` for dialect-correct syntax.
5. **IMPORTANT:** When adding routes that use database methods, ensure tests mock the async versions.

### Test Mocking Pattern
Mock async methods used by `authMiddleware`:
```typescript
(DatabaseService as any).findUserByIdAsync = vi.fn().mockResolvedValue(user);
(DatabaseService as any).findUserByUsernameAsync = vi.fn().mockResolvedValue(null);
(DatabaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(true);
(DatabaseService as any).getUserPermissionSetAsync = vi.fn().mockResolvedValue({ resources: {}, isAdmin: false });
```
For per-source permission tests, mock `getUserPermissionSetAsync(userId, sourceId)` to return source-specific resource maps.

### Route Test Harness (preferred for new/changed route tests)
For route tests that exercise `requirePermission` / `optionalAuth`, use `createRouteTestApp()` (`src/server/test-helpers/routeTestApp.ts`) instead of monkey-patching `checkPermissionAsync` or mocking the whole `services/database.js` module. The harness wires real express-session (MemoryStore) + real auth middleware against the singleton's `:memory:` SQLite DB, and seeds per-test permission rows so that real SQL enforces isolation.

```typescript
let harness: RouteTestHarness;
beforeEach(async () => {
  harness = await createRouteTestApp({ mount: app => app.use('/', myRouter) });
  await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
});
afterEach(() => harness.cleanup());
```

- **New or changed route tests MUST use the harness.** Legacy tests using `vi.mock('../../services/database.js', ...)` convert opportunistically when the file is touched.
- The monkey-patch pattern (`vi.mock(...)` + fake `checkPermissionAsync` lambda) is deprecated for route tests. A fake that re-implements the logic under test cannot catch regressions in that logic.
- See `src/server/routes/sourceRoutes.permissions.test.ts` as the canonical template.
- Non-DB mocks (`sourceManagerRegistry`, `meshtasticManager`, service mocks) are still correct and must remain.

### Raw SQL Ban
- `src/services/database.ts` is raw-SQL-free. All domain queries live in `src/db/repositories/*`.
- ESLint rule (`no-restricted-syntax` in `eslint.config.mjs`) forbids `this.db.prepare`, `this.db.exec`, `postgresPool.query`, `mysqlPool.query` outside `src/server/migrations/**` and test files.
- Intentional exceptions must carry `// eslint-disable-next-line no-restricted-syntax -- <reason>`.

### ESLint Ratchet (remediation #3962 Task 1.4)
Three lint commands:
- `npm run lint` — full ESLint report; noisy during burn-down (thousands of existing violations). For local exploration only.
- `npm run lint:ci` — the **CI gate**. Runs `scripts/lint-ratchet.mjs`: fails only when a file's per-rule violation count exceeds the checked-in baseline (`eslint-baseline.json`). **This is what CI checks — it must exit 0.**
- `npm run lint:baseline` — regenerate `eslint-baseline.json` from the current tree. Run **after intentionally fixing violations** (baseline shrinks). Never run it to paper over new ones — reviewers will flag a baseline that grows rule counts.

**Local `lint:ci` is not CI-faithful when agent worktrees exist.** ESLint walks the filesystem, so any worktree under `.claude/worktrees/` gets linted too — those paths are git-excluded, so CI never sees them. A single leftover worktree can produce ~950 `FAIL` lines and a non-zero exit while your actual changes are clean. Judge the result by in-repo failures only:
```bash
npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'
```
Empty output = the CI gate passes. Vitest **no longer** has this problem — `vitest.config.ts` excludes `**/.claude/worktrees/**`. (It used to: two leftover worktrees tripled the local suite, adding ~11 min and ~22k phantom tests, and reported failures from the worktrees' own stale dependencies.) ESLint still walks them, so the `grep -v` above is still required for `lint:ci`.

**`npx eslint <file>` exiting 0 does not mean the ratchet passes.** The ratchet compares *per-file, per-rule counts* against the baseline, so adding one `react-hooks/exhaustive-deps` violation to an already-baselined file fails CI while plain ESLint reports nothing new. Always confirm with `lint:ci` before pushing.

**Rules now errors (existing violations frozen by baseline; burn them down, never up):**
- `@typescript-eslint/no-explicit-any` — 2,026 sites baselined. Burn down in Phase 6.
- `react-hooks/exhaustive-deps` — 110 sites. Do NOT auto-fix; missing deps can cause render loops. Fix per-site with behavior verification or a targeted `eslint-disable-next-line` with an issue-ref reason.
- `prefer-const` — 3 residual sites (destructuring edge cases).

**Raw `fetch()` banned in `src/components/**` and `src/pages/**`** — 64 existing sites frozen by baseline; they migrate to `ApiService` (`src/services/api.ts`) or a TanStack query hook in Phase 5. New components/pages must not use raw `fetch()`.

**Adding a violation you can't avoid:** fix it, or add a targeted `// eslint-disable-next-line <rule> -- #<issue> <reason>`, or (last resort, with reviewer sign-off) `npm run lint:baseline`. Treat any PR that *grows* a rule count in the baseline as a red flag.

### Migration Registry
Migrations use a centralized registry in `src/db/migrations.ts`. Each migration has functions for all three backends.

**Migration count:** derived from the registry at test-time — `src/db/migrations.test.ts` asserts structural invariants without a hardcoded number, so no file needs updating when a new migration is added.

For the full "adding a migration" recipe see [Migration recipe](#migration-recipe) below.

## Tools

- **context7** MCP for library/framework/API docs — use without being asked.
- **serena** MCP symbolic tools (`find_symbol`, `get_symbols_overview`, `find_referencing_symbols`, `search_for_pattern`) — preferred over grep for code navigation.
- **superpowers** skills for planning/workflow — use without being asked. Key ones: `brainstorming`, `writing-plans`, `executing-plans`, `test-driven-development`, `verification-before-completion`, `systematic-debugging`.
- **Slash commands** in `.claude/commands/`: `/ci-monitor`, `/create-pr`, `/create-release`, `/release-monitor`, `/worktree`, `/worktree-cleanup`.

## Operational gotchas

- Default admin account: username `admin`, password `changeme` (seeded by `DatabaseService` on first boot when no admin exists; logged to stdout). The login UI surfaces an `isDefaultPassword=true` warning until this is changed.
- Default SQLite path: `/data/meshmonitor.db` (set via `DATABASE_PATH` env var). This default is the same on every platform — baremetal Node deployments outside Docker must either create `/data/` writable to the runtime user OR set `DATABASE_PATH` to a different location.
- Load the app at `http://localhost:8080` for dev-container testing. The webserver has `BASE_URL` configured for `/meshmonitor`.
- Don't run the Docker dev container and a local `npm run dev` at the same time — they fight over ports.
- The dev container does NOT have `sqlite3` available as a CLI binary.
- When sending test messages, use the `gauntlet` channel — never the Primary channel.
- Tileserver runs on port 8082. Only shut it down (and the dev container) when you are running `tests/system-tests.sh` locally to debug a system-test failure — CI runs system tests on every PR, so you should not be invoking that script as part of normal feature/bugfix work.

## Agent worktrees (`isolation: "worktree"`)

A worktree created by the Agent tool is **not** set up by the `/worktree` slash
command — none of that command's setup steps run. The tree is a bare checkout:
submodules are uninitialised and `node_modules` is absent or partial. Every
agent that has run in one has hit the same two failures, and both look like
bugs in the agent's own diff until you check.

Do these two things **before** trusting any test run inside an agent worktree:

```bash
git submodule update --init --recursive        # else ~9 protobuf suites fail "encode failed"
ln -s ../../../node_modules node_modules       # or symlink individual packages
```

- **Uninitialised submodules** — the `protobufs/` submodule is empty, so protobuf
  encode/decode suites fail with `encode failed`. Nothing to do with your change.
- **Unresolvable `ts-overlapping-marker-spiderfier-leaflet`** — 6 map/hook suites
  fail to *collect* (0 assertions run, `success: false` with 0 failed tests).
  The package is present in the parent checkout but has **no `dist/`**, which
  affects the main checkout too. Symlinking the parent's `node_modules` is the
  quickest unblock; it is gitignored and changes no lockfile.

**Read the whole result, not the headline.** A run can report thousands passing
and still be `success: false` purely from suite-level *collection* errors like
these. Before concluding your change broke something, stash it and re-run: if
the identical failures persist, they are environmental. Say so explicitly in the
PR rather than quoting a clean-looking number you do not trust — and let CI,
which installs fresh, be the authority.

## Workflow

- System tests (`tests/system-tests.sh`) are run by CI on every PR. Do not run them locally as part of normal feature or bugfix work — only run them locally when you are specifically debugging a system-test failure.
- After creating or updating a PR, use the `/ci-monitor` skill to monitor CI status and auto-fix any failures (system-test regressions show up there).
- All tests must pass (0 failures) before creating a PR. Run the full Vitest suite, not just targeted tests, before committing migration or refactor work. For schema/migration work that full run is only meaningful with the PostgreSQL and MySQL containers up — see the Multi-Database section, since they skip silently otherwise.
- When migrating test mocks from sync to async, use `mockResolvedValue` (not `mockReturnValue`) for any function that returns a Promise.
- When testing locally, use `docker-compose.dev.yml` to build the local code, and verify the proper code was deployed once the container launches.

## Key Repair / NodeInfo Exchange Routing

When sending NodeInfo exchanges for key repair (auto-key management, immediate purge, manual button), always send on the **node's channel**, not as a DM. PKI-encrypted DMs use the stored key, which is wrong when there's a key mismatch. Channel routing uses the shared PSK which works regardless.

---

# Reference

The remainder of this file is reference detail used less often than the rules above.

## Migration recipe

1. Create `src/server/migrations/NNN_description.ts` with:
   - `export const migration = { up: (db: Database) => {...} }` for SQLite
   - `export async function runMigrationNNNPostgres(client)` for PostgreSQL
   - `export async function runMigrationNNNMysql(pool)` for MySQL
2. Register it in `src/db/migrations.ts` with `registry.register({ number, name, settingsKey, sqlite, postgres, mysql })`.
   `src/db/migrations.test.ts` does **not** need editing — its assertions are registry-derived and automatically cover the new entry.
   **`settingsKey` is required** (every migration but the 001 baseline has one) — all three backends use it for idempotency tracking. SQLite checks it inline in its loop; PostgreSQL/MySQL go through the ledger in `src/db/migrationLedger.ts` (#4233).
3. Make migrations **idempotent** using the shared helpers in `src/server/migrations/helpers.ts`.
   The ledger means a migration normally runs once per database, but a crash between the migration and its ledger write re-runs it, so **idempotency is still mandatory on every backend**. In particular, never write a migration that unconditionally deletes and rebuilds a table — that is what made 030 wipe and rebuild 865k `route_segments` rows on every single boot (#4233). Guard destructive work behind a "has this already been applied?" check, and batch bulk inserts rather than issuing one round-trip per row.
   - SQLite: `addColumnIfMissing(db, table, column, ddl)` — catches "duplicate column"; re-throws others.
   - PostgreSQL: `addColumnIfMissingPostgres(client, table, column, ddl)` — uses native `ADD COLUMN IF NOT EXISTS`.
   - MySQL columns: `addColumnIfMissingMysql(pool, table, column, ddl)` — `information_schema.COLUMNS` pre-check.
   - MySQL tables: `createTableIfMissingMysql(pool, table, createDdl)` — `information_schema.TABLES` pre-check.
     Include inline `INDEX` / `UNIQUE KEY` clauses in the `createDdl` when creating a new table.
   - MySQL indexes: `createIndexIfMissingMysql(pool, table, indexName, createDdl)` — `information_schema.STATISTICS` pre-check (MySQL has no `CREATE INDEX IF NOT EXISTS`).
   - SQLite and PostgreSQL support `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` natively — no helpers needed for those cases.

## API Testing Helper Script

Use `scripts/api-test.sh` for authenticated API testing against the running dev container:
```bash
./scripts/api-test.sh login                    # Login and store session
./scripts/api-test.sh get /api/endpoint        # Authenticated GET request
./scripts/api-test.sh post /api/endpoint '{"data":"value"}'  # POST request
./scripts/api-test.sh delete /api/endpoint     # DELETE request
./scripts/api-test.sh logout                   # Clear stored session
```
Default credentials: `admin/changeme1`. Override with `API_USER` and `API_PASS` env vars.

## Adding New Settings

When adding a new user-configurable setting:
- **MUST** add the key to `src/server/constants/settings.ts` `VALID_SETTINGS_KEYS` — without this,
  the setting silently fails to save.
- **SettingsTab uses a single `SettingsDraft` reducer (Task 5.3).** Add the field to the
  `SettingsDraft` type and to `buildBaseline()` (its context/prop or `initial*` source), then bind
  the input with `updateField('<key>', value)`. Add the key to the explicit `const settings = {…}`
  object literal in `handleSave` (this literal is intentionally hand-maintained — the
  `server.settings-persistence.test.ts` source-extraction and the server allowlist both key off it).
  **You do NOT touch any dependency array** — `handleSave`, the dirty-diff, the re-seed effect, and
  `resetChanges` all read the draft generically.
- See `src/contexts/SettingsContext.tsx` for the state/setter/localStorage/server-load pattern (only
  needed for settings that also live in context, i.e. categories A/B).

## Versioning & Release

- When updating the version, update all five files: `package.json`, `package-lock.json` (regenerate via `npm install --package-lock-only` — `.npmrc` now pins `legacy-peer-deps=true`, so the explicit flag is no longer needed), `helm/meshmonitor/Chart.yaml`, `desktop/src-tauri/tauri.conf.json`, `desktop/package.json`.
- Use shared constants from `src/server/constants/meshtastic.ts` for PortNum, RoutingError, and helper functions — never magic numbers for protocol values.
- Official Meshtastic protobuf definitions: https://github.com/meshtastic/protobufs/

## LXC Template Build

The Proxmox LXC template is built by `lxc/build-lxc-template.sh` using a
partial + sparse git clone. The cone directory list lives in
`lxc/sparse-cone.txt` — **not** in the build script itself.

### Hard rules

- **If you add a top-level directory that is required at runtime, add it to
  `lxc/sparse-cone.txt` in the same commit.** Omitting it silently drops
  those files from every future LXC template build.
- **All `npm install`/`npm run build` steps run inside `chroot`** against the
  container's own Node.js (NodeSource 24). Never move them to the host/CI
  workspace — native modules (better-sqlite3) must compile for the container's
  ABI, not the runner's.
- **`PUPPETEER_SKIP_DOWNLOAD=true` on every npm step.** The container is
  headless — Chromium download will fail or hang without it.
- **`.git` inside `/opt/meshmonitor` is intentional.** It is what enables
  `meshmonitor-update` to manage future in-place upgrades. Do not add it to
  `.gitignore` or strip it in cleanup steps.
