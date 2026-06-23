/**
 * Automation Variables Repository Tests (#3653, §5.2)
 *
 * Definitions CRUD + scoped value get/set + flag TTL semantics against a real
 * in-memory SQLite database (migration 099 applied via createTestDb).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationVariablesRepository } from './automationVariables.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('AutomationVariablesRepository', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: AutomationVariablesRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new AutomationVariablesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  // ─── scope key builder ────────────────────────────────────────────────────

  describe('buildScopeKey', () => {
    it('encodes each scope', () => {
      expect(AutomationVariablesRepository.buildScopeKey('global', {})).toBe('');
      expect(AutomationVariablesRepository.buildScopeKey('source', { sourceId: 'src1' })).toBe('src1');
      expect(AutomationVariablesRepository.buildScopeKey('node', { nodeNum: 123 })).toBe('123');
      expect(AutomationVariablesRepository.buildScopeKey('sourceNode', { sourceId: 'src1', nodeNum: 123 })).toBe('src1:123');
    });

    it('returns null when required context is missing', () => {
      expect(AutomationVariablesRepository.buildScopeKey('source', {})).toBeNull();
      expect(AutomationVariablesRepository.buildScopeKey('node', { sourceId: 'src1' })).toBeNull();
      expect(AutomationVariablesRepository.buildScopeKey('sourceNode', { sourceId: 'src1' })).toBeNull();
    });
  });

  // ─── definitions ──────────────────────────────────────────────────────────

  it('creates and reads a definition (by id and name)', async () => {
    const v = await repo.createVariable({
      name: 'lowBatteryThreshold',
      description: 'alert below this %',
      type: 'integer',
      scope: 'global',
      readonly: true,
      config: JSON.stringify({ defaultValue: 20 }),
    });

    expect(v.id).toBeTruthy();
    expect(v.name).toBe('lowBatteryThreshold');
    expect(v.type).toBe('integer');
    expect(v.scope).toBe('global');
    expect(v.readonly).toBe(true);

    expect((await repo.getVariable(v.id))!.name).toBe('lowBatteryThreshold');
    expect((await repo.getVariableByName('lowBatteryThreshold'))!.id).toBe(v.id);
  });

  it('enforces unique names', async () => {
    await repo.createVariable({ name: 'dupe', type: 'string', scope: 'global' });
    await expect(repo.createVariable({ name: 'dupe', type: 'string', scope: 'global' })).rejects.toThrow();
  });

  it('updates a definition', async () => {
    const v = await repo.createVariable({ name: 'x', type: 'integer', scope: 'global' });
    const updated = await repo.updateVariable(v.id, { description: 'hi', readonly: true });
    expect(updated!.description).toBe('hi');
    expect(updated!.readonly).toBe(true);
    expect(updated!.type).toBe('integer'); // untouched
  });

  it('deletes a definition and its values', async () => {
    const v = await repo.createVariable({ name: 'counter', type: 'integer', scope: 'global' });
    await repo.setValue(v.id, '', '5');

    expect(await repo.deleteVariable(v.id)).toBe(true);
    expect(await repo.getVariable(v.id)).toBeNull();
    expect(await repo.getRawValue(v.id, '')).toBeNull();
  });

  // ─── values ────────────────────────────────────────────────────────────────

  it('upserts a scoped value', async () => {
    const v = await repo.createVariable({ name: 'seen', type: 'integer', scope: 'node' });

    await repo.setValue(v.id, '123', '1');
    expect(await repo.getEffectiveValue(v.id, '123')).toBe('1');

    // upsert replaces, does not duplicate
    await repo.setValue(v.id, '123', '2');
    expect(await repo.getEffectiveValue(v.id, '123')).toBe('2');

    // different scopeKey is independent
    expect(await repo.getEffectiveValue(v.id, '456')).toBeNull();
  });

  it('clears a scoped value', async () => {
    const v = await repo.createVariable({ name: 'note', type: 'string', scope: 'global' });
    await repo.setValue(v.id, '', 'hello');
    await repo.clearValue(v.id, '');
    expect(await repo.getEffectiveValue(v.id, '')).toBeNull();
  });

  it('treats an expired flag value as absent (auto-clear)', async () => {
    const v = await repo.createVariable({
      name: 'welcomed',
      type: 'flag',
      scope: 'node',
      config: JSON.stringify({ flagDurationSeconds: 60 }),
    });

    const t0 = 1_000_000;
    await repo.setValue(v.id, '123', 'true', t0 + 60_000); // expires 60s later

    // still within window
    expect(await repo.getEffectiveValue(v.id, '123', t0 + 30_000)).toBe('true');
    // raw row still present
    expect((await repo.getRawValue(v.id, '123'))!.value).toBe('true');
    // after expiry → reads as absent
    expect(await repo.getEffectiveValue(v.id, '123', t0 + 61_000)).toBeNull();
  });

  it('prunes expired values via sweep', async () => {
    const v = await repo.createVariable({ name: 'f', type: 'flag', scope: 'global' });
    const t0 = 1_000_000;
    await repo.setValue(v.id, '', 'true', t0 + 10_000); // expires
    await repo.setValue(v.id, 'src1', 'true', null);    // never expires

    const removed = await repo.pruneExpired(t0 + 20_000);
    expect(removed).toBe(1);
    expect(await repo.getRawValue(v.id, '')).toBeNull();
    expect((await repo.getRawValue(v.id, 'src1'))!.value).toBe('true');
  });
});
