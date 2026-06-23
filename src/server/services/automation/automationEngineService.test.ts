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
  const deps: ActionDeps = {
    sendMessage: async (a) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
    sendTapback: async (a) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
    manageNode: async (a) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
    notify: async (a) => { calls.push({ fn: 'notify', args: a }); return 4; },
  };
  return { calls, deps };
}

function message(over: Partial<DbMessage> = {}): DbMessage {
  const from = (over.fromNodeNum as number) ?? 111;
  return {
    id: `default_${from}_42`,
    fromNodeNum: from,
    toNodeNum: 4294967295,
    fromNodeId: `!${from.toString(16).padStart(8, '0')}`,
    toNodeId: '!ffffffff',
    text: 'ping',
    channel: 0,
    portnum: 1,
    timestamp: 1000,
    hopStart: 3,
    hopLimit: 3,
    createdAt: 1000,
    ...over,
  } as DbMessage;
}

describe('AutomationEngineService', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let varsRepo: AutomationVariablesRepository;
  let resolver: VariableResolver;
  let clock: number;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    varsRepo = new AutomationVariablesRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(varsRepo);
    clock = 1_000_000;
  });
  afterEach(() => db.close());

  const data = { getNode: async () => null, getTelemetry: async () => null };
  const engineWith = (deps: ActionDeps) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => clock });

  async function createEnabled(name: string, graph: AutomationGraph) {
    return autos.createAutomation({ name, enabled: true, config: JSON.stringify(graph) });
  }

  it('fires a ping → tapback automation and writes a completed run', async () => {
    const { calls, deps } = recorder();
    const a = await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    expect(engine.countFor('trigger.message')).toBe(1);

    const fired = await engine.onMessage(message({ text: 'ping me' }), 'default');
    expect(fired).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['sendTapback']);

    const runs = await autos.listRuns(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
  });

  it('applies the trigger pre-filter (no match → no fire)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    const fired = await engine.onMessage(message({ text: 'hello' }), 'default');
    expect(fired).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('enforces the per-automation cooldown', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60 } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onMessage(message(), 'default')).toBe(1); // t0
    clock += 30_000;
    expect(await engine.onMessage(message(), 'default')).toBe(0); // within cooldown
    clock += 31_000;
    expect(await engine.onMessage(message(), 'default')).toBe(1); // past cooldown
    expect(calls).toHaveLength(2);
  });

  it('welcome-once anti-spam via a per-node flag', async () => {
    const { calls, deps } = recorder();
    await varsRepo.createVariable({ name: 'welcomed', type: 'flag', scope: 'node' });
    // trigger → if NOT welcomed (false branch) → send welcome → set flag
    await createEnabled('welcome', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'c', type: 'condition.variable', params: { variable: 'welcomed' } },
        { id: 'send', type: 'action.sendMessage', params: { text: 'welcome {{ trigger.fromId }}' } },
        { id: 'flag', type: 'flow.setVar', params: { variable: 'welcomed', op: 'flag' } },
      ],
      edges: [
        { from: 't', to: 'c' },
        { from: 'c', to: 'send', port: 'false' },
        { from: 'send', to: 'flag' },
      ],
    });
    const engine = engineWith(deps);
    await engine.load();

    // node 111 first time → welcomed
    await engine.onMessage(message({ fromNodeNum: 111 }), 'default');
    // node 111 again → already welcomed, no send
    await engine.onMessage(message({ fromNodeNum: 111 }), 'default');
    // node 222 → welcomed (independent per-node flag)
    await engine.onMessage(message({ fromNodeNum: 222 }), 'default');

    const sends = calls.filter((c) => c.fn === 'sendMessage');
    expect(sends).toHaveLength(2); // 111 once + 222 once, NOT the 2nd 111
    expect(sends.map((s) => s.args.text).sort()).toEqual(['welcome !0000006f', 'welcome !000000de']);
  });

  it('skips invalid/unparseable configs on load', async () => {
    await autos.createAutomation({ name: 'bad-json', enabled: true, config: 'not json' });
    await autos.createAutomation({ name: 'no-trigger', enabled: true, config: JSON.stringify({ version: 1, nodes: [{ id: 'a', type: 'action.tapback' }], edges: [] }) });
    const { deps } = recorder();
    const engine = engineWith(deps);
    await engine.load();
    expect(engine.countFor('trigger.message')).toBe(0);
  });

  it('geofence: baseline does not fire; enter fires once on outside→inside', async () => {
    const { calls, deps } = recorder();
    await createEnabled('geo-enter', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'a', type: 'action.notify', params: { body: 'entered' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 1, lon: 0 }; // ~111km away → outside
    const geoData = { getNode: async () => ({ nodeNum: 5, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    expect(await engine.checkGeofences(5, 'default')).toBe(0); // baseline (outside)
    pos.lat = 0.01; // move inside (~1.1km)
    expect(await engine.checkGeofences(5, 'default')).toBe(1); // enter
    expect(await engine.checkGeofences(5, 'default')).toBe(0); // still inside → no re-fire
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
  });

  it('system: a trigger only fires for its configured event (prefilter)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('on-boot', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.system', params: { event: 'bootup' } },
        { id: 'a', type: 'action.notify', params: { body: 'booted' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onSystem('source-connected', 'default', null)).toBe(0); // wrong event
    expect(await engine.onSystem('bootup', null, null)).toBe(1); // matching event
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
  });

  it('system: upgrade-available exposes version fields to interpolation', async () => {
    const { calls, deps } = recorder();
    await createEnabled('upgrade-msg', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.system', params: { event: 'upgrade-available' } },
        { id: 'a', type: 'action.sendMessage', params: { text: '{{ trigger.currentVersion }} -> {{ trigger.latestVersion }}' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    const fired = await engine.onSystem('upgrade-available', null, null, undefined, {
      latestVersion: '9.9.9',
      currentVersion: '1.0.0',
    });
    expect(fired).toBe(1);
    const send = calls.find((c) => c.fn === 'sendMessage');
    expect(send?.args.text).toBe('1.0.0 -> 9.9.9');
  });

  it('records a failed run when a notify action throws', async () => {
    const { deps } = recorder();
    deps.notify = async () => { throw new Error('apprise down'); };
    const a = await createEnabled('notify-fail', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.system', params: { event: 'bootup' } },
        { id: 'n', type: 'action.notify', params: { body: 'x' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onSystem('bootup', null, null)).toBe(1);
    const runs = await autos.listRuns(a.id);
    expect(runs[0].status).toBe('failed');
  });

  it('geofence: exit fires on inside→outside', async () => {
    const { deps } = recorder();
    await createEnabled('geo-exit', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'exit', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'a', type: 'action.notify', params: { body: 'left' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 0.01, lon: 0 }; // inside
    const geoData = { getNode: async () => ({ nodeNum: 7, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    expect(await engine.checkGeofences(7, 'default')).toBe(0); // baseline (inside)
    pos.lat = 1; // move outside
    expect(await engine.checkGeofences(7, 'default')).toBe(1); // exit
  });
});
