---
name: migration
description: Scaffold a new database migration across all three backends (SQLite/PostgreSQL/MySQL), register it, and update the count test. Use when adding/altering a table or column.
---

Create a new MeshMonitor migration. Migrations run on every boot against whichever backend is configured, so **all three** must be implemented and idempotent.

## Arguments
$ARGUMENTS

A short description of the schema change (e.g. "add isPinned to messages"). Convert to `snake_case` for the migration name.

## Step 0: Determine the next number (never hardcode)

```bash
ls src/server/migrations/ | grep -E '^[0-9]{3}_' | sort | tail -1
```
Take the highest `NNN` and add 1. Zero-pad to 3 digits (`NNN`). Confirm it's free on current `origin/main` — if another in-flight branch already claimed it, bump again to avoid a collision on merge.

## Step 1: Schema change (if adding/altering columns)

Edit `src/db/schema/<table>.ts` — it defines the table **three times** (sqlite / postgres / mysql). Update all three:
- SQLite columns are `snake_case`; PostgreSQL/MySQL use `camelCase`.
- Node IDs / packet IDs are **BIGINT** in PG/MySQL (`nodeNum` is unsigned 32-bit; PG/MySQL `INTEGER` is signed 32-bit and overflows). Coerce with `Number(row.x)` at read sites.
- Booleans: SQLite 0/1, PG/MySQL true/false — Drizzle handles it.
- If this is per-source data, add a `sourceId` column to all three (unless it's global-by-design like `channel_database`/`estimated_positions`), and plan a backfill of existing rows with the default source.

## Step 2: Create `src/server/migrations/NNN_<name>.ts`

Mirror an existing recent one (e.g. `096_meshcore_neighbor_timestamp_bigint.ts`). It must export:
- `export const migration = { up: (db: Database) => {...} }` — SQLite
- `export async function runMigrationNNNPostgres(client) {...}` — PostgreSQL
- `export async function runMigrationNNNMysql(pool) {...}` — MySQL

**Idempotency is mandatory** (migrations may re-run / partially-applied DBs exist):
- SQLite: wrap `ALTER TABLE … ADD COLUMN` in try/catch and swallow `duplicate column`.
- PostgreSQL: `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`.
- MySQL: guard with an `information_schema.columns` / `information_schema.tables` existence check (MySQL has no `IF NOT EXISTS` for `ADD COLUMN` on older versions).

Raw SQL **is** allowed inside `src/server/migrations/**` (it's exempt from the ESLint raw-SQL ban). Branch dialect-specific syntax on the backend.

## Step 3: Register in `src/db/migrations.ts`

1. Add the import near the other `NNN` imports (top of file):
   ```ts
   import { migration as <name>Migration, runMigrationNNNPostgres as <name>Postgres, runMigrationNNNMysql as <name>Mysql } from '../server/migrations/NNN_<name>.js';
   ```
   (Note the `.js` extension — these are ESM imports.)
2. Add the registration (keep them in numeric order):
   ```ts
   registry.register({
     number: NNN,
     name: '<name>',
     settingsKey: 'migration_NNN_<name>',
     sqlite: (db) => <name>Migration.up(db),
     postgres: (client) => <name>Postgres(client),
     mysql: (pool) => <name>Mysql(pool),
   });
   ```

## Step 4: Update `src/db/migrations.test.ts`

Two assertions are pinned to the latest migration — update both:
- `expect(registry.count()).toBe(NNN);`
- the `last migration is …` block: `expect(last.number).toBe(NNN);` and `expect(last.name).toContain('<name>');`

## Step 5: Verify

```bash
npx vitest run src/db/migrations.test.ts --reporter=json --outputFile=/tmp/mig.json >/dev/null 2>&1
python3 -c "import json; d=json.load(open('/tmp/mig.json')); print('success:', d['success'], 'failed:', d['numFailedTests'])"
npx tsc -p tsconfig.server.json --noEmit
```
Confirm `success: true`. Then run the full suite before a PR (migration changes can ripple). To exercise the migration against a real DB, `/deploy` and check the startup logs for the `migration_NNN_*` run, and test SQLite first (the default, most common deployment).

## Step 6: Report
- Migration number + name, the tables/columns touched (and which backends), how you confirmed the number was free, and test/tsc results.
