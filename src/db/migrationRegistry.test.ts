import { describe, it, expect } from 'vitest';
import { MigrationRegistry } from './migrationRegistry.js';

describe('MigrationRegistry', () => {
  it('registers and returns migrations in order', () => {
    const registry = new MigrationRegistry();
    registry.register({ number: 1, name: 'first', sqlite: () => {} });
    registry.register({ number: 2, name: 'second', sqlite: () => {} });
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].number).toBe(1);
    expect(all[1].number).toBe(2);
  });

  it('prevents duplicate registration', () => {
    const registry = new MigrationRegistry();
    registry.register({ number: 1, name: 'first', sqlite: () => {} });
    expect(() => {
      registry.register({ number: 1, name: 'duplicate', sqlite: () => {} });
    }).toThrow('Migration 1 already registered');
  });

  it('enforces sequential numbering', () => {
    const registry = new MigrationRegistry();
    registry.register({ number: 1, name: 'first', sqlite: () => {} });
    expect(() => {
      registry.register({ number: 3, name: 'skipped', sqlite: () => {} });
    }).toThrow('Migration 3 registered out of order');
  });

  it('filters migrations from a starting number', () => {
    const registry = new MigrationRegistry();
    registry.register({ number: 1, name: 'first', sqlite: () => {} });
    registry.register({ number: 2, name: 'second', postgres: async () => {} });
    registry.register({ number: 3, name: 'third', postgres: async () => {} });
    const from2 = registry.getFrom(2);
    expect(from2).toHaveLength(2);
    expect(from2[0].number).toBe(2);
  });

  it('returns count', () => {
    const registry = new MigrationRegistry();
    expect(registry.count()).toBe(0);
    registry.register({ number: 1, name: 'first' });
    expect(registry.count()).toBe(1);
  });

  it('supports selfIdempotent flag', () => {
    const registry = new MigrationRegistry();
    registry.register({ number: 1, name: 'old-style', selfIdempotent: true, sqlite: () => {} });
    expect(registry.getAll()[0].selfIdempotent).toBe(true);
  });
});
