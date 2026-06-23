import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { evaluateCondition } from './conditionEvaluator.js';
import type { EngineEvalContext } from './engineContext.js';
import type { TriggerContext } from './triggerContext.js';
import type { AutomationNode } from '../../../types/automation.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';

describe('evaluateCondition', () => {
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

  function ctx(
    fields: Record<string, unknown>,
    opts: { sourceId?: string | null; nodeNum?: number | null; now?: number; node?: any; telemetry?: Record<string, number> } = {},
  ): EngineEvalContext {
    const trigger: TriggerContext = {
      triggerType: 'trigger.message',
      sourceId: opts.sourceId ?? 'default',
      subjectNodeNum: opts.nodeNum ?? 111,
      timestamp: opts.now ?? 1000,
      fields,
    };
    return {
      trigger,
      vars: resolver,
      data: {
        getNode: async () => opts.node ?? null,
        getTelemetry: async (_s, _n, type) => opts.telemetry?.[type] ?? null,
      },
      varCtx: { sourceId: trigger.sourceId, nodeNum: trigger.subjectNodeNum },
      now: opts.now ?? 1000,
    };
  }
  const node = (type: string, params: Record<string, unknown>): AutomationNode =>
    ({ id: 'c', type: type as any, params });

  it('sourceFilter: empty = pass; membership respected', async () => {
    expect(await evaluateCondition(node('condition.sourceFilter', {}), ctx({}))).toBe(true);
    expect(await evaluateCondition(node('condition.sourceFilter', { sourceIds: ['default'] }), ctx({}))).toBe(true);
    expect(await evaluateCondition(node('condition.sourceFilter', { sourceIds: ['other'] }), ctx({}))).toBe(false);
  });

  it('numeric: compares a trigger field (hops == 0)', async () => {
    expect(await evaluateCondition(node('condition.numeric', { field: 'hops', op: '==', value: 0 }), ctx({ hops: 0 }))).toBe(true);
    expect(await evaluateCondition(node('condition.numeric', { field: 'hops', op: '==', value: 0 }), ctx({ hops: 2 }))).toBe(false);
  });

  it('numeric: compares a hydrated node field (battery < 20)', async () => {
    const n = node('condition.numeric', { field: 'node.batteryLevel', op: '<', value: 20 });
    expect(await evaluateCondition(n, ctx({}, { node: { nodeNum: 111, batteryLevel: 15 } }))).toBe(true);
    expect(await evaluateCondition(n, ctx({}, { node: { nodeNum: 111, batteryLevel: 80 } }))).toBe(false);
  });

  it('numeric: compares any telemetry metric (not just the trigger field)', async () => {
    const n = node('condition.numeric', { field: 'telemetry.temperature', op: '>', value: 30 });
    expect(await evaluateCondition(n, ctx({}, { telemetry: { temperature: 35 } }))).toBe(true);
    expect(await evaluateCondition(n, ctx({}, { telemetry: { temperature: 20 } }))).toBe(false);
  });

  it('numeric: node age in minutes (calculated from lastHeard)', async () => {
    const now = 10_000_000; // ms
    const n = node('condition.numeric', { field: 'node.ageMinutes', op: '>', value: 30 });
    const lastHeardSec = (now / 1000) - 60 * 60; // 60 minutes ago
    expect(await evaluateCondition(n, ctx({}, { now, node: { nodeNum: 111, lastHeard: lastHeardSec } }))).toBe(true);
  });

  it('string: compares node longName and roleName', async () => {
    expect(await evaluateCondition(node('condition.string', { field: 'node.longName', op: 'contains', value: 'base' }),
      ctx({}, { node: { nodeNum: 111, longName: 'Base Station' } }))).toBe(true);
    expect(await evaluateCondition(node('condition.string', { field: 'node.roleName', op: 'eq', value: 'ROUTER' }),
      ctx({}, { node: { nodeNum: 111, role: 2 } }))).toBe(true);
  });

  it('distance: uses the hydrated node position', async () => {
    const n = node('condition.distance', { op: '<', km: 5, lat: 0, lon: 0 });
    expect(await evaluateCondition(n, ctx({}, { node: { nodeNum: 111, latitude: 0.01, longitude: 0 } }))).toBe(true);
    expect(await evaluateCondition(n, ctx({}, { node: { nodeNum: 111, latitude: 1, longitude: 0 } }))).toBe(false);
  });

  it('numeric: resolves a {{ var }} threshold', async () => {
    await repo.createVariable({ name: 'lowBatt', type: 'integer', scope: 'global', readonly: true, config: JSON.stringify({ defaultValue: 20 }) });
    const n = node('condition.numeric', { field: 'value', op: '<', value: '{{ var.lowBatt }}' });
    expect(await evaluateCondition(n, ctx({ value: 18 }))).toBe(true);
    expect(await evaluateCondition(n, ctx({ value: 25 }))).toBe(false);
  });

  it('string: contains (case-insensitive) and regex', async () => {
    expect(await evaluateCondition(node('condition.string', { field: 'text', op: 'contains', value: 'PING' }), ctx({ text: 'a ping b' }))).toBe(true);
    expect(await evaluateCondition(node('condition.string', { field: 'text', op: 'regex', value: '^(test|ping)' }), ctx({ text: 'ping' }))).toBe(true);
    expect(await evaluateCondition(node('condition.string', { field: 'text', op: 'eq', value: 'ping' }), ctx({ text: 'pong' }))).toBe(false);
  });

  it('variable: is-set check and comparison', async () => {
    await repo.createVariable({ name: 'welcomed', type: 'flag', scope: 'node' });
    const isSet = node('condition.variable', { variable: 'welcomed' });
    expect(await evaluateCondition(isSet, ctx({}, { nodeNum: 5 }))).toBe(false);
    await resolver.setFlag('welcomed', { nodeNum: 5 });
    expect(await evaluateCondition(isSet, ctx({}, { nodeNum: 5 }))).toBe(true);
    expect(await evaluateCondition(isSet, ctx({}, { nodeNum: 6 }))).toBe(false); // per-node

    await repo.createVariable({ name: 'count', type: 'integer', scope: 'global' });
    await resolver.setValue('count', 3, {});
    expect(await evaluateCondition(node('condition.variable', { variable: 'count', op: '>=', value: 2 }), ctx({}))).toBe(true);
  });

  it('distance: haversine vs threshold (coords from fields)', async () => {
    // ~111km/deg of latitude; 1 deg apart > 5km
    const far = node('condition.distance', { op: '<', km: 5, lat: 0, lon: 0 });
    expect(await evaluateCondition(far, ctx({ latitude: 1, longitude: 0 }))).toBe(false);
    const near = node('condition.distance', { op: '<', km: 5, lat: 0, lon: 0 });
    expect(await evaluateCondition(near, ctx({ latitude: 0.01, longitude: 0 }))).toBe(true);
    // missing coords → false
    expect(await evaluateCondition(near, ctx({}))).toBe(false);
  });

  it('timeRange: inside vs outside, with overnight wrap', async () => {
    // 2021-01-01T12:30:00Z — but Date uses local; build a known local time via ms
    const noonish = new Date(2021, 0, 1, 12, 30).getTime();
    expect(await evaluateCondition(node('condition.timeRange', { start: '10:00', end: '14:00' }), ctx({}, { now: noonish }))).toBe(true);
    expect(await evaluateCondition(node('condition.timeRange', { start: '13:00', end: '14:00' }), ctx({}, { now: noonish }))).toBe(false);
    // overnight window 22:00–06:00 at 12:30 → false
    expect(await evaluateCondition(node('condition.timeRange', { start: '22:00', end: '06:00' }), ctx({}, { now: noonish }))).toBe(false);
    const lateNight = new Date(2021, 0, 1, 23, 30).getTime();
    expect(await evaluateCondition(node('condition.timeRange', { start: '22:00', end: '06:00' }), ctx({}, { now: lateNight }))).toBe(true);
  });

  it('logical: AND / OR / NOT over sub-conditions', async () => {
    const t = { type: 'condition.numeric', params: { field: 'v', op: '==', value: 1 } };
    const f = { type: 'condition.numeric', params: { field: 'v', op: '==', value: 9 } };
    const c = ctx({ v: 1 });
    expect(await evaluateCondition(node('condition.logical', { op: 'AND', conditions: [t, f] }), c)).toBe(false);
    expect(await evaluateCondition(node('condition.logical', { op: 'OR', conditions: [t, f] }), c)).toBe(true);
    expect(await evaluateCondition(node('condition.logical', { op: 'NOT', conditions: [f] }), c)).toBe(true);
  });
});
