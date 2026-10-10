/**
 * action.tracePathSchedule (#5723) in the executor and the engine: which
 * paths reach the dep, the MeshCore-only skip, the dry run, and that a tick
 * with nothing due writes no run-log row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { executeAction, type ActionDeps } from './actionExecutor.js';
import type { EngineEvalContext } from './engineContext.js';
import type { AutomationGraph, AutomationNode } from '../../../types/automation.js';
import type { VariableResolver as VarResolverType } from './variableResolver.js';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { TxDisabledError } from '../../errors/txDisabledError.js';

const K = (c: string) => c.repeat(64);
type TraceArgs = Parameters<ActionDeps['runScheduledTrace']>[0];

function ctx(over: Partial<EngineEvalContext> = {}, protocols: Record<string, string> = { mc: 'meshcore', mt: 'meshtastic' }): EngineEvalContext {
  const vars = { getValue: async () => null, setValue: async () => ({ ok: true }) } as unknown as VarResolverType;
  return {
    trigger: { triggerType: 'trigger.schedule', sourceId: null, subjectNodeNum: null, timestamp: 0, fields: {} },
    vars,
    data: { getNode: async () => null, getTelemetry: async () => null, getSourceProtocol: async (id: string) => protocols[id] ?? null },
    varCtx: { sourceId: null, nodeNum: null },
    now: 1_800_000_000_000,
    automationId: 'auto-1',
    ...over,
  } as EngineEvalContext;
}

const node = (params: Record<string, unknown>): AutomationNode => ({ id: 'a', type: 'action.tracePathSchedule', params });

function deps(reply: (a: TraceArgs) => unknown) {
  const calls: TraceArgs[] = [];
  const d = { runScheduledTrace: async (a: TraceArgs) => { calls.push(a); return reply(a); } } as unknown as ActionDeps;
  return { calls, deps: d };
}

const PATHS = [
  { publicKey: K('a'), hashBytes: 2, intervalMinutes: 10, label: 'Hilltop' },
  { publicKey: K('b'), intervalMinutes: 600 },
];

describe('action.tracePathSchedule in the executor (#5723)', () => {
  it('hands each path to the dep with a stable per-path key, on each MeshCore source', async () => {
    const { calls, deps: d } = deps(() => ({ traced: true }));
    await executeAction(node({ paths: PATHS, sourceIds: ['mc'], autoReturn: true }), ctx(), d);
    expect(calls).toEqual([
      { sourceId: 'mc', pathKey: `auto-1:a:${K('a')}`, path: { publicKey: K('a'), hashBytes: 2, intervalMinutes: 10, label: 'Hilltop' }, autoReturn: true },
      { sourceId: 'mc', pathKey: `auto-1:a:${K('b')}`, path: { publicKey: K('b'), hashBytes: 'auto', intervalMinutes: 600 }, autoReturn: true },
    ]);
  });

  it('skips a non-MeshCore source without calling the dep', async () => {
    const { calls, deps: d } = deps(() => ({ traced: true }));
    const r = await executeAction(node({ paths: PATHS, sourceIds: ['mt'] }), ctx(), d) as Array<{ skipped?: boolean }>;
    expect(calls).toHaveLength(0);
    expect(r).toEqual([{ sourceId: 'mt', skipped: true, reason: 'scheduled trace paths are MeshCore only' }]);
  });

  it('needs a source when the trigger has none', async () => {
    const { deps: d } = deps(() => ({}));
    await expect(executeAction(node({ paths: PATHS }), ctx(), d)).rejects.toThrow(/pick a MeshCore source/);
  });

  it('marks the step idle only when every path was not due', async () => {
    const idle = ctx();
    await executeAction(node({ paths: PATHS, sourceIds: ['mc'] }), idle, deps(() => ({ skipped: true, notDue: true })).deps);
    expect(idle.idleActions).toBe(1);

    const busy = ctx();
    let n = 0;
    await executeAction(node({ paths: PATHS, sourceIds: ['mc'] }), busy, deps(() => (n++ === 0 ? { traced: true } : { skipped: true, notDue: true })).deps);
    expect(busy.idleActions).toBeUndefined();

    const capped = ctx();
    await executeAction(node({ paths: PATHS, sourceIds: ['mc'] }), capped, deps(() => ({ skipped: true, reason: 'cap' })).deps);
    expect(capped.idleActions).toBeUndefined();
  });

  it('a TX-disabled source records a skip instead of failing the run', async () => {
    const { deps: d } = deps(() => { throw new TxDisabledError(); });
    const r = await executeAction(node({ paths: [PATHS[0]], sourceIds: ['mc'] }), ctx(), d) as Array<{ skipped?: boolean }>;
    expect(r[0].skipped).toBe(true);
  });
});

describe('action.tracePathSchedule in the engine (#5723)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let resolver: VariableResolver;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(drizzleDb, 'sqlite'));
  });
  afterEach(() => { db.close(); });

  const graph: AutomationGraph = {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.schedule', params: { cron: '* * * * *' } },
      { id: 'a', type: 'action.tracePathSchedule', params: { paths: [PATHS[0]], sourceIds: ['mc'] } },
    ],
    edges: [{ from: 't', to: 'a' }],
  };

  it('an idle tick writes no run-log row; a tick that traced does; Run Now always does', async () => {
    let reply: unknown = { skipped: true, notDue: true };
    const d = { runScheduledTrace: async () => reply } as unknown as ActionDeps;
    const data = { getNode: async () => null, getTelemetry: async () => null, getSourceProtocol: async () => 'meshcore' };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps: d, data, now: () => 1_000_000 });
    const a = await autos.createAutomation({ name: 'Traces', enabled: true, config: JSON.stringify(graph) });
    await engine.load();

    await engine.onSchedule(a.id);
    await engine.onSchedule(a.id);
    expect(await autos.listRuns(a.id)).toHaveLength(0);

    reply = { traced: true, hops: 2 };
    await engine.onSchedule(a.id);
    expect(await autos.listRuns(a.id)).toHaveLength(1);

    reply = { skipped: true, notDue: true };
    await engine.runNow(a.id);
    expect(await autos.listRuns(a.id)).toHaveLength(2);
    engine.stop?.();
  });
});
