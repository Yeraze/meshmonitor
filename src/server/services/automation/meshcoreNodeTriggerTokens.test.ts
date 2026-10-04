/**
 * #5595: role / hops / lastHeard tokens on the MeshCore
 * trigger.nodeDiscovered and trigger.nodeUpdated.
 *
 * Covers the context builder (each token, and each empty case), the event
 * payload, the bus → engine hand-off, a template rendered through the real
 * engine, and the Test panel's dry run. The path_len decoding of real advert
 * frames lives in `meshcoreManager.nodeTriggerTokens.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';
import { buildMeshCoreNodeContext, buildNodeStaleContext, meshCoreRoleName } from './triggerContext.js';
import { routeEventToEngine } from './automationEngineSingleton.js';
import { simulateAutomation } from './automationSimulator.js';
import { dataEventEmitter, type DataEvent } from '../dataEventEmitter.js';

const HASH = '3A24AED15A9CB70A';
const KEY = 'ab'.repeat(32);
const HEARD_MS = 1_790_000_000_000; // a 2026 date, in milliseconds

const ctxOf = (facts?: Parameters<typeof buildMeshCoreNodeContext>[7]) =>
  buildMeshCoreNodeContext('trigger.nodeDiscovered', KEY, [], 'src', 5, { packetHash: HASH }, 'Hill', facts).fields;

describe('trigger.roleName (#5595)', () => {
  it.each([
    [1, 'Companion'],
    [2, 'Repeater'],
    [3, 'Room Server'],
    [4, 'Sensor'],
  ])('advert type %i renders %s', (advType, label) => {
    expect(ctxOf({ advType }).roleName).toBe(label);
    expect(meshCoreRoleName(advType)).toBe(label);
  });

  it('is an empty string for an unknown, unset or out-of-range type', () => {
    for (const advType of [0, undefined, null, 5, 255, -1, NaN, 'x']) {
      expect(meshCoreRoleName(advType)).toBe('');
    }
    expect(ctxOf({ advType: 0 }).roleName).toBe('');
    expect(ctxOf({}).roleName).toBe('');
    expect(ctxOf().roleName).toBe('');
  });
});

describe('trigger.hops and trigger.routeHops (#5595)', () => {
  it('carries the advert hop count, with 0 kept as a real value', () => {
    expect(ctxOf({ hops: 0 }).hops).toBe(0);
    expect(ctxOf({ hops: 3 }).hops).toBe(3);
    expect(ctxOf({ hops: 63 }).hops).toBe(63);
  });

  it('is undefined when no advert frame caused the event', () => {
    expect(ctxOf().hops).toBeUndefined();
    expect(ctxOf({}).hops).toBeUndefined();
    for (const hops of [null, NaN, -1, 1.5]) {
      expect(ctxOf({ hops: hops as number }).hops).toBeUndefined();
    }
  });

  it('never fills hops from the cached route length', () => {
    const f = ctxOf({ routeHops: 4 });
    expect(f.hops).toBeUndefined();
    expect(f.routeHops).toBe(4);
  });

  it('keeps the two apart when both are known', () => {
    const f = ctxOf({ hops: 2, routeHops: 5 });
    expect(f.hops).toBe(2);
    expect(f.routeHops).toBe(5);
  });

  it('routeHops is undefined when no route is stored', () => {
    expect(ctxOf({ hops: 1 }).routeHops).toBeUndefined();
    expect(ctxOf({ routeHops: null as unknown as number }).routeHops).toBeUndefined();
    expect(ctxOf({ routeHops: 0 }).routeHops).toBe(0);
  });
});

describe('trigger.lastHeard (#5595)', () => {
  it('is epoch milliseconds, the same unit trigger.nodeStale uses', () => {
    expect(ctxOf({ lastHeard: HEARD_MS }).lastHeard).toBe(HEARD_MS);
    const stale = buildNodeStaleContext(null, KEY, 10, 5, HEARD_MS, 'src', 5);
    expect(stale.fields.lastHeard).toBe(ctxOf({ lastHeard: HEARD_MS }).lastHeard);
  });

  it('scales a value handed over in seconds up to milliseconds', () => {
    expect(ctxOf({ lastHeard: HEARD_MS / 1000 }).lastHeard).toBe(HEARD_MS);
  });

  it('is undefined when unknown', () => {
    for (const lastHeard of [undefined, null, 0, -5, NaN]) {
      expect(ctxOf({ lastHeard: lastHeard as number }).lastHeard).toBeUndefined();
    }
  });
});

describe('MeshCore node context shape (#5595)', () => {
  it('has no shortName field, and still no node number', () => {
    const ctx = buildMeshCoreNodeContext('trigger.nodeUpdated', KEY, ['name'], 'src', 5, undefined, 'Hill', {
      advType: 2, hops: 1, routeHops: 2, lastHeard: HEARD_MS,
    });
    expect(ctx.fields).not.toHaveProperty('shortName');
    expect(ctx.subjectNodeNum).toBeNull();
    expect(ctx.subjectNodeKey).toBe(KEY);
    expect(ctx.fields).toMatchObject({
      publicKey: KEY, name: 'Hill', changed: ['name'],
      roleName: 'Repeater', hops: 1, routeHops: 2, lastHeard: HEARD_MS,
      protocol: 'meshcore', protocolShort: 'MC',
    });
  });
});

describe('event payload (#5595)', () => {
  function capture(fn: () => void): DataEvent {
    let got: DataEvent | undefined;
    const listener = (e: DataEvent) => { got = e; };
    dataEventEmitter.on('data', listener);
    try { fn(); } finally { dataEventEmitter.off('data', listener); }
    expect(got).toBeDefined();
    return got!;
  }

  it('node:discovered keeps the contact facts, including a 0 hop count', () => {
    const ev = capture(() => dataEventEmitter.emitNodeDiscovered(
      { nodeNum: null, publicKey: KEY, name: 'Hill', packetHash: HASH, advType: 2, hops: 0, routeHops: 0, lastHeard: HEARD_MS },
      'src',
    ));
    expect(ev.data).toEqual({
      nodeNum: null, publicKey: KEY, name: 'Hill', packetHash: HASH, advType: 2, hops: 0, routeHops: 0, lastHeard: HEARD_MS,
    });
  });

  it('node:discovered leaves unknown facts off the payload', () => {
    const ev = capture(() => dataEventEmitter.emitNodeDiscovered({ nodeNum: null, publicKey: KEY, name: 'Hill' }, 'src'));
    expect(ev.data).toEqual({ nodeNum: null, publicKey: KEY, name: 'Hill' });
  });

  it('a Meshtastic node:discovered payload is unchanged', () => {
    const ev = capture(() => dataEventEmitter.emitNodeDiscovered({ nodeNum: 7, packetId: 99 }, 'src'));
    expect(ev.data).toEqual({ nodeNum: 7, packetId: 99 });
  });
});

describe('routeEventToEngine hands the facts to the engine (#5595)', () => {
  const fakeEngine = () => ({ onNode: vi.fn().mockResolvedValue(0), onMeshCoreNode: vi.fn().mockResolvedValue(0) });
  const ev = (type: string, data: unknown): DataEvent => ({ type: type as DataEvent['type'], data, timestamp: 1, sourceId: 'src' });
  const facts = { advType: 3, hops: 2, routeHops: 4, lastHeard: HEARD_MS };

  it('node:discovered', async () => {
    const e = fakeEngine();
    await routeEventToEngine(e as any, ev('node:discovered', { nodeNum: null, publicKey: KEY, name: 'N', packetHash: HASH, ...facts }));
    expect(e.onMeshCoreNode).toHaveBeenCalledTimes(1);
    expect(e.onMeshCoreNode).toHaveBeenCalledWith('trigger.nodeDiscovered', KEY, [], 'src', { packetHash: HASH }, 'N', facts);
  });

  it('meshcore:node:changed', async () => {
    const e = fakeEngine();
    await routeEventToEngine(e as any, ev('meshcore:node:changed', { publicKey: KEY, name: 'N', changed: ['pathLen'], ...facts }));
    expect(e.onMeshCoreNode).toHaveBeenCalledTimes(1);
    expect(e.onMeshCoreNode).toHaveBeenCalledWith('trigger.nodeUpdated', KEY, ['pathLen'], 'src', { packetHash: undefined }, 'N', facts);
  });
});

const TEMPLATE =
  'name=[{{ trigger.name }}] role=[{{ trigger.roleName }}] hops=[{{ trigger.hops }}] ' +
  'route=[{{ trigger.routeHops }}] heard=[{{ trigger.lastHeard }}] short=[{{ trigger.shortName }}] ' +
  'nodeShort=[{{ node.shortName }}] hash=[{{ trigger.packetHash }}]';

describe('template render through the engine (#5595)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let resolver: VariableResolver;
  const bodies: string[] = [];

  const deps: ActionDeps = {
    sendMessage: async () => 1,
    sendTapback: async () => 2,
    manageNode: async () => 3,
    notify: async (a: any) => { bodies.push(String(a.body)); return 4; },
  };
  const data = { getNode: async () => null, getTelemetry: async () => null };

  beforeEach(async () => {
    bodies.length = 0;
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(drizzleDb, 'sqlite'));
    for (const type of ['trigger.nodeDiscovered', 'trigger.nodeUpdated']) {
      await autos.createAutomation({
        name: type,
        enabled: true,
        config: JSON.stringify({
          version: 1,
          nodes: [{ id: 't', type, params: {} }, { id: 'n', type: 'action.notify', params: { body: TEMPLATE } }],
          edges: [{ from: 't', to: 'n' }],
        }),
      });
    }
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const engineOf = async () => {
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => 1_000_000 });
    await engine.load();
    return engine;
  };

  it('renders every new token on nodeDiscovered', async () => {
    const engine = await engineOf();
    expect(await engine.onMeshCoreNode('trigger.nodeDiscovered', KEY, [], 'src', { packetHash: HASH }, 'Hilltop', {
      advType: 2, hops: 3, routeHops: 1, lastHeard: HEARD_MS,
    })).toBe(1);
    expect(bodies).toEqual([
      `name=[Hilltop] role=[Repeater] hops=[3] route=[1] heard=[${HEARD_MS}] short=[] nodeShort=[] hash=[${HASH}]`,
    ]);
  });

  it('renders every new token on nodeUpdated, with a direct advert as 0', async () => {
    const engine = await engineOf();
    expect(await engine.onMeshCoreNode('trigger.nodeUpdated', KEY, ['latitude'], 'src', { packetHash: HASH }, 'Base', {
      advType: 3, hops: 0, routeHops: 0, lastHeard: HEARD_MS,
    })).toBe(1);
    expect(bodies).toEqual([
      `name=[Base] role=[Room Server] hops=[0] route=[0] heard=[${HEARD_MS}] short=[] nodeShort=[] hash=[${HASH}]`,
    ]);
  });

  it('renders the new tokens empty, without throwing, when nothing is known', async () => {
    const engine = await engineOf();
    expect(await engine.onMeshCoreNode('trigger.nodeUpdated', KEY, ['pathLen'], 'src', undefined, 'Base')).toBe(1);
    expect(bodies).toEqual(['name=[Base] role=[] hops=[] route=[] heard=[] short=[] nodeShort=[] hash=[]']);
  });

  it('an event with no advert frame leaves hops empty even though a route is stored', async () => {
    const engine = await engineOf();
    await engine.onMeshCoreNode('trigger.nodeUpdated', KEY, ['pathLen'], 'src', undefined, 'Base', { advType: 2, routeHops: 2 });
    expect(bodies[0]).toContain('hops=[] route=[2]');
  });
});

describe('Test panel dry run (#5595)', () => {
  const graph = (type: string) => ({
    version: 1,
    nodes: [{ id: 't', type, params: {} }, { id: 'n', type: 'action.notify', params: { body: TEMPLATE } }],
    edges: [{ from: 't', to: 'n' }],
  });

  it('a public key makes the dry run a MeshCore event that shows the new tokens', async () => {
    const res = await simulateAutomation({
      graph: graph('trigger.nodeDiscovered'),
      event: {
        kind: 'nodeDiscovered', publicKey: KEY, name: 'Hilltop', advType: 4, hops: 2, routeHops: 5,
        lastHeard: HEARD_MS, packetHash: HASH,
      },
    } as any);
    expect(res.matched).toBe(true);
    expect(res.fields).toMatchObject({
      publicKey: KEY, name: 'Hilltop', roleName: 'Sensor', hops: 2, routeHops: 5, lastHeard: HEARD_MS, protocol: 'meshcore',
    });
    expect(JSON.stringify(res.actions)).toContain(
      `name=[Hilltop] role=[Sensor] hops=[2] route=[5] heard=[${HEARD_MS}] short=[] nodeShort=[] hash=[${HASH}]`,
    );
  });

  it('works for nodeUpdated too', async () => {
    const res = await simulateAutomation({
      graph: graph('trigger.nodeUpdated'),
      event: { kind: 'nodeUpdated', publicKey: KEY, name: 'Base', advType: 1, changed: ['name'] },
    } as any);
    expect(res.triggerType).toBe('trigger.nodeUpdated');
    expect(res.fields).toMatchObject({ roleName: 'Companion', changed: ['name'] });
    expect(res.fields.hops).toBeUndefined();
  });

  it('without a public key the dry run stays a Meshtastic event', async () => {
    const res = await simulateAutomation({
      graph: graph('trigger.nodeUpdated'),
      event: { kind: 'nodeUpdated', nodeNum: 9, changed: ['longName'] },
    } as any);
    expect(res.fields.nodeNum).toBe(9);
    expect(res.fields).not.toHaveProperty('roleName');
  });
});
