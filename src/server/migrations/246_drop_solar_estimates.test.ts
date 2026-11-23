/**
 * migration 246 — drops `solar_estimates` on SQLite and is idempotent.
 * PG/MySQL coverage lives in the `.pgmysql.test.ts` sibling.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './246_drop_solar_estimates.js';
import { migration as migration244 } from './244_purge_shifted_solar_estimates.js';

const exists = (db: Database.Database) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'solar_estimates'`).get() !== undefined;

describe('migration 246 — SQLite', () => {
  it('drops the table and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE solar_estimates (id INTEGER PRIMARY KEY, timestamp INTEGER, watt_hours REAL, fetched_at INTEGER)`);
    db.exec(`INSERT INTO solar_estimates (timestamp, watt_hours, fetched_at) VALUES (1, 2, 3)`);
    migration.up(db);
    expect(exists(db)).toBe(false);
    migration.up(db); // no table: still fine
    expect(exists(db)).toBe(false);
    db.close();
  });

  it('lets 244 re-run after the drop (restore of a pre-244 backup)', () => {
    const db = new Database(':memory:');
    migration.up(db);
    expect(() => migration244.up(db)).not.toThrow();
    db.close();
  });
});
