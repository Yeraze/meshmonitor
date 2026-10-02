/**
 * #5534: `{{ trigger.packetId }}` / `{{ trigger.packetHash }}` on
 * trigger.nodeUpdated / trigger.nodeDiscovered.
 *
 * Covers the three seams: the event payload (`emitNodeUpdate` origin), the
 * context builder, and end-to-end interpolation through the engine — including
 * the "no originating packet ⇒ empty, never a previous packet's value" rule.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';
import { buildNodeContext } from './triggerContext.js';
import { simulateAutomation } from './automationSimulator.js';
import { dataEventEmitter, type DataEvent } from '../dataEventEmitter.js';

const HASH = '3A24AED15A9CB70A';

describe('buildNodeContext packet tokens (#5534)', () => {
  it('carries a Meshtastic packetId as unsigned 32-bit', () => {
    // A protobuf fixed32 above 2^31 can surface as a negative int on some paths.
    const ctx = buildNodeContext('trigger.nodeUpdated', 7, ['latitude'], 'src', 5, { packetId: -1 });
    expect(ctx.fields.packetId).toBe(0xffffffff);
    expect(ctx.fields.packetHash).toBeUndefined();
  });

  it('carries a MeshCore packetHash verbatim', () => {
    const ctx = buildNodeContext('trigger.nodeDiscovered', 7, [], 'src', 5, { packetHash: HASH });
    expect(ctx.fields.packetHash).toBe(HASH);
    expect(ctx.fields.packetId).toBeUndefined();
  });

  it('leaves both undefined with no origin, an empty origin, or packet id 0', () => {
    for (const origin of [undefined, {}, { packetId: 0, packetHash: '' }]) {
      const ctx = buildNodeContext('trigger.nodeUpdated', 7, [], 'src', 5, origin);
      expect(ctx.fields).toHaveProperty('packetId', undefined);
      expect(ctx.fields).toHaveProperty('packetHash', undefined);
    }
  });
});

describe('emitNodeUpdate origin payload (#5534)', () => {
  function capture(fn: () => void): DataEvent {
    let got: DataEvent | undefined;
    const listener = (e: DataEvent) => { got = e; };
    dataEventEmitter.on('data', listener);
    try { fn(); } finally { dataEventEmitter.off('data', listener); }
    expect(got).toBeDefined();
    return got!;
  }

  it('keeps the exact { nodeNum, node } shape when there is no origin', () => {
    const ev = capture(() => dataEventEmitter.emitNodeUpdate(5, { longName: 'x' }, 'src'));
    expect(ev.data).toEqual({ nodeNum: 5, node: { longName: 'x' } });
  });

  it('attaches packetId (unsigned) and packetHash when given', () => {
    const ev = capture(() =>
      dataEventEmitter.emitNodeUpdate(5, { latitude: 1 }, 'src', { packetId: 0xf0000001 }),
    );
    expect(ev.data).toEqual({ nodeNum: 5, node: { latitude: 1 }, packetId: 0xf0000001 });

    const mc = capture(() => dataEventEmitter.emitNodeUpdate(5, {}, 'src', { packetHash: HASH }));
    expect(mc.data).toEqual({ nodeNum: 5, node: {}, packetHash: HASH });
  });

  it('drops a packet id of 0 (Meshtastic "no id")', () => {
    const ev = capture(() => dataEventEmitter.emitNodeUpdate(5, {}, 'src', { packetId: 0 }));
    expect(ev.data).toEqual({ nodeNum: 5, node: {} });
  });
});

describe('engine interpolation of node packet tokens (#5534)', () => {
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
    await autos.createAutomation({
      name: 'node-pkt',
      enabled: true,
      config: JSON.stringify({
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.nodeUpdated', params: {} },
          { id: 'n', type: 'action.notify', params: { body: 'id=[{{ trigger.packetId }}] hash=[{{ trigger.packetHash }}]' } },
        ],
        edges: [{ from: 't', to: 'n' }],
      }),
    });
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  it('renders the originating packet id, then empty for a packetless update (no carry-over)', async () => {
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => 1_000_000 });
    await engine.load();

    expect(await engine.onNode('trigger.nodeUpdated', 0x1234, ['latitude'], 'src', { packetId: 0xdeadbeef })).toBe(1);
    expect(await engine.onNode('trigger.nodeUpdated', 0x1234, ['isFavorite'], 'src')).toBe(1);

    expect(bodies).toEqual([`id=[${0xdeadbeef}] hash=[]`, 'id=[] hash=[]']);
  });

  it('renders a MeshCore packetHash', async () => {
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => 1_000_000 });
    await engine.load();

    await engine.onNode('trigger.nodeUpdated', 0x1234, [], 'src', { packetHash: HASH });
    expect(bodies).toEqual([`id=[] hash=[${HASH}]`]);
  });
});

describe('simulator passes node packet tokens (#5534)', () => {
  it('threads packetId/packetHash from the synthetic event', async () => {
    const res = await simulateAutomation({
      graph: {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.nodeDiscovered', params: {} },
          { id: 'n', type: 'action.notify', params: { body: '{{ trigger.packetHash }}' } },
        ],
        edges: [{ from: 't', to: 'n' }],
      },
      event: { kind: 'nodeDiscovered', nodeNum: 9, packetHash: HASH, packetId: 77 },
    } as any);
    expect(JSON.stringify(res)).toContain(HASH);
  });
});
