import { describe, it, expect } from 'vitest';
import { registry } from './migrations.js';

describe('migrations registry', () => {
  it('has all 55 migrations registered', () => {
    expect(registry.count()).toBe(55);
  });

  it('first migration is v37 baseline', () => {
    const all = registry.getAll();
    expect(all[0].number).toBe(1);
    expect(all[0].name).toContain('v37_baseline');
  });

  it('last migration is seed_global_waypoints_permission', () => {
    const all = registry.getAll();
    const last = all[all.length - 1];
    expect(last.number).toBe(55);
    expect(last.name).toContain('seed_global_waypoints_permission');
  });

  it('migrations are sequentially numbered from 1 to 55', () => {
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
