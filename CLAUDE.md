# MeshMonitor — Claude Agent Brief

**Version:** 4.11.3 (multi-source architecture)
**Stack:** React 19 + TS + Vite frontend / Node.js 20+ (Docker image ships Node 24; CI matrix covers 20/22/24/25) + Express 5 + TS backend / SQLite (default), PostgreSQL, MySQL via Drizzle ORM / Meshtastic protobuf-over-TCP and MeshCore (native `meshcore.js` for companion, serial CLI for repeater) through a per-source manager registry.

## Read order for new agents

1. **This file** — invariants, rules, and gotchas. Skim end-to-end.
2. **`docs/internal/dev-notes/ARCHITECTURE_LESSONS.md`** — MUST-READ before touching node communication, state management, backup/restore, async operations, multi-database, or multi-source.
3. **`docs/internal/dev-notes/MESHCORE_REMOTE_ADMIN.md`** — MUST-READ before touching MeshCore CLI/admin routes, the credential store, the danger guard, or the shared `CliConsoleBody` primitive.
4. **`src/server/sourceManagerRegistry.ts`** + **`src/server/meshtasticManager.ts`** — read these two before any feature touching nodes/messages/telemetry. There is no global `meshtasticManager` singleton; everything is per-source.
5. **One repository under `src/db/repositories/`** (e.g. `auth.ts`) — read before adding a query. Raw SQL outside this directory is ESLint-banned.

## Where things live

| Subsystem | Primary files |
|-----------|---------------|
| Multi-source registry | `src/server/sourceManagerRegistry.ts`, `src/server/meshtasticManager.ts`, `src/server/meshcoreManager.ts` (parallel Meshcore protocol; not a fallback), `src/contexts/SourceContext.tsx` |
| Auth + permissions | `src/server/auth/`, `src/db/repositories/auth.ts`, `src/db/repositories/permissions.ts` |
| Database backends | `src/db/drivers/{sqlite,postgres,mysql}.ts`, `src/db/schema/`, `src/db/repositories/` |
| Migrations | `src/server/migrations/NNN_*.ts` (75+ total), registry in `src/db/migrations.ts` |
| Backup/restore | `src/server/services/systemBackupService.ts`, `systemRestoreService.ts` |
| Routes | `src/server/routes/*` |
| Packet monitors | Meshtastic: `packet_log` table + `packetLogService.ts` + `packetRoutes.ts` + `PacketMonitorPanel.tsx`. MeshCore (OTA via `LogRxData`): `meshcore_packet_log` table + `meshcorePacketLogService.ts` + `/packets` routes in `meshcoreRoutes.ts` + `MeshCorePacketMonitorView.tsx`. Both opt-in (`*_packet_log_enabled`). |
| Frontend pages | `src/pages/*` (`Unified*Page` = multi-source aware) |
| ESLint config | `eslint.config.mjs` (raw-SQL ban lives here) |

## Hard rules

- **Backend talks to nodes; frontend never does.** All node IO goes through `sourceManagerRegistry.getManager(sourceId)`.
- **Per-source scoping is mandatory.** Every query against nodes/messages/telemetry/traceroutes/etc. must take a `sourceId`. Search `src/db/schema/` for `sourceId` to enumerate.
- **No raw SQL outside `src/db/repositories/` and `src/server/migrations/`.** ESLint-enforced via `no-restricted-syntax` in `eslint.config.mjs`.
- **All DatabaseService methods are async** (`Async` suffix). Tests mock with `mockResolvedValue`.
- **Never push directly to main. Always use a branch.**
- After bulk find-and-replace or sed, verify modified functions have correct `async`/`await` signatures. Route handlers and callbacks need `async` if `await` was added inside.

## Multi-Source Architecture (4.x)

MeshMonitor 4.x supports **N concurrent Meshtastic node connections** ("sources"). Pre-4.0 code that referenced a singleton `meshtasticManager` is now a `@deprecated` JSDoc-tagged compatibility shim at the bottom of `src/server/meshtasticManager.ts` — IDEs will strikethrough usages but `tsc` does not error.

### Critical Rules
- **No global `meshtasticManager` singleton.** Look up per-source instances via `sourceManagerRegistry.getManager(sourceId)`.
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

### Raw SQL Ban
- `src/services/database.ts` is raw-SQL-free. All domain queries live in `src/db/repositories/*`.
- ESLint rule (`no-restricted-syntax` in `eslint.config.mjs`) forbids `this.db.prepare`, `this.db.exec`, `postgresPool.query`, `mysqlPool.query` outside `src/server/migrations/**` and test files.
- Intentional exceptions must carry `// eslint-disable-next-line no-restricted-syntax -- <reason>`.

### Migration Registry
Migrations use a centralized registry in `src/db/migrations.ts`. Each migration has functions for all three backends.

**Current migration count:** 107 (latest: `107_clear_null_island_positions`).

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

## Workflow

- System tests (`tests/system-tests.sh`) are run by CI on every PR. Do not run them locally as part of normal feature or bugfix work — only run them locally when you are specifically debugging a system-test failure.
- After creating or updating a PR, use the `/ci-monitor` skill to monitor CI status and auto-fix any failures (system-test regressions show up there).
- All tests must pass (0 failures) before creating a PR. Run the full Vitest suite, not just targeted tests, before committing migration or refactor work.
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
3. Update `src/db/migrations.test.ts` (count, last migration name).
4. Make migrations **idempotent** — try/catch for SQLite (`duplicate column`), `IF NOT EXISTS` for PostgreSQL, `information_schema` checks for MySQL.

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
- **MUST** add the key to `src/server/constants/settings.ts` `VALID_SETTINGS_KEYS` — without this, the setting silently fails to save.
- In `SettingsTab.tsx`, the `handleSave` `useCallback` has a large dependency array — new `localFoo` state AND the context `setFoo` setter must be added to it, or the save callback uses stale values.
- See `src/contexts/SettingsContext.tsx` for the full state/setter/localStorage/server-load pattern.

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
