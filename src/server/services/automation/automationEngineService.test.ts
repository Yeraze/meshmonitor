import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { DbMessage } from '../../../services/database.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import type { AutomationGraph } from '../../../types/automation.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

const FAR_FUTURE = 9_000_000_000_000;

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

function mcMessage(over: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'mc1',
    fromPublicKey: 'channel-0', // channel message on slot 0
    text: 'ping',
    timestamp: 1000,
    ...over,
  } as MeshCoreMessage;
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
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

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

  it('matches a message trigger by channel NAME, resolving the per-source slot→name', async () => {
    const { calls, deps } = recorder();
    await createEnabled('on-gauntlet', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { channelName: 'gauntlet' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    // Slot 2 is "Gauntlet" on this source; slot 0 is "Primary".
    const chData = {
      getNode: async () => null,
      getTelemetry: async () => null,
      getChannelName: async (_sourceId: string | null, idx: number) => (idx === 2 ? 'Gauntlet' : 'Primary'),
    };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: chData, now: () => clock });
    await engine.load();

    expect(await engine.onMessage(message({ channel: 2 }), 'default')).toBe(1); // name matches (case-insensitive)
    expect(await engine.onMessage(message({ channel: 0 }), 'default')).toBe(0); // "Primary" ≠ "gauntlet"
    expect(calls.map((c) => c.fn)).toEqual(['sendTapback']);
  });

  it('matches a message trigger by the multi-channel OR-list, resolving slot→name (#3974)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('on-gauntlet-or-ops', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { channels: [{ name: 'gauntlet', protocol: 'meshtastic' }, { name: 'ops', protocol: 'meshtastic' }] } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    // Slot 2 = "Gauntlet", slot 3 = "Ops", everything else "Primary".
    const chData = {
      getNode: async () => null,
      getTelemetry: async () => null,
      getChannelName: async (_sourceId: string | null, idx: number) => (idx === 2 ? 'Gauntlet' : idx === 3 ? 'Ops' : 'Primary'),
    };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: chData, now: () => clock });
    await engine.load();

    expect(await engine.onMessage(message({ channel: 2 }), 'default')).toBe(1); // matches "gauntlet"
    expect(await engine.onMessage(message({ channel: 3 }), 'default')).toBe(1); // matches "ops"
    expect(await engine.onMessage(message({ channel: 0 }), 'default')).toBe(0); // "Primary" in neither
    expect(calls.map((c) => c.fn)).toEqual(['sendTapback', 'sendTapback']);
  });

  it('fires a message automation on a MeshCore message and replies on the trigger scope (#3833)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong', scopeMode: 'trigger' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    const fired = await engine.onMeshCoreMessage(mcMessage({ text: 'ping me', scopeName: 'paris', scopeCode: 9 }), 'default');
    expect(fired).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['sendMessage']);
    expect(calls[0].args.scopeOverride).toBe('paris');
  });

  it('replies UNSCOPED when trigger-scope mode meets an explicitly-unscoped MeshCore trigger (#3833)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong', scopeMode: 'trigger' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    // scopeCode 0 = arrived explicitly unscoped, scopeName absent → reply unscoped ('').
    const fired = await engine.onMeshCoreMessage(mcMessage({ text: 'ping', scopeCode: 0 }), 'default');
    expect(fired).toBe(1);
    expect(calls[0].args.scopeOverride).toBe('');
  });

  it('does not fire a MeshCore message automation when the text filter misses', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onMeshCoreMessage(mcMessage({ text: 'hello' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('self-origin (#3914): ignores a Meshtastic message from our own local node', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const selfData = { ...data, getLocalNodeNum: async () => 111 };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    // From our own node (111) → dropped before it can loop.
    expect(await engine.onMessage(message({ fromNodeNum: 111, text: 'ping' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
    // From a different node → fires normally.
    expect(await engine.onMessage(message({ fromNodeNum: 222, text: 'ping' }), 'default')).toBe(1);
  });

  it('self-origin (#3914): ignores a MeshCore message from our own public key (case-insensitive)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const selfData = { ...data, getSelfPublicKey: async () => 'ABCD' };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    // Our own send (key differs only in case) → dropped.
    expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'abcd', text: 'ping' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
    // A different sender → fires.
    expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'channel-0', text: 'ping' }), 'default')).toBe(1);
  });

  it('self-origin (#3914): ignores our own node telemetry', async () => {
    const { deps } = recorder();
    await createEnabled('batt', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.telemetry', params: {} },
        { id: 'n', type: 'action.notify', params: { title: 'low', body: 'batt' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const selfData = { ...data, getLocalNodeNum: async () => 111 };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    expect(await engine.onTelemetry(111, 'batteryLevel', 50, '%', 'default')).toBe(0); // our own → dropped
    expect(await engine.onTelemetry(222, 'batteryLevel', 50, '%', 'default')).toBe(1); // another node → fires
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

  it('geofence: polygon region — enter fires on outside→inside', async () => {
    const { calls, deps } = recorder();
    // A 2°×2° square centred on (0,0).
    const vertices = [
      { lat: -1, lng: -1 }, { lat: -1, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: -1 },
    ];
    await createEnabled('geo-poly', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', shape: { type: 'polygon', vertices } } },
        { id: 'a', type: 'action.notify', params: { body: 'entered poly' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 5, lon: 5 }; // outside the square
    const geoData = { getNode: async () => ({ nodeNum: 9, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    expect(await engine.checkGeofences(9, 'default')).toBe(0); // baseline (outside)
    pos.lat = 0; pos.lon = 0; // move inside
    expect(await engine.checkGeofences(9, 'default')).toBe(1); // enter
    expect(await engine.checkGeofences(9, 'default')).toBe(0); // still inside → no re-fire
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
  });

  // ─── schedule (cron) ───────────────────────────────────────────────────────
  function fakeCron() {
    const jobs: Array<{ expr: string; cb: () => void; stopped: boolean }> = [];
    const cron = {
      schedule: (expr: string, cb: () => void) => {
        const j = { expr, cb, stopped: false };
        jobs.push(j);
        return { stop: () => { j.stopped = true; } };
      },
      validate: (expr: string) => /\S/.test(expr) && expr !== 'BAD',
    };
    return { jobs, cron };
  }
  const scheduleGraph = (cron: string, cooldownSeconds?: number): AutomationGraph => ({
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.schedule', params: { cron, ...(cooldownSeconds ? { cooldownSeconds } : {}) } },
      { id: 'a', type: 'action.notify', params: { body: 'tick' } },
    ],
    edges: [{ from: 't', to: 'a' }],
  });
  const engineWithCron = (deps: ActionDeps, cron: ReturnType<typeof fakeCron>['cron']) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => clock, cron });

  it('schedule: arms a cron job per enabled schedule automation and onSchedule fires it', async () => {
    const { calls, deps } = recorder();
    const a = await createEnabled('cron-job', scheduleGraph('0 * * * *'));
    const { jobs, cron } = fakeCron();
    const engine = engineWithCron(deps, cron);
    await engine.load();

    expect(jobs.map((j) => j.expr)).toEqual(['0 * * * *']);
    expect(await engine.onSchedule(a.id)).toBe(1);
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
    // invoking the registered cron callback also fires it
    jobs[0].cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(2);
  });

  it('schedule: an invalid/missing cron is not armed', async () => {
    const { deps } = recorder();
    await createEnabled('bad-cron', scheduleGraph('BAD'));
    const { jobs, cron } = fakeCron();
    const engine = engineWithCron(deps, cron);
    await engine.load();
    expect(jobs).toHaveLength(0);
  });

  it('schedule: reload stops the old job and re-arms', async () => {
    const { deps } = recorder();
    await createEnabled('cron-job', scheduleGraph('0 * * * *'));
    const { jobs, cron } = fakeCron();
    const engine = engineWithCron(deps, cron);
    await engine.load();
    await engine.load(); // simulate a reload after CRUD
    expect(jobs).toHaveLength(2);
    expect(jobs[0].stopped).toBe(true);  // old job cancelled
    expect(jobs[1].stopped).toBe(false); // new job live
  });

  it('schedule: onSchedule honors the per-automation cooldown', async () => {
    const { calls, deps } = recorder();
    const a = await createEnabled('cron-cooldown', scheduleGraph('* * * * *', 60));
    const { cron } = fakeCron();
    const engine = engineWithCron(deps, cron);
    await engine.load();

    expect(await engine.onSchedule(a.id)).toBe(1); // t0
    clock += 30_000;
    expect(await engine.onSchedule(a.id)).toBe(0); // within cooldown
    clock += 31_000;
    expect(await engine.onSchedule(a.id)).toBe(1); // past cooldown
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(2);
  });

  // ── Live trace ("view logs") emit instrumentation ──────────────────────────
  it('emits a FIRED trace (with steps) for a traced rule that matches', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onMessage(message({ text: 'ping me' }), 'default');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ automationId: a.id, outcome: 'fired', status: 'completed' });
    expect(Array.isArray(got[0].steps)).toBe(true);
    expect(got[0].steps.length).toBeGreaterThan(0);
  });

  it('emits a PREFILTERED trace with a human reason when the filter misses', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onMessage(message({ text: 'hello' }), 'default');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ automationId: a.id, outcome: 'prefiltered' });
    expect(got[0].reason).toBe('text does not contain "ping"');
  });

  it('emits a COOLDOWN trace while a traced rule is cooling down', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60 } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onMessage(message({ text: 'ping' }), 'default'); // fires (t0)
    clock += 30_000;
    await engine.onMessage(message({ text: 'ping' }), 'default'); // within cooldown
    const outcomes = got.map((g) => g.outcome);
    expect(outcomes).toContain('fired');
    expect(outcomes).toContain('cooldown');
    expect(got.find((g) => g.outcome === 'cooldown').reason).toMatch(/cooldown active/);
  });

  it('emits a FIRED trace for a traced schedule (cron) rule', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('cron', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.schedule', params: { cron: '* * * * *' } },
        { id: 'n', type: 'action.notify', params: { body: 'tick' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onSchedule(a.id);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ automationId: a.id, outcome: 'fired', triggerType: 'trigger.schedule' });
  });

  it('emits a COOLDOWN trace for a throttled schedule rule', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('cron', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.schedule', params: { cron: '* * * * *', cooldownSeconds: 60 } },
        { id: 'n', type: 'action.notify', params: { body: 'tick' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onSchedule(a.id); // fires (t0)
    clock += 30_000;
    await engine.onSchedule(a.id); // within cooldown
    const outcomes = got.map((g) => g.outcome);
    expect(outcomes).toEqual(['fired', 'cooldown']);
    expect(got[1].reason).toMatch(/cooldown active/);
  });

  it('emits geofence traces: baseline (prefiltered) then enter (fired)', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const { deps } = recorder();
    const a = await createEnabled('geo-enter', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'n', type: 'action.notify', params: { body: 'entered' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const pos = { lat: 1, lon: 0 }; // outside
    const geoData = { getNode: async () => ({ nodeNum: 5, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.checkGeofences(5, 'default'); // baseline (outside)
    pos.lat = 0.01;                            // move inside
    await engine.checkGeofences(5, 'default'); // enter → fires

    const outcomes = got.map((g) => g.outcome);
    expect(outcomes).toEqual(['prefiltered', 'fired']);
    expect(got[0].reason).toMatch(/baseline only/);
    expect(got[1]).toMatchObject({ status: 'completed' });
  });

  it('emits NOTHING when the rule is not being traced (hot-path no-op)', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    // No arm() → nothing traced.
    await engine.onMessage(message({ text: 'ping' }), 'default');
    await engine.onMessage(message({ text: 'hello' }), 'default');
    expect(got).toHaveLength(0);
  });
});
