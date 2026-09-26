/**
 * trigger.becameLikelyAircraft — Likely-Aircraft Detection Phase 1 WP3
 * (#5364/#5365).
 *
 * Detection (classification, hysteresis, and the `previous !== true &&
 * current === true` transition decision) lives entirely in
 * `aircraftClassificationService.ts` (WP2) — this suite starts from the
 * `node:aircraft` DataEvent / `NodeAircraftData` payload it emits and covers:
 *  - the trigger context builder (subject node binding, field shape);
 *  - the engine firing + token surface + graph validation;
 *  - cooldown and a source-filter condition, reusing the generic engine
 *    machinery (no aircraft-specific code needed for either).
 *
 * Modeled on nodeRebooted.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { NodeDataProvider } from './engineContext.js';
import type { AutomationGraph } from '../../../types/automation.js';
import { validateAutomationGraph } from '../../../types/automation.js';
import { buildBecameLikelyAircraftContext } from './triggerContext.js';
import type { NodeAircraftData } from '../dataEventEmitter.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

function recorder() {
  const calls: Array<{ fn: string; args: any }> = [];
  const deps: ActionDeps = {
    sendMessage: async (a) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
    sendTapback: async (a) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
    manageNode: async (a) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
    notify: async (a) => { calls.push({ fn: 'notify', args: a }); return 4; },
    requestData: async (a) => { calls.push({ fn: 'requestData', args: a }); return 5; },
    rebootDevice: async (a) => { calls.push({ fn: 'rebootDevice', args: a }); return 6; },
    runScript: async (a) => { calls.push({ fn: 'runScript', args: a }); return { success: true, stdout: '' }; },
  };
  return { calls, deps };
}

function aircraftData(overrides: Partial<NodeAircraftData> = {}): NodeAircraftData {
  return {
    nodeNum: 111,
    previous: null,
    current: true,
    basis: 'agl',
    altitude: 3500,
    groundElevation: 500,
    heightAboveGround: 3000,
    thresholdM: 500,
    latitude: 40.0,
    longitude: -105.0,
    ...overrides,
  };
}

/** becameLikelyAircraft rule that notifies, tokenised so we can read the context back. */
function aircraftGraph(triggerParams: Record<string, unknown> = {}): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.becameLikelyAircraft', params: triggerParams },
      {
        id: 'n', type: 'action.notify',
        params: {
          title: 'aircraft',
          body: 'node={{ trigger.nodeNum }} basis={{ trigger.basis }} alt={{ trigger.altitude }} hag={{ trigger.heightAboveGround }} thr={{ trigger.thresholdM }} prev={{ trigger.previousLikelyAircraft }} src={{ trigger.sourceId }}',
        },
      },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

describe('buildBecameLikelyAircraftContext (#5364/#5365 Phase 1 WP3)', () => {
  it('binds subjectNodeNum and shapes the full field set', () => {
    const ctx = buildBecameLikelyAircraftContext(aircraftData({ nodeNum: 222 }), 'default', 1_000);
    expect(ctx.triggerType).toBe('trigger.becameLikelyAircraft');
    expect(ctx.sourceId).toBe('default');
    expect(ctx.subjectNodeNum).toBe(222);
    // No MeshCore degrade for this trigger (Meshtastic-only, D2) — subjectNodeKey
    // is left undefined so cooldown derives it from subjectNodeNum, same as the
    // Meshtastic branch of buildNodeRebootedContext.
    expect(ctx.subjectNodeKey).toBeUndefined();
    expect(ctx.fields).toEqual({
      nodeNum: 222,
      altitude: 3500,
      heightAboveGround: 3000,
      groundElevation: 500,
      basis: 'agl',
      thresholdM: 500,
      latitude: 40.0,
      longitude: -105.0,
      previousLikelyAircraft: null,
      sourceId: 'default',
      timestamp: 1_000,
    });
  });

  it('carries a null groundElevation/heightAboveGround for the MSL basis', () => {
    const ctx = buildBecameLikelyAircraftContext(
      aircraftData({ basis: 'msl', groundElevation: null, heightAboveGround: null, thresholdM: 5000, altitude: 6000 }),
      'mqtt-src',
      2_000,
    );
    expect(ctx.fields.basis).toBe('msl');
    expect(ctx.fields.groundElevation).toBeNull();
    expect(ctx.fields.heightAboveGround).toBeNull();
    expect(ctx.fields.thresholdM).toBe(5000);
  });
});

describe('trigger.becameLikelyAircraft engine (#5364/#5365 Phase 1 WP3)', () => {
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
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const data: NodeDataProvider = {
    getNode: async () => null,
    getTelemetry: async () => null,
  };
  const engineWith = (deps: ActionDeps) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => 1_000 });

  const createEnabled = (name: string, graph: AutomationGraph) =>
    autos.createAutomation({ name, enabled: true, config: JSON.stringify(graph) });

  it('validateAutomationGraph accepts a becameLikelyAircraft rule (no required params)', () => {
    expect(validateAutomationGraph(aircraftGraph()).valid).toBe(true);
  });

  it('fires once on a node:aircraft event, exposing the aircraft tokens', async () => {
    const { calls, deps } = recorder();
    await createEnabled('aircraft', aircraftGraph());
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 111 }), 'default')).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
    expect(calls[0].args.body).toBe('node=111 basis=agl alt=3500 hag=3000 thr=500 prev= src=default');
  });

  it('interpolates previousLikelyAircraft=false when re-flagged after a threshold-driven clear', async () => {
    const { calls, deps } = recorder();
    await createEnabled('aircraft', aircraftGraph());
    const engine = engineWith(deps);
    await engine.load();

    await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 111, previous: false }), 'default');
    expect(calls[0].args.body).toContain('prev=false');
  });

  it('does not fire when no becameLikelyAircraft automation is loaded', async () => {
    const { calls, deps } = recorder();
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onBecameLikelyAircraft(aircraftData(), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('carries the event source id into the context', async () => {
    const { calls, deps } = recorder();
    await createEnabled('aircraft', aircraftGraph());
    const engine = engineWith(deps);
    await engine.load();

    await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 333 }), 'sourceZ');
    expect(calls[0].args.body).toContain('node=333');
    expect(calls[0].args.body).toContain('src=sourceZ');
  });

  it('cooldownSeconds blocks a second fire for the same subject node within the window', async () => {
    const { calls, deps } = recorder();
    await createEnabled('aircraft-cd', aircraftGraph({ cooldownSeconds: 60, cooldownScope: 'node' }));
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 111 }), 'default')).toBe(1);
    // Same subject node, same `now()` (the fixed clock above) — well within the 60s window.
    expect(await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 111 }), 'default')).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('cooldownScope "node" does not block a DIFFERENT subject node', async () => {
    const { calls, deps } = recorder();
    await createEnabled('aircraft-cd', aircraftGraph({ cooldownSeconds: 60, cooldownScope: 'node' }));
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 111 }), 'default')).toBe(1);
    expect(await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 222 }), 'default')).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('a condition.sourceFilter blocks a rule scoped to a different source', async () => {
    const { calls, deps } = recorder();
    const graph: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.becameLikelyAircraft', params: {} },
        { id: 'c', type: 'condition.sourceFilter', params: { sourceIds: ['other-source'] } },
        { id: 'n', type: 'action.notify', params: { title: 'aircraft', body: '{{ trigger.nodeNum }}' } },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'n', port: 'true' }],
    };
    await createEnabled('aircraft-filtered', graph);
    const engine = engineWith(deps);
    await engine.load();

    // Trigger fires (runTrigger counts it as fired — the condition then blocks the action).
    await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 111 }), 'default');
    expect(calls).toHaveLength(0);

    await engine.onBecameLikelyAircraft(aircraftData({ nodeNum: 111 }), 'other-source');
    expect(calls).toHaveLength(1);
  });
});
