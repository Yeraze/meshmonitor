/**
 * Post-incident guard (#3657).
 *
 * The migration suite previously only ever ran the full registry against a DB
 * with ZERO sources registered (see `createTestDb`). Many migrations do
 * source-dependent work gated behind `if (sources.length > 0)` — that whole
 * branch was never exercised by unit CI, which is exactly how #3657 shipped:
 * migration 033's `UPDATE channel_database SET sourceId ...` only runs when a
 * source exists, and it crashed (`no such column / column "sourceId" does not
 * exist`) once #3640 stopped migration 021 from adding that column.
 *
 * This test replays the full SQLite migration registry and registers a source
 * the moment the `sources` table exists (migration 020), so every subsequent
 * source-dependent migration runs its populated-source path. A future
 * "033-style" missing-column-with-a-source regression now fails here in plain
 * unit CI instead of only on the hardware system-test gate.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { registry } from './migrations.js';

function sourcesTableExists(db: Database.Database): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sources'`).get();
}

describe('migrations — full registry runs with a source registered (#3657 guard)', () => {
  it('every SQLite migration completes without throwing when a source is present', () => {
    const sqlite = new Database(':memory:');
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

    let sourceRegistered = false;
    let registeredAtMigration = -1;

    for (const m of registry.getAll()) {
      if (!m.sqlite) continue;
      try {
        m.sqlite(sqlite as any, getSetting, setSetting);
      } catch (e) {
        throw new Error(
          `Migration ${m.number} (${m.name}) threw with a source registered: ${(e as Error).message}`,
        );
      }
      if (m.settingsKey) setSetting(m.settingsKey, 'completed');

      // Register a source as soon as the table exists (migration 020) so every
      // later source-dependent migration runs its `sources.length > 0` path.
      if (!sourceRegistered && sourcesTableExists(sqlite)) {
        sqlite
          .prepare(
            `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('guard-src', 'Guard Source', 'meshtastic', '{}', 1, 0, 0);
        sourceRegistered = true;
        registeredAtMigration = m.number;
      }
    }

    // Sanity: a source must actually have been present while the
    // source-dependent migrations (021+) ran, or the guard proves nothing.
    expect(sourceRegistered).toBe(true);
    expect(registeredAtMigration).toBeGreaterThan(0);
    expect(registeredAtMigration).toBeLessThan(33); // before migration 033 (#3657)

    sqlite.close();
  });
});
