import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';

describe('VariableResolver', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: AutomationVariablesRepository;
  let resolver: VariableResolver;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new AutomationVariablesRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(repo);
  });

  afterEach(() => db.close());

  it('returns null for an unknown variable', async () => {
    expect(await resolver.getValue('nope', {})).toBeNull();
  });

  it('reads the configured default of a constant when nothing is stored', async () => {
    await repo.createVariable({
      name: 'lowBattery',
      type: 'integer',
      scope: 'global',
      readonly: true,
      config: JSON.stringify({ defaultValue: 20 }),
    });
    expect(await resolver.getValue('lowBattery', {})).toBe(20);
  });

  it('rejects writes to a readonly constant', async () => {
    await repo.createVariable({ name: 'thr', type: 'integer', scope: 'global', readonly: true });
    const r = await resolver.setValue('thr', 5, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/readonly/);
  });

  it('rejects values not representable as the type', async () => {
    await repo.createVariable({ name: 'n', type: 'integer', scope: 'global' });
    expect((await resolver.setValue('n', 'abc', {})).ok).toBe(false);
  });

  it('round-trips a typed value through set/get', async () => {
    await repo.createVariable({ name: 'temp', type: 'float', scope: 'node' });
    await resolver.setValue('temp', 21.5, { nodeNum: 7 });
    expect(await resolver.getValue('temp', { nodeNum: 7 })).toBe(21.5);
    // different node is independent
    expect(await resolver.getValue('temp', { nodeNum: 8 })).toBeNull();
  });

  it('errors when scope context is missing', async () => {
    await repo.createVariable({ name: 'perNode', type: 'integer', scope: 'node' });
    const r = await resolver.setValue('perNode', 1, {}); // no nodeNum
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing scope context/);
  });

  it('binds sourceNode scope to source+node', async () => {
    await repo.createVariable({ name: 'sn', type: 'string', scope: 'sourceNode' });
    await resolver.setValue('sn', 'hi', { sourceId: 'srcA', nodeNum: 5 });
    expect(await resolver.getValue('sn', { sourceId: 'srcA', nodeNum: 5 })).toBe('hi');
    expect(await resolver.getValue('sn', { sourceId: 'srcB', nodeNum: 5 })).toBeNull();
  });

  describe('flags', () => {
    it('arms with TTL and auto-clears after expiry', async () => {
      await repo.createVariable({
        name: 'welcomed',
        type: 'flag',
        scope: 'node',
        config: JSON.stringify({ flagDurationSeconds: 60 }),
      });
      const t0 = 1_000_000;
      await resolver.setFlag('welcomed', { nodeNum: 9 }, t0);
      expect(await resolver.getValue('welcomed', { nodeNum: 9 }, t0 + 30_000)).toBe(true);
      expect(await resolver.getValue('welcomed', { nodeNum: 9 }, t0 + 61_000)).toBeNull();
    });

    it('clears a flag explicitly', async () => {
      await repo.createVariable({ name: 'f', type: 'flag', scope: 'global' });
      await resolver.setFlag('f', {});
      expect(await resolver.getValue('f', {})).toBe(true);
      await resolver.clearFlag('f', {});
      expect(await resolver.getValue('f', {})).toBeNull();
    });
  });

  describe('increment', () => {
    it('seeds from 0 and accumulates', async () => {
      await repo.createVariable({ name: 'count', type: 'integer', scope: 'global' });
      await resolver.increment('count', 1, {});
      await resolver.increment('count', 2, {});
      expect(await resolver.getValue('count', {})).toBe(3);
    });

    it('refuses non-numeric variables', async () => {
      await repo.createVariable({ name: 's', type: 'string', scope: 'global' });
      expect((await resolver.increment('s', 1, {})).ok).toBe(false);
    });
  });
});
