/**
 * #5675: `{{ trigger.ageMinutes }}` on the MeshCore trigger.nodeDiscovered and
 * trigger.nodeUpdated.
 *
 * Covers the shared formula (the same one `{{ node.ageMinutes }}` uses on
 * Meshtastic), the units a MeshCore producer can hand over, the first-heard
 * case, a template rendered through the real engine, and the Test panel's
 * dry run.
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
import { ageMinutesSince, buildMeshCoreNodeContext, type TriggerContext } from './triggerContext.js';
import { resolveFieldValue, type EngineEvalContext, type NodeFacts } from './engineContext.js';
import { simulateAutomation } from './automationSimulator.js';
import { meshCoreNodeTriggerPayload } from '../../meshcoreManager.js';

const KEY = 'ab'.repeat(32);
const NOW_MS = 1_791_366_294_000; // the stamp from the issue report (Oct 2026), in ms
const MIN = 60_000;

const TRIGGERS = ['trigger.nodeDiscovered', 'trigger.nodeUpdated'] as const;

const fieldsOf = (
  lastHeard: unknown,
  now = NOW_MS,
  type: (typeof TRIGGERS)[number] = 'trigger.nodeDiscovered',
) => buildMeshCoreNodeContext(type, KEY, [], 'src', now, undefined, 'Hill', { lastHeard: lastHeard as number }).fields;

/** `{{ node.ageMinutes }}` as the Meshtastic path resolves it, for a node row. */
async function meshtasticAge(lastHeard: number | null, now: number): Promise<unknown> {
  const trigger: TriggerContext = { triggerType: 'trigger.nodeDiscovered', sourceId: 'src', subjectNodeNum: 1, timestamp: now, fields: {} };
  const ctx = {
    trigger,
    data: { getNode: async () => ({ nodeNum: 1, lastHeard }) as unknown as NodeFacts, getTelemetry: async () => null },
    varCtx: { sourceId: 'src', nodeNum: 1 },
    now,
  } as unknown as EngineEvalContext;
  return resolveFieldValue(ctx, 'node.ageMinutes');
}

describe('ageMinutesSince (#5675)', () => {
  it('rounds to the nearest whole minute', () => {
    expect(ageMinutesSince(NOW_MS, NOW_MS)).toBe(0);
    expect(ageMinutesSince(NOW_MS - 29_000, NOW_MS)).toBe(0);
    expect(ageMinutesSince(NOW_MS - 30_000, NOW_MS)).toBe(1);
    expect(ageMinutesSince(NOW_MS - 89_000, NOW_MS)).toBe(1);
    expect(ageMinutesSince(NOW_MS - 90_000, NOW_MS)).toBe(2);
    expect(ageMinutesSince(NOW_MS - 24 * 60 * MIN, NOW_MS)).toBe(1440);
  });

  it('is never negative: a stamp ahead of our clock reads 0', () => {
    expect(ageMinutesSince(NOW_MS + 1, NOW_MS)).toBe(0);
    expect(ageMinutesSince(NOW_MS + 10 * MIN, NOW_MS)).toBe(0);
  });
});

describe('trigger.ageMinutes matches node.ageMinutes for the same instants (#5675)', () => {
  // Whole seconds, since a Meshtastic node row stores lastHeard in seconds.
  const AGES_SEC = [0, 1, 29, 30, 31, 59, 60, 89, 90, 150, 3600, 86_400, 30 * 86_400, -1, -600];

  it.each(AGES_SEC)('%i s ago', async (ageSec) => {
    const heardMs = NOW_MS - ageSec * 1000;
    const meshcore = fieldsOf(heardMs).ageMinutes; // MeshCore: epoch ms
    const meshtastic = await meshtasticAge(heardMs / 1000, NOW_MS); // Meshtastic: epoch seconds
    expect(meshcore).toBe(meshtastic);
    expect(meshcore).toBeGreaterThanOrEqual(0);
  });

  it('both are empty when the last-heard time is unknown', async () => {
    expect(fieldsOf(undefined).ageMinutes).toBeUndefined();
    expect(await meshtasticAge(null, NOW_MS)).toBeUndefined();
  });
});

describe('buildMeshCoreNodeContext ageMinutes (#5675)', () => {
  it.each(TRIGGERS)('%s: a node heard just now is 0', (type) => {
    expect(fieldsOf(NOW_MS, NOW_MS, type).ageMinutes).toBe(0);
  });

  it.each(TRIGGERS)('%s: a node heard 7 minutes ago is 7', (type) => {
    expect(fieldsOf(NOW_MS - 7 * MIN, NOW_MS, type).ageMinutes).toBe(7);
  });

  it('epoch milliseconds (what every producer sends) is not read as a huge age', () => {
    const f = fieldsOf(NOW_MS - 3 * MIN);
    expect(f.ageMinutes).toBe(3);
    expect(f.lastHeard).toBe(NOW_MS - 3 * MIN); // lastHeard itself is unchanged
  });

  it('epoch seconds is scaled the same way lastHeard is, so the two tokens agree', () => {
    const f = fieldsOf((NOW_MS - 3 * MIN) / 1000);
    expect(f.lastHeard).toBe(NOW_MS - 3 * MIN);
    expect(f.ageMinutes).toBe(3);
  });

  it('a stamp ahead of the event clock is 0, never negative', () => {
    expect(fieldsOf(NOW_MS + 5 * MIN).ageMinutes).toBe(0);
  });

  it('is undefined (renders empty) when the last-heard time is unknown', () => {
    for (const lastHeard of [undefined, null, 0, -5, NaN, '']) {
      expect(fieldsOf(lastHeard).ageMinutes).toBeUndefined();
    }
    const noFacts = buildMeshCoreNodeContext('trigger.nodeUpdated', KEY, [], 'src', NOW_MS).fields;
    expect(noFacts.ageMinutes).toBeUndefined();
  });

  it('the live payload of a first advert (lastSeen = now, in ms) gives 0', () => {
    // The advert handler stamps lastSeen with Date.now() before it raises the event.
    const facts = meshCoreNodeTriggerPayload({ advType: 2, pathLen: null, lastSeen: NOW_MS }, { hops: 1 });
    const f = buildMeshCoreNodeContext('trigger.nodeDiscovered', KEY, [], 'src', NOW_MS + 40, undefined, 'New', facts).fields;
    expect(f.ageMinutes).toBe(0);
  });

  it('the live payload of a contact with no lastSeen leaves it empty', () => {
    const facts = meshCoreNodeTriggerPayload({ advType: 2, pathLen: 1, lastSeen: undefined }, undefined);
    const f = buildMeshCoreNodeContext('trigger.nodeUpdated', KEY, ['pathLen'], 'src', NOW_MS, undefined, 'Old', facts).fields;
    expect(f.ageMinutes).toBeUndefined();
    expect(f.lastHeard).toBeUndefined();
  });
});

const TEMPLATE = 'Last heard: {{ trigger.ageMinutes }} m';

describe('template render through the engine (#5675)', () => {
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
    for (const type of TRIGGERS) {
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
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => NOW_MS });
    await engine.load();
    return engine;
  };

  it('a discovery heard just now renders "Last heard: 0 m", as Meshtastic does', async () => {
    const engine = await engineOf();
    await engine.onMeshCoreNode('trigger.nodeDiscovered', KEY, [], 'src', undefined, 'Hilltop', { lastHeard: NOW_MS });
    expect(bodies).toEqual(['Last heard: 0 m']);
  });

  it('an update renders whole minutes', async () => {
    const engine = await engineOf();
    await engine.onMeshCoreNode('trigger.nodeUpdated', KEY, ['pathLen'], 'src', undefined, 'Base', { lastHeard: NOW_MS - 12 * MIN });
    expect(bodies).toEqual(['Last heard: 12 m']);
  });

  it('renders empty, without throwing, when the last-heard time is unknown', async () => {
    const engine = await engineOf();
    await engine.onMeshCoreNode('trigger.nodeUpdated', KEY, ['pathLen'], 'src', undefined, 'Base');
    expect(bodies).toEqual(['Last heard:  m']);
  });
});

describe('Test panel dry run (#5675)', () => {
  const graph = (type: string) => ({
    version: 1,
    nodes: [{ id: 't', type, params: {} }, { id: 'n', type: 'action.notify', params: { body: TEMPLATE } }],
    edges: [{ from: 't', to: 'n' }],
  });

  it.each([
    ['nodeDiscovered', 'trigger.nodeDiscovered'],
    ['nodeUpdated', 'trigger.nodeUpdated'],
  ])('%s: works ageMinutes out from the "Last heard (epoch ms)" input', async (kind, type) => {
    const res = await simulateAutomation({
      graph: graph(type),
      event: { kind, publicKey: KEY, name: 'Hilltop', lastHeard: Date.now() - 5 * MIN },
    } as any);
    expect(res.matched).toBe(true);
    expect(res.fields.ageMinutes).toBe(5);
    expect(JSON.stringify(res.actions)).toContain('Last heard: 5 m');
  });

  it('leaves it empty when no last-heard time is entered', async () => {
    const res = await simulateAutomation({
      graph: graph('trigger.nodeDiscovered'),
      event: { kind: 'nodeDiscovered', publicKey: KEY, name: 'Hilltop' },
    } as any);
    expect(res.fields.ageMinutes).toBeUndefined();
    expect(JSON.stringify(res.actions)).toContain('Last heard:  m');
  });

  it('a Meshtastic dry run (no public key) carries no trigger.ageMinutes', async () => {
    const res = await simulateAutomation({
      graph: graph('trigger.nodeUpdated'),
      event: { kind: 'nodeUpdated', nodeNum: 9, changed: ['longName'] },
    } as any);
    expect(res.fields).not.toHaveProperty('ageMinutes');
  });
});
