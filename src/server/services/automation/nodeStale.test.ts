/**
 * trigger.nodeStale / trigger.nodeOnline — Device Health Phase A (#4558).
 *
 * Staleness is packet ABSENCE, so it is driven by a periodic evaluation
 * (`runStaleCheck`) rather than an event. These tests drive that method directly
 * against an injected clock and a mutable candidate list, plus the live-update
 * recovery path (`checkNodeOnline`). They assert the transition semantics that
 * matter for the mesh-impact checklist: fire exactly once per online→stale
 * transition, never re-fire while stale, re-arm on recovery, and — crucially —
 * do NOT re-fire already-stale nodes after a restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { NodeDataProvider, StaleCandidate } from './engineContext.js';
import type { AutomationGraph } from '../../../types/automation.js';
import { validateAutomationGraph } from '../../../types/automation.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

const MIN = 60_000;

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

/** nodeStale rule that notifies, tokenised so we can read the context fields back. */
function staleGraph(staleAfterMinutes: number): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.nodeStale', params: { staleAfterMinutes } },
      { id: 'n', type: 'action.notify', params: { title: 'stale', body: 'node={{ trigger.nodeNum }} age={{ trigger.ageMinutes }} thr={{ trigger.staleAfterMinutes }}' } },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

/** nodeOnline (recovery) rule that notifies with the offline duration. */
function onlineGraph(staleAfterMinutes: number): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.nodeOnline', params: { staleAfterMinutes } },
      { id: 'n', type: 'action.notify', params: { title: 'online', body: 'node={{ trigger.nodeNum }} pk={{ trigger.publicKey }} off={{ trigger.offlineDurationMinutes }}' } },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

describe('trigger.nodeStale / trigger.nodeOnline (#4558)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let resolver: VariableResolver;
  let clock: number;
  let candidates: StaleCandidate[];

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(drizzleDb, 'sqlite'));
    clock = 10 * 60 * MIN; // t0 well past epoch so ages stay positive
    candidates = [];
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const data: NodeDataProvider = {
    getNode: async () => null,
    getTelemetry: async () => null,
    listNodesForStaleCheck: async () => candidates,
  };
  const engineWith = (deps: ActionDeps) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => clock });

  const createEnabled = (name: string, graph: AutomationGraph) =>
    autos.createAutomation({ name, enabled: true, config: JSON.stringify(graph) });

  // ── validation ────────────────────────────────────────────────────────────

  it('validateAutomationGraph accepts both triggers with a positive threshold', () => {
    expect(validateAutomationGraph(staleGraph(60)).valid).toBe(true);
    expect(validateAutomationGraph(onlineGraph(60)).valid).toBe(true);
  });

  it('validateAutomationGraph rejects a missing / non-positive staleAfterMinutes', () => {
    const bad = staleGraph(60);
    (bad.nodes[0].params as any).staleAfterMinutes = 0;
    expect(validateAutomationGraph(bad).valid).toBe(false);
    delete (bad.nodes[0].params as any).staleAfterMinutes;
    expect(validateAutomationGraph(bad).valid).toBe(false);
  });

  // ── nodeStale core transition semantics ─────────────────────────────────────

  it('fires nodeStale exactly once on the online→stale transition, then never while stale', async () => {
    const { calls, deps } = recorder();
    await createEnabled('stale', staleGraph(60));
    const engine = engineWith(deps);
    await engine.load();

    // Node heard 10 min ago (fresh, threshold 60). First tick baselines it.
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock - 10 * MIN }];
    expect(await engine.runStaleCheck()).toBe(0);
    expect(calls).toHaveLength(0);

    // Time passes so age crosses 60 min → fires once.
    clock += 55 * MIN; // now heard 65 min ago
    expect(await engine.runStaleCheck()).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
    expect(calls[0].args.body).toBe('node=111 age=65 thr=60');

    // Still silent on the next ticks → no re-fire.
    clock += 30 * MIN;
    expect(await engine.runStaleCheck()).toBe(0);
    clock += 30 * MIN;
    expect(await engine.runStaleCheck()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('re-arms: heard again fires nodeOnline once, then going silent fires nodeStale again', async () => {
    const { calls, deps } = recorder();
    await createEnabled('stale', staleGraph(60));
    await createEnabled('online', onlineGraph(60));
    const engine = engineWith(deps);
    await engine.load();

    // Baseline fresh.
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock - 5 * MIN }];
    await engine.runStaleCheck();

    // Go stale → nodeStale fires.
    clock += 60 * MIN;
    expect(await engine.runStaleCheck()).toBe(1);
    expect(calls.filter((c) => c.args.title === 'stale')).toHaveLength(1);

    // Heard again (lastHeard jumps to now) → tick fires nodeOnline once.
    clock += 5 * MIN;
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];
    expect(await engine.runStaleCheck()).toBe(1);
    const online = calls.filter((c) => c.args.title === 'online');
    expect(online).toHaveLength(1);
    // Offline gap = from the last-heard-before-stale (t0-5m) to recovery (t0+65m) ≈ 70 min.
    expect(online[0].args.body).toBe('node=111 pk= off=70');

    // Recovery does not re-fire while it stays fresh.
    clock += 5 * MIN;
    expect(await engine.runStaleCheck()).toBe(0);

    // Goes silent again → nodeStale fires a SECOND time (re-armed).
    clock += 60 * MIN;
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock - 65 * MIN }];
    expect(await engine.runStaleCheck()).toBe(1);
    expect(calls.filter((c) => c.args.title === 'stale')).toHaveLength(2);
  });

  it('does NOT re-fire nodeStale for already-stale nodes after a restart (baseline only)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('stale', staleGraph(60));
    // Fresh engine == a process restart: staleState starts empty.
    const engine = engineWith(deps);
    await engine.load();

    // Node has been silent for 3 hours when the engine starts.
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock - 180 * MIN }];
    expect(await engine.runStaleCheck()).toBe(0); // first sighting → baseline, no fire
    clock += 30 * MIN;
    expect(await engine.runStaleCheck()).toBe(0); // still stale, still no fire
    expect(calls).toHaveLength(0);
  });

  // ── independence + scoping ──────────────────────────────────────────────────

  it('honours each automation’s own threshold independently', async () => {
    const { calls, deps } = recorder();
    await createEnabled('fast', staleGraph(30));
    await createEnabled('slow', staleGraph(120));
    const engine = engineWith(deps);
    await engine.load();

    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];
    await engine.runStaleCheck(); // baseline both

    // 45 min silent: only the 30-min rule fires.
    clock += 45 * MIN;
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock - 45 * MIN }];
    expect(await engine.runStaleCheck()).toBe(1);
    expect(calls).toHaveLength(1);

    // 130 min silent: now the 120-min rule fires too (the fast one stays quiet).
    clock += 85 * MIN;
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock - 130 * MIN }];
    expect(await engine.runStaleCheck()).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('scopes state per (source, node): the same node number on two sources is tracked separately', async () => {
    const { calls, deps } = recorder();
    await createEnabled('stale', staleGraph(60));
    const engine = engineWith(deps);
    await engine.load();

    candidates = [
      { sourceId: 'A', nodeNum: 111, publicKey: null, lastHeardMs: clock - 5 * MIN },
      { sourceId: 'B', nodeNum: 111, publicKey: null, lastHeardMs: clock - 5 * MIN },
    ];
    await engine.runStaleCheck();

    // Only source A goes silent; B keeps being heard.
    clock += 60 * MIN;
    candidates = [
      { sourceId: 'A', nodeNum: 111, publicKey: null, lastHeardMs: clock - 65 * MIN },
      { sourceId: 'B', nodeNum: 111, publicKey: null, lastHeardMs: clock },
    ];
    expect(await engine.runStaleCheck()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.sourceId).toBe('A');
  });

  // ── MeshCore path (pubkey, no node number) ──────────────────────────────────

  it('fires for a MeshCore node keyed by public key, then recovers via the tick', async () => {
    const { calls, deps } = recorder();
    await createEnabled('stale', staleGraph(60));
    await createEnabled('online', onlineGraph(60));
    const engine = engineWith(deps);
    await engine.load();

    candidates = [{ sourceId: 'mc', nodeNum: null, publicKey: 'ABCDEF', lastHeardMs: clock - 5 * MIN }];
    await engine.runStaleCheck();

    clock += 60 * MIN;
    candidates = [{ sourceId: 'mc', nodeNum: null, publicKey: 'ABCDEF', lastHeardMs: clock - 65 * MIN }];
    expect(await engine.runStaleCheck()).toBe(1);
    const staleCalls = calls.filter((c) => c.args.title === 'stale');
    expect(staleCalls).toHaveLength(1);

    // Heard again → nodeOnline fires via the tick fallback (no node:updated for MeshCore).
    clock += 5 * MIN;
    candidates = [{ sourceId: 'mc', nodeNum: null, publicKey: 'ABCDEF', lastHeardMs: clock }];
    expect(await engine.runStaleCheck()).toBe(1);
    const onlineCalls = calls.filter((c) => c.args.title === 'online');
    expect(onlineCalls).toHaveLength(1);
    expect(onlineCalls[0].args.body).toContain('pk=ABCDEF');
  });

  // ── live-update recovery path ───────────────────────────────────────────────

  it('checkNodeOnline fires nodeOnline immediately when a marked-stale node is heard, and does not double-fire with the tick', async () => {
    const { calls, deps } = recorder();
    await createEnabled('online', onlineGraph(60));
    const engine = engineWith(deps);
    await engine.load();

    // Baseline, then go stale (the tick marks it; nodeOnline rule fires nothing yet).
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock - 5 * MIN }];
    await engine.runStaleCheck();
    clock += 60 * MIN;
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock - 65 * MIN }];
    expect(await engine.runStaleCheck()).toBe(0); // nodeStale-side stays silent for an online rule
    expect(calls).toHaveLength(0);

    // Live update: node heard again.
    clock += 1 * MIN;
    expect(await engine.checkNodeOnline(111, 'default')).toBe(1);
    expect(calls.filter((c) => c.args.title === 'online')).toHaveLength(1);

    // The next tick sees the node as fresh AND the mark already cleared → no double-fire.
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];
    expect(await engine.runStaleCheck()).toBe(0);
    expect(calls.filter((c) => c.args.title === 'online')).toHaveLength(1);
  });

  it('is a no-op when the provider cannot enumerate nodes', async () => {
    const { calls, deps } = recorder();
    await createEnabled('stale', staleGraph(60));
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps,
      data: { getNode: async () => null, getTelemetry: async () => null }, // no listNodesForStaleCheck
      now: () => clock,
    });
    await engine.load();
    expect(await engine.runStaleCheck()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
