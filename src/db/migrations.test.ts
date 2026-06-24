import { describe, it, expect } from 'vitest';
import { registry } from './migrations.js';

describe('migrations registry', () => {
  // The 4.11.x release line excludes the Automation Engine (#3653). Its former
  // migrations were renumbered so the line stays contiguous: total is 102 with
  // sequential numbers 1–102 and no gaps.
  it('has all 102 migrations registered', () => {
    expect(registry.count()).toBe(102);
  });

  // Bumping these counts: when adding a new migration, increment to <N>+1 and
  // update the "last migration is …" assertion below.

  it('first migration is v37 baseline', () => {
    const all = registry.getAll();
    expect(all[0].number).toBe(1);
    expect(all[0].name).toContain('v37_baseline');
  });

  it('last migration is add_channel_database_hash', () => {
    const all = registry.getAll();
    const last = all[all.length - 1];
    expect(last.number).toBe(102);
    expect(last.name).toContain('add_channel_database_hash');
  });

  it('migrations are sequential 1..N with no gaps', () => {
    const all = registry.getAll();
    for (let i = 0; i < all.length; i++) {
      expect(all[i].number).toBe(i + 1);
    }
    const numbers = all.map((m) => m.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('all migrations have at least one function', () => {
    for (const m of registry.getAll()) {
      const hasFn = m.sqlite || m.postgres || m.mysql;
      expect(hasFn, `Migration ${m.number} (${m.name}) has no functions`).toBeTruthy();
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

  it('migrations 002-013 all have settingsKey', () => {
    const all = registry.getAll();
    for (let i = 1; i < all.length; i++) {
      expect(all[i].settingsKey, `Migration ${all[i].number} should have settingsKey`).toBeTruthy();
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
});
