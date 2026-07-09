/**
 * Registry-derived migration invariants.
 *
 * All structural assertions are derived from the registry at runtime — no
 * hardcoded count or last-migration name.  Adding a new migration to
 * migrations.ts does NOT require any changes to this file.
 *
 * Note: MigrationRegistry.register() already throws at module-load time if
 * a migration is registered with a duplicate number or out of sequential
 * order, so simply importing `registry` exercises those constraints.
 */
import { describe, it, expect } from 'vitest';
import { registry } from './migrations.js';

describe('migrations registry', () => {
  it('highest migration number equals registry count (no gaps)', () => {
    const all = registry.getAll();
    expect(all.length).toBeGreaterThan(0);
    expect(all[all.length - 1].number).toBe(all.length);
  });

  it('migration names are unique', () => {
    const all = registry.getAll();
    const names = all.map((m) => m.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('migrations are sequentially numbered from 1 to N', () => {
    const all = registry.getAll();
    for (let i = 0; i < all.length; i++) {
      expect(all[i].number).toBe(i + 1);
    }
  });

  it('first migration is v37 baseline', () => {
    const all = registry.getAll();
    expect(all[0].number).toBe(1);
    expect(all[0].name).toContain('v37_baseline');
  });

  it('all migrations have at least one function', () => {
    for (const m of registry.getAll()) {
      const hasFn = m.sqlite || m.postgres || m.mysql;
      expect(hasFn, `Migration ${m.number} (${m.name}) has no functions`).toBeTruthy();
    }
  });

  it('all migrations have sqlite, postgres, and mysql functions', () => {
    const all = registry.getAll();
    for (const m of all) {
      expect(m.sqlite, `Migration ${m.number} should have sqlite function`).toBeTruthy();
      expect(m.postgres, `Migration ${m.number} should have postgres function`).toBeTruthy();
      expect(m.mysql, `Migration ${m.number} should have mysql function`).toBeTruthy();
    }
  });

  it('migration 001 is selfIdempotent', () => {
    const all = registry.getAll();
    expect(all[0].selfIdempotent).toBe(true);
    expect(all[0].settingsKey).toBeFalsy();
  });

  it('only migration 001 is selfIdempotent', () => {
    const all = registry.getAll();
    for (let i = 1; i < all.length; i++) {
      expect(all[i].selfIdempotent, `Migration ${all[i].number} should NOT be selfIdempotent`).toBeFalsy();
    }
  });

  it('migrations 002+ all have settingsKey', () => {
    const all = registry.getAll();
    for (let i = 1; i < all.length; i++) {
      expect(all[i].settingsKey, `Migration ${all[i].number} should have settingsKey`).toBeTruthy();
    }
  });
});
