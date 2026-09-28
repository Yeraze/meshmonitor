/**
 * action.setAutomationEnabled (#5445) — engine integration tests against a real
 * in-memory AutomationsRepository: the DB write, the reload, the self-disable
 * short-circuit, the run-log record, and the mid-dispatch skip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { DbMessage } from '../../../services/database.js';
import type { AutomationGraph } from '../../../types/automation.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';

function recorder() {
  const calls: Array<{ fn: string; args: any }> = [];
  const deps = {
    sendMessage: async (a: unknown) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
    sendTapback: async (a: unknown) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
    manageNode: async (a: unknown) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
    notify: async (a: unknown) => { calls.push({ fn: 'notify', args: a }); return 4; },
  } as unknown as ActionDeps;
  return { calls, deps };
}

function message(text: string): DbMessage {
  return {
    id: 'default_111_42', fromNodeNum: 111, toNodeNum: 4294967295, fromNodeId: '!0000006f',
    toNodeId: '!ffffffff', text, channel: 0, portnum: 1, timestamp: 1000, hopStart: 3, hopLimit: 3, createdAt: 1000,
  } as DbMessage;
}

/** trigger.message(textContains) → setAutomationEnabled(params) → notify(body). */
function graph(textContains: string, setParams: Record<string, unknown>, body = 'after'): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.message', params: { textContains } },
      { id: 's', type: 'action.setAutomationEnabled', params: setParams },
      { id: 'n', type: 'action.notify', params: { body } },
    ],
    edges: [{ from: 't', to: 's' }, { from: 's', to: 'n' }],
  };
}

/** trigger.message(textContains) → notify(body). */
function notifyGraph(textContains: string, body: string): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.message', params: { textContains } },
      { id: 'n', type: 'action.notify', params: { body } },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

describe('AutomationEngineService — action.setAutomationEnabled (#5445)', () => {
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

  const data = { getNode: async () => null, getTelemetry: async () => null };
  const engineWith = (deps: ActionDeps) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => 1_000_000 });
  const create = (name: string, g: AutomationGraph, enabled = true) =>
    autos.createAutomation({ name, enabled, config: JSON.stringify(g) });

  it('disables another automation, reloads the engine, and records the resolved params', async () => {
    const { calls, deps } = recorder();
    const target = await create('Chatty', notifyGraph('hello', 'chatty'));
    const killer = await create('Kill switch', graph('!quiet', { automationId: target.id, enabled: 'false' }));
    const engine = engineWith(deps);
    await engine.load();
    expect(engine.countFor('trigger.message')).toBe(2);

    await engine.onMessage(message('!quiet'), 'default');

    expect((await autos.getAutomation(target.id))?.enabled).toBe(false);
    // Reloaded: only the kill switch is still indexed.
    expect(engine.countFor('trigger.message')).toBe(1);
    // The next "hello" no longer fires the disabled rule.
    calls.length = 0;
    await engine.onMessage(message('hello'), 'default');
    expect(calls).toHaveLength(0);

    const [run] = await autos.listRuns(killer.id);
    expect(run.status).toBe('completed');
    const steps = JSON.parse(run.log ?? '[]');
    const setStep = steps.find((s: any) => s.nodeId === 's');
    expect(setStep).toMatchObject({
      outcome: 'action:ok',
      detail: { automationId: target.id, name: 'Chatty', mode: 'set', enabled: false, previous: true },
    });
  });

  it('enables a disabled automation so it starts firing', async () => {
    const { calls, deps } = recorder();
    const target = await create('Night rule', notifyGraph('hello', 'night'), false);
    await create('Waker', graph('!wake', { automationId: target.id, enabled: true }));
    const engine = engineWith(deps);
    await engine.load();

    await engine.onMessage(message('!wake'), 'default');
    expect((await autos.getAutomation(target.id))?.enabled).toBe(true);

    calls.length = 0;
    await engine.onMessage(message('hello'), 'default');
    expect(calls.map((c) => c.args.body)).toEqual(['night']);
  });

  it('toggle flips the state each time', async () => {
    const { deps } = recorder();
    const target = await create('B', notifyGraph('zzz', 'b'));
    await create('Toggler', graph('!flip', { automationId: target.id, mode: 'toggle' }));
    const engine = engineWith(deps);
    await engine.load();

    await engine.onMessage(message('!flip'), 'default');
    expect((await autos.getAutomation(target.id))?.enabled).toBe(false);
    await engine.onMessage(message('!flip'), 'default');
    expect((await autos.getAutomation(target.id))?.enabled).toBe(true);
  });

  it('an unknown id fails the step in the run log without crashing the run', async () => {
    const { calls, deps } = recorder();
    const a = await create('Broken', graph('!quiet', { automationId: 'does-not-exist', enabled: false }));
    const engine = engineWith(deps);
    await engine.load();

    await engine.onMessage(message('!quiet'), 'default');

    const [run] = await autos.listRuns(a.id);
    expect(run.status).toBe('failed');
    const steps = JSON.parse(run.log ?? '[]');
    expect(steps.find((s: any) => s.nodeId === 's')).toMatchObject({
      outcome: 'action:error',
      error: expect.stringContaining('no automation with id "does-not-exist"'),
    });
    // A failed action never aborts the run: the notify after it still ran.
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
  });

  it('self-disable skips the rest of the run and records why', async () => {
    const { calls, deps } = recorder();
    // Create first, then point the action at its own id.
    const self = await create('One shot', notifyGraph('x', 'x'));
    await autos.updateAutomation(self.id, {
      config: JSON.stringify(graph('!once', { automationId: self.id, enabled: false }, 'must not run')),
    });
    const engine = engineWith(deps);
    await engine.load();

    await engine.onMessage(message('!once'), 'default');

    expect(calls).toHaveLength(0); // the notify after the self-disable was skipped
    expect((await autos.getAutomation(self.id))?.enabled).toBe(false);
    expect(engine.countFor('trigger.message')).toBe(0);

    const [run] = await autos.listRuns(self.id);
    expect(run.status).toBe('completed');
    const steps = JSON.parse(run.log ?? '[]');
    expect(steps.map((s: any) => s.outcome)).toEqual(['activated', 'action:ok', 'run:halted']);
    expect(steps[2].detail.reason).toMatch(/disabled itself/);

    // Fire again: nothing happens, the rule is off.
    await engine.onMessage(message('!once'), 'default');
    expect(await autos.listRuns(self.id)).toHaveLength(1);
  });

  it('a rule disabled earlier in the same dispatch does not fire for that event', async () => {
    const { calls, deps } = recorder();
    // Two rules on the same message, each disabling the other. Whichever the
    // engine runs first must stop the second from firing, whatever the order.
    const a = await create('A', notifyGraph('x', 'x'));
    const b = await create('B', graph('!go', { automationId: a.id, enabled: false }, 'B ran'));
    await autos.updateAutomation(a.id, {
      config: JSON.stringify(graph('!go', { automationId: b.id, enabled: false }, 'A ran')),
    });
    const engine = engineWith(deps);
    await engine.load();

    await engine.onMessage(message('!go'), 'default');

    const bodies = calls.map((c) => c.args.body);
    expect(bodies).toHaveLength(1);
    const aEnabled = (await autos.getAutomation(a.id))?.enabled;
    const bEnabled = (await autos.getAutomation(b.id))?.enabled;
    // Exactly one rule ran, and it is the one still enabled.
    expect([aEnabled, bEnabled].filter(Boolean)).toHaveLength(1);
    expect(bodies[0]).toBe(aEnabled ? 'A ran' : 'B ran');
    const runs = [...await autos.listRuns(a.id), ...await autos.listRuns(b.id)];
    expect(runs).toHaveLength(1);
  });

  it('setting the state it already has writes nothing and does not reload', async () => {
    const { deps } = recorder();
    const target = await create('B', notifyGraph('zzz', 'b'));
    await create('Enabler', graph('!on', { automationId: target.id, enabled: true }));
    const engine = engineWith(deps);
    await engine.load();
    const before = (await autos.getAutomation(target.id))!.updatedAt;
    let loads = 0;
    const origLoad = engine.load.bind(engine);
    engine.load = async () => { loads++; await origLoad(); };

    await engine.onMessage(message('!on'), 'default');

    expect(loads).toBe(0);
    expect((await autos.getAutomation(target.id))!.updatedAt).toBe(before);
  });

  it('Run Now still fires a disabled automation (manual fires skip the mid-dispatch check)', async () => {
    const { calls, deps } = recorder();
    const off = await create('Off', notifyGraph('x', 'manual'), false);
    const engine = engineWith(deps);
    await engine.load();
    const res = await engine.runNow(off.id);
    expect(res.ran).toBe(true);
    expect(calls.map((c) => c.args.body)).toEqual(['manual']);
  });
});
