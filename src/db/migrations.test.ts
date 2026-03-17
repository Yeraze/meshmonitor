import { describe, it, expect } from 'vitest';
import { registry } from './migrations.js';

describe('migrations registry', () => {
  it('has all 87 migrations registered', () => {
    expect(registry.count()).toBe(87);
  });

  it('first migration is auth tables', () => {
    const all = registry.getAll();
    expect(all[0].number).toBe(1);
    expect(all[0].name).toContain('auth');
  });

  it('last migration is the message nodenum BIGINT fix', () => {
    const all = registry.getAll();
    const last = all[all.length - 1];
    expect(last.number).toBe(87);
    expect(last.name).toContain('message_nodenum_bigint');
  });

  it('migrations are sequentially numbered from 1 to 87', () => {
    const all = registry.getAll();
    for (let i = 0; i < all.length; i++) {
      expect(all[i].number).toBe(i + 1);
    }
  });

  it('all migrations have at least one function', () => {
    for (const m of registry.getAll()) {
      const hasFn = m.sqlite || m.postgres || m.mysql;
      expect(hasFn, `Migration ${m.number} (${m.name}) has no functions`).toBeTruthy();
    }
  });

  it('migration 001 is selfIdempotent (uses CREATE TABLE IF NOT EXISTS)', () => {
    const all = registry.getAll();
    expect(all[0].selfIdempotent).toBe(true);
    expect(all[0].settingsKey).toBeFalsy();
  });

  it('old-style migrations (2-46) all have settingsKey', () => {
    const all = registry.getAll();
    // All old-style migrations (002-046) use settingsKey guards since none are truly
    // idempotent — they use ALTER TABLE ADD COLUMN which SQLite doesn't support with
    // IF NOT EXISTS, or INSERT without required NOT NULL columns.
    for (let i = 1; i < 46; i++) {
      const m = all[i];
      expect(m.settingsKey, `Migration ${m.number} should have settingsKey`).toBeTruthy();
      expect(m.selfIdempotent, `Migration ${m.number} should NOT be selfIdempotent`).toBeFalsy();
    }
  });

  it('new-style migrations (47+) have settingsKey', () => {
    const all = registry.getAll();
    for (let i = 46; i < all.length; i++) {
      expect(all[i].settingsKey, `Migration ${all[i].number} should have settingsKey`).toBeTruthy();
    }
  });

  it('all old-style migrations have sqlite function', () => {
    const all = registry.getAll();
    for (let i = 0; i < 46; i++) {
      expect(all[i].sqlite, `Migration ${all[i].number} should have sqlite function`).toBeTruthy();
    }
  });

  it('migrations with postgres/mysql functions start at 47', () => {
    const all = registry.getAll();
    // Old-style should NOT have postgres/mysql
    for (let i = 0; i < 46; i++) {
      expect(all[i].postgres, `Migration ${all[i].number} should not have postgres`).toBeFalsy();
      expect(all[i].mysql, `Migration ${all[i].number} should not have mysql`).toBeFalsy();
    }
  });
});
