/**
 * Unit tests for the fail-closed withSourceScope mechanism (Task 1.1).
 *
 * BaseRepository is abstract and withSourceScope is protected — expose it
 * through a minimal concrete Probe subclass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BaseRepository, ALL_SOURCES } from './base.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import type { TestDb } from '../../server/test-helpers/testDb.js';

// ---------------------------------------------------------------------------
// Probe — thin concrete subclass that exposes the protected helper
// ---------------------------------------------------------------------------
class Probe extends BaseRepository {
  runScope(table: any, sid: any) {
    return this.withSourceScope(table, sid);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('withSourceScope — fail-closed mechanism', () => {
  let t: TestDb;
  let probe: Probe;

  beforeEach(() => {
    t = createTestDb();
    probe = new Probe(t.db, 'sqlite');
  });

  afterEach(() => t.close());

  it('throws on undefined', () => {
    const { nodes } = (probe as any).tables;
    expect(() => probe.runScope(nodes, undefined)).toThrow(
      /sourceId is required/,
    );
  });

  it('throws on null', () => {
    const { nodes } = (probe as any).tables;
    expect(() => probe.runScope(nodes, null)).toThrow(
      /sourceId is required/,
    );
  });

  it('throws on empty string', () => {
    const { nodes } = (probe as any).tables;
    expect(() => probe.runScope(nodes, '')).toThrow(
      /sourceId is required/,
    );
  });

  it('returns a defined SQL condition for a concrete sourceId', () => {
    const { nodes } = (probe as any).tables;
    const result = probe.runScope(nodes, 'default');
    expect(result).toBeDefined();
    expect(result).not.toBeUndefined();
  });

  it('returns undefined (no WHERE clause) for ALL_SOURCES sentinel', () => {
    const { nodes } = (probe as any).tables;
    const result = probe.runScope(nodes, ALL_SOURCES);
    expect(result).toBeUndefined();
  });
});
