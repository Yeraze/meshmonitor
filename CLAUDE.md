- Always use context7 when I need code generation, setup or configuration steps, or library/API documentation. This means you should automatically use the Context7 MCP tools to resolve library id and get library docs without me having to explicitly ask.
- Default admin account is username 'admin' and password 'changeme' . Sometime the password is 'changeme1'
- use serena MCP for code search and analysis without me explicitly having to ask.
- use superpowers for planning and workflow management without me having to ask
- IMPORTANT: Review docs/ARCHITECTURE_LESSONS.md before implementing node communication, state management, backup/restore, asynchronous operations, or database changes. These patterns prevent common mistakes.
- Only the backend talks to the Node. the Frontend never talks directly to the node.


## Git Worktree Policy

- **Core application changes** (anything affecting the running app): work directly on the live checkout at `/home/yeraze/Development/meshmonitor`
- **Documentation-only changes** (content for [https://meshmonitor.org](https://meshmonitor.org)) or **CI/CD pipeline-only changes**: may be done in a worktree
- When using a worktree, always start from the latest `origin/main` unless a specific branch or commit is required
- When working in a worktree, **deployment for user review is NOT required** before creating a PR — that requirement applies only to core application features on the main checkout

## Code Modification Rules

- After bulk find-and-replace or sed operations, always verify that modified functions have correct async/await signatures before running tests. Check that route handlers and callbacks are marked async if await was added inside them.

## Multi-Database Architecture (SQLite/PostgreSQL/MySQL)

MeshMonitor supports three database backends. When working with database code:

### Critical Rules
- **ALL database methods in DatabaseService must be async** - Use `methodNameAsync` naming convention
- **Use Drizzle ORM for queries** - Never write raw SQL that isn't database-agnostic
- **Test with SQLite first** - It's the default and most common deployment
- **Node IDs are BIGINT in PostgreSQL/MySQL** - Always coerce to Number when comparing (e.g., `Number(row.nodeNum)`)
- **Boolean columns differ by database** - SQLite uses 0/1, PostgreSQL uses true/false - Drizzle handles this
- **Schema definitions live in `src/db/schema/`** - One file per table, uses Drizzle's database-agnostic types

### Database Service Architecture
```
src/services/database.ts      # Main service - facade over repositories
src/db/
  schema/                     # Drizzle schema definitions (database-agnostic)
  repositories/               # Domain-specific async repositories
  drivers/
    sqlite.ts                 # SQLite driver (better-sqlite3)
    postgres.ts               # PostgreSQL driver (pg)
    mysql.ts                  # MySQL driver (mysql2)
```

### Adding New Database Methods
1. Add async method to the appropriate repository in `src/db/repositories/`
2. Expose it through DatabaseService with `Async` suffix
3. Use Drizzle query builders - they generate correct SQL for each database
4. For raw SQL, use `db.drizzleDbType` to check database type and adjust syntax
5. **IMPORTANT**: When adding routes that use database methods, ensure tests mock the async versions

### Test Mocking Pattern
When tests mock DatabaseService, they must provide async method mocks for authMiddleware:
```typescript
(DatabaseService as any).findUserByIdAsync = vi.fn().mockResolvedValue(user);
(DatabaseService as any).findUserByUsernameAsync = vi.fn().mockResolvedValue(null);
(DatabaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(true);
(DatabaseService as any).getUserPermissionSetAsync = vi.fn().mockResolvedValue({ resources: {}, isAdmin: false });
```

### Database Detection
- `DATABASE_URL` env var triggers PostgreSQL or MySQL based on protocol
- No `DATABASE_URL` = SQLite (default)
- Check `databaseService.drizzleDbType` for runtime database type ('sqlite' | 'postgres' | 'mysql')
- When sending messages for testing, use the "gauntlet" channel. Never send on Primary!
- Always start the Dev environment via docker, and make sure to 'build' first
- You can't have both the Docker and the local npm version running at the same time, or they interfere. If you want to switch, you need to let me know.
- Load up the system on port 8080
- Never push directly to main, always push to a branch.
- Our container doesn't have sqlite3 as a binary available.
- When testing locally, use the docker-compose.dev.yml to build the local code.  Also, always make sure the proper code was deployed once the container is launched.
- Official meshtastic protobuf definitions can be found at https://github.com/meshtastic/protobufs/
- Use shared constants from `src/server/constants/meshtastic.ts` for PortNum, RoutingError, and helper functions - never use magic numbers for protocol values
- When updating the version, make sure you get all five files: package.json, package-lock.json (regenerate via `npm install --package-lock-only --legacy-peer-deps`), helm/meshmonitor/Chart.yaml, desktop/src-tauri/tauri.conf.json, and desktop/package.json
- Prior to creating a PR, make sure to run the tests/system-tests.sh to ensure success and post the output report
- After creating or updating a PR, use the `/ci-monitor` skill to monitor CI status and auto-fix any failures
- When testing, our webserver has BASE_URL configured for /meshmonitor
  Completely shut down the container and tileserver before running system tests

## API Testing Helper Script

Use `scripts/api-test.sh` for authenticated API testing against the running dev container:
```bash
./scripts/api-test.sh login                    # Login and store session
./scripts/api-test.sh get /api/endpoint        # Authenticated GET request
./scripts/api-test.sh post /api/endpoint '{"data":"value"}'  # POST request
./scripts/api-test.sh delete /api/endpoint     # DELETE request
./scripts/api-test.sh logout                   # Clear stored session
```
Default credentials: admin/changeme1. Override with `API_USER` and `API_PASS` env vars.

## Adding New Settings

When adding a new user-configurable setting:
- **MUST** add the key to `src/server/constants/settings.ts` `VALID_SETTINGS_KEYS` — without this, the setting silently fails to save
- In `SettingsTab.tsx`, the `handleSave` `useCallback` has a large dependency array — new `localFoo` state AND the context `setFoo` setter must be added to it, or the save callback uses stale values
- See `src/contexts/SettingsContext.tsx` for the full state/setter/localStorage/server-load pattern

## Database

- This project has three database backends: SQLite, PostgreSQL, and MySQL.
- Schema definitions live in `src/db/schema/` — one file per domain, with separate table definitions per backend (SQLite/PostgreSQL/MySQL).
- When modifying schema, ensure column names and types are consistent across all three backend definitions.

### Migration Registry System

Migrations use a centralized registry in `src/db/migrations.ts`. Each migration is registered with functions for all three backends.

**Adding a new migration:**
1. Create `src/server/migrations/NNN_description.ts` with:
   - `export const migration = { up: (db: Database) => {...} }` for SQLite
   - `export async function runMigrationNNNPostgres(client)` for PostgreSQL
   - `export async function runMigrationNNNMysql(pool)` for MySQL
2. Register it in `src/db/migrations.ts` with `registry.register({ number, name, settingsKey, sqlite, postgres, mysql })`
3. Update `src/db/migrations.test.ts` (count, last migration name)
4. Make migrations **idempotent** — use try/catch for SQLite (`duplicate column`), `IF NOT EXISTS` for PostgreSQL, `information_schema` checks for MySQL
5. **Column naming**: SQLite uses `snake_case`, PostgreSQL/MySQL use `camelCase` (quoted in PG raw SQL)

**Current migration count:** 22 (latest: `022_add_source_id_to_permissions`)

## Testing

- When migrating test mocks from sync to async patterns, use `mockResolvedValue` instead of `mockReturnValue` for any mocked function that is now async/returns a Promise.
- All tests must pass (0 failures) before creating a PR. Run the full test suite, not just targeted tests, before committing migration or refactor work.

## Key Repair / NodeInfo Exchange Routing

When sending NodeInfo exchanges for key repair (auto-key management, immediate purge, or manual button), always send on the **node's channel**, not as a DM. PKI-encrypted DMs use the stored key, which is wrong when there's a key mismatch. Channel routing uses the shared PSK which works regardless.
