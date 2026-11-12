/**
 * Shared in-memory SQLite test database built from the REAL migration registry.
 *
 * Before this helper, ~40 non-migration test files hand-rolled `CREATE TABLE`
 * statements per backend. That copy-pasted DDL drifted from `src/db/schema/`:
 * a single schema column add broke N tests, and the PG/MySQL copies (only run
 * in CI) silently diverged — exactly what bit #3495. `createTestDb()` runs the
 * actual registered SQLite migrations against a fresh `:memory:` database, so
 * every test gets the production schema and a schema change is a single edit.
 *
 * Use this for repository/service unit tests. Migration-state tests that need
 * a bespoke historical schema should keep their own DDL.
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { registry } from '../../db/migrations.js';
import * as schema from '../../db/schema/index.js';

export interface TestDb {
  /** Raw better-sqlite3 connection (for direct DDL/inserts in a test). */
  sqlite: Database.Database;
  /** Drizzle instance bound to the full schema. */
  db: BetterSQLite3Database<typeof schema>;
  /** Close the connection (call in afterEach). */
  close(): void;
}

/**
 * Run every registered SQLite migration against `sqlite`, as production does
 * for a fresh install.
 */
function applyAllMigrations(sqlite: Database.Database): void {
  // The baseline migration (001) creates the real `settings` table — do NOT
  // pre-create it (a minimal stub would block the full CREATE TABLE IF NOT
  // EXISTS). These helpers are defensive for the brief window before `settings`
  // exists (the first migration that reads/writes it is the baseline itself).
  const getSetting = (key: string): string | null => {
    try {
      const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  };
  const setSetting = (key: string, value: string): void => {
    try {
      sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    } catch {
      /* settings table not created yet — ignore */
    }
  };

  for (const migration of registry.getAll()) {
    if (!migration.sqlite) continue;
    // Both self-idempotent (001-046) and settings-key-guarded migrations take
    // the same (db, getSetting, setSetting) signature in production.
    // `as any`: migrations type their first arg as better-sqlite3's `Database`,
    // which is structurally what we pass; the cast just bridges the nominal type
    // (same pattern as the production migration loop in database.ts).
    migration.sqlite(sqlite as any, getSetting, setSetting);
    if (migration.settingsKey) setSetting(migration.settingsKey, 'completed');
  }
}

/**
 * The migrated database, built once per test file and copied for each call.
 *
 * Running all ~230 migrations costs ~150-200 ms, and many suites call
 * `createTestDb()` in `beforeEach`. Serializing the migrated database once and
 * opening a copy (`new Database(buffer)`, ~1 ms) gives every call the same
 * schema and seed rows at a fraction of the cost. Each copy is its own
 * in-memory database: writes to one never reach the template or another copy.
 *
 * Connection-level pragmas are not part of the serialized image, so the ones
 * migrations touch are read from the build connection and replayed on every
 * copy, leaving each copy in the state a freshly migrated DB would be in.
 */
interface TestDbTemplate {
  image: Buffer;
  foreignKeys: number;
  legacyAlterTable: number;
}
let template: TestDbTemplate | null = null;

function getTemplate(): TestDbTemplate {
  if (template) return template;
  const build = new Database(':memory:');
  try {
    applyAllMigrations(build);
    template = {
      image: build.serialize(),
      foreignKeys: build.pragma('foreign_keys', { simple: true }) as number,
      legacyAlterTable: build.pragma('legacy_alter_table', { simple: true }) as number,
    };
  } finally {
    build.close();
  }
  return template;
}

/**
 * Create a fresh in-memory SQLite database with the full current schema applied
 * via the migration registry (migration 001 baseline + all subsequent ALTERs).
 *
 * Every call returns an independent database copied from a per-file template
 * (see {@link getTemplate}).
 */
export function createTestDb(): TestDb {
  const { image, foreignKeys, legacyAlterTable } = getTemplate();
  const sqlite = new Database(image);
  sqlite.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  sqlite.pragma(`legacy_alter_table = ${legacyAlterTable ? 'ON' : 'OFF'}`);

  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    close: () => sqlite.close(),
  };
}
