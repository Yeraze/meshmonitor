/**
 * trigger.batteryTrend — Device Health Phase E (#4558).
 *
 * A declining-battery heuristic ("solar node losing charge / not charging").
 * Battery decline is a slow trend with no packet to react to, so it is driven by
 * a periodic evaluation (`runBatteryTrendCheck`) that recomputes the drop from
 * durable telemetry history each tick. These tests drive that method directly
 * against an injected clock and a mutable battery-history map, asserting the
 * mesh-impact semantics that matter: fire exactly once per decline, never re-fire
 * while still declining, re-arm on recovery, respect each rule's own
 * window/threshold, scope per (source, node), and — crucially — do NOT replay an
 * alert for an already-declining node after a restart.
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

const HOUR = 3_600_000;

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

/** batteryTrend rule that notifies, tokenised so we can read the context fields back. */
function trendGraph(windowHours: number, minDropPercent: number): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.batteryTrend', params: { windowHours, minDropPercent } },
      {
        id: 'n', type: 'action.notify',
        params: {
          title: 'trend',
          body: 'node={{ trigger.nodeNum }} drop={{ trigger.dropPercent }} start={{ trigger.startLevel }} latest={{ trigger.latestLevel }} win={{ trigger.windowHours }} min={{ trigger.minDropPercent }}',
        },
      },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

describe('trigger.batteryTrend (#4558 Phase E)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let resolver: VariableResolver;
  let clock: number;
  let candidates: StaleCandidate[];
  /** `${sourceId}:${nodeNum}` → full battery history (the provider windows it by sinceMs). */
  let history: Map<string, Array<{ timestamp: number; value: number }>>;
  /** `${sourceId}:${publicKey}` → full battery-VOLTS history for MeshCore nodes. */
  let mcHistory: Map<string, Array<{ timestamp: number; value: number }>>;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(drizzleDb, 'sqlite'));
    clock = 1000 * HOUR; // well past epoch
    candidates = [];
    history = new Map();
    mcHistory = new Map();
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const data: NodeDataProvider = {
    getNode: async () => null,
    getTelemetry: async () => null,
    listNodesForStaleCheck: async () => candidates,
    // Mirrors the real provider: return only samples inside the window.
    getBatteryTrendSamples: async (sourceId, nodeNum, sinceMs) => {
      const all = history.get(`${sourceId ?? ''}:${nodeNum}`) ?? [];
      return all.filter((s) => s.timestamp >= sinceMs);
    },
    // MeshCore volts history, keyed by pubkey (#4558 follow-up).
    getMeshCoreBatteryTrendSamples: async (sourceId, publicKey, sinceMs) => {
      const all = mcHistory.get(`${sourceId ?? ''}:${publicKey}`) ?? [];
      return all.filter((s) => s.timestamp >= sinceMs);
    },
  };
  const engineWith = (deps: ActionDeps) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => clock });

  const createEnabled = (name: string, graph: AutomationGraph) =>
    autos.createAutomation({ name, enabled: true, config: JSON.stringify(graph) });

  const setHistory = (sourceId: string, nodeNum: number, samples: Array<{ timestamp: number; value: number }>) =>
    history.set(`${sourceId}:${nodeNum}`, samples);

  const setMcHistory = (sourceId: string, publicKey: string, samples: Array<{ timestamp: number; value: number }>) =>
    mcHistory.set(`${sourceId}:${publicKey}`, samples);

  /** batteryTrend rule tokenised to read back the MeshCore pubkey identity. */
  const mcTrendGraph = (windowHours: number, minDropPercent: number): AutomationGraph => ({
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.batteryTrend', params: { windowHours, minDropPercent } },
      {
        id: 'n', type: 'action.notify',
        params: {
          title: 'trend',
          body: 'node={{ trigger.nodeNum }} key={{ trigger.publicKey }} drop={{ trigger.dropPercent }} start={{ trigger.startLevel }} latest={{ trigger.latestLevel }}',
        },
      },
    ],
    edges: [{ from: 't', to: 'n' }],
  });

  // ── validation ──────────────────────────────────────────────────────────────

  it('validateAutomationGraph accepts a positive window and drop', () => {
    expect(validateAutomationGraph(trendGraph(12, 20)).valid).toBe(true);
  });

  it('validateAutomationGraph rejects a missing / non-positive windowHours or minDropPercent', () => {
    const badWin = trendGraph(12, 20);
    (badWin.nodes[0].params as any).windowHours = 0;
    expect(validateAutomationGraph(badWin).valid).toBe(false);
    delete (badWin.nodes[0].params as any).windowHours;
    expect(validateAutomationGraph(badWin).valid).toBe(false);

    const badDrop = trendGraph(12, 20);
    (badDrop.nodes[0].params as any).minDropPercent = 0;
    expect(validateAutomationGraph(badDrop).valid).toBe(false);
    delete (badDrop.nodes[0].params as any).minDropPercent;
    expect(validateAutomationGraph(badDrop).valid).toBe(false);
  });

  // ── core transition semantics ────────────────────────────────────────────────

  it('fires once when the battery drops ≥ threshold over the window, then never while still declining', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(12, 20));
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];

    // Baseline tick: battery flat → calm baseline, no fire.
    setHistory('default', 111, [{ timestamp: clock - 2 * HOUR, value: 100 }, { timestamp: clock, value: 99 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(0);

    // Battery falls 100 → 70 across the window (30-point drop) → fires once.
    setHistory('default', 111, [
      { timestamp: clock - 3 * HOUR, value: 100 },
      { timestamp: clock - 1 * HOUR, value: 88 },
      { timestamp: clock, value: 70 },
    ]);
    expect(await engine.runBatteryTrendCheck()).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
    expect(calls[0].args.body).toBe('node=111 drop=30 start=100 latest=70 win=12 min=20');

    // Still declining on the next tick → no re-fire.
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('does NOT fire on a stable or rising battery', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(12, 20));
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];

    // Flat.
    setHistory('default', 111, [{ timestamp: clock - 4 * HOUR, value: 90 }, { timestamp: clock, value: 90 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    // Rising (charging): latest > start ⇒ negative drop.
    setHistory('default', 111, [{ timestamp: clock - 4 * HOUR, value: 60 }, { timestamp: clock, value: 95 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does NOT fire with fewer than two samples in the window', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(12, 20));
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];

    // A single reading — no trend can be described.
    setHistory('default', 111, [{ timestamp: clock, value: 40 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('ignores samples older than the window (only in-window drop counts)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(6, 20)); // 6-hour window
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];

    // A big drop, but it happened 20h ago — outside the 6h window, which now holds
    // only a shallow 2-point in-window change. Baseline then re-check: never fires.
    setHistory('default', 111, [
      { timestamp: clock - 20 * HOUR, value: 100 },
      { timestamp: clock - 2 * HOUR, value: 72 },
      { timestamp: clock, value: 70 },
    ]);
    expect(await engine.runBatteryTrendCheck()).toBe(0); // baseline (in-window drop = 2)
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  // ── restart safety ────────────────────────────────────────────────────────────

  it('does NOT replay an alert for an already-declining node after a restart (baseline only)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(12, 20));
    // Fresh engine == a process restart: batteryTrendState starts empty.
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];

    // The node is ALREADY well into a steep decline when the engine starts.
    setHistory('default', 111, [
      { timestamp: clock - 5 * HOUR, value: 95 },
      { timestamp: clock, value: 50 },
    ]);
    expect(await engine.runBatteryTrendCheck()).toBe(0); // first sighting → baseline, no fire
    expect(await engine.runBatteryTrendCheck()).toBe(0); // still declining, still no fire
    expect(calls).toHaveLength(0);
  });

  // ── fire-once + re-arm ──────────────────────────────────────────────────────────

  it('re-arms: fires on decline, goes quiet, then fires again after a recovery', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(12, 20));
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];

    // Baseline calm.
    setHistory('default', 111, [{ timestamp: clock - 2 * HOUR, value: 100 }, { timestamp: clock, value: 99 }]);
    await engine.runBatteryTrendCheck();

    // Decline → fires once.
    setHistory('default', 111, [{ timestamp: clock - 3 * HOUR, value: 100 }, { timestamp: clock, value: 74 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(1);
    expect(calls.filter((c) => c.args.title === 'trend')).toHaveLength(1);

    // Recovery (charged back up): net drop goes negative → re-arm, no fire.
    setHistory('default', 111, [{ timestamp: clock - 3 * HOUR, value: 74 }, { timestamp: clock, value: 100 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0);

    // Declines again → fires a SECOND time (re-armed).
    setHistory('default', 111, [{ timestamp: clock - 3 * HOUR, value: 100 }, { timestamp: clock, value: 70 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(1);
    expect(calls.filter((c) => c.args.title === 'trend')).toHaveLength(2);
  });

  // ── independence + scoping ────────────────────────────────────────────────────

  it('honours each automation’s own window and threshold independently', async () => {
    const { calls, deps } = recorder();
    await createEnabled('short-window', trendGraph(6, 10));  // shallow window, small drop
    await createEnabled('long-window', trendGraph(24, 10));  // wide window, same drop
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];

    // Baseline both calm (flat).
    setHistory('default', 111, [{ timestamp: clock - 5 * HOUR, value: 100 }, { timestamp: clock, value: 100 }]);
    await engine.runBatteryTrendCheck();

    // A slow decline: only a 4-point fall inside 6h, but a 14-point fall inside 24h.
    setHistory('default', 111, [
      { timestamp: clock - 20 * HOUR, value: 100 },
      { timestamp: clock - 5 * HOUR, value: 90 },
      { timestamp: clock - 1 * HOUR, value: 88 },
      { timestamp: clock, value: 86 },
    ]);
    // Only the 24h rule sees a drop ≥ its threshold.
    expect(await engine.runBatteryTrendCheck()).toBe(1);
    const fired = calls.filter((c) => c.args.title === 'trend');
    expect(fired).toHaveLength(1);
    expect(fired[0].args.body).toContain('win=24');
  });

  it('scopes state per (source, node): the same node number on two sources is tracked separately', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(12, 20));
    const engine = engineWith(deps);
    await engine.load();
    candidates = [
      { sourceId: 'A', nodeNum: 111, publicKey: null, lastHeardMs: clock },
      { sourceId: 'B', nodeNum: 111, publicKey: null, lastHeardMs: clock },
    ];

    // Baseline both calm.
    setHistory('A', 111, [{ timestamp: clock - 2 * HOUR, value: 100 }, { timestamp: clock, value: 99 }]);
    setHistory('B', 111, [{ timestamp: clock - 2 * HOUR, value: 100 }, { timestamp: clock, value: 99 }]);
    await engine.runBatteryTrendCheck();

    // Only source A's battery declines; B stays flat.
    setHistory('A', 111, [{ timestamp: clock - 3 * HOUR, value: 100 }, { timestamp: clock, value: 72 }]);
    setHistory('B', 111, [{ timestamp: clock - 3 * HOUR, value: 100 }, { timestamp: clock, value: 99 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.sourceId).toBe('A');
  });

  // ── MeshCore parity (#4558 follow-up) ─────────────────────────────────────────

  it('fires for a MeshCore node on a relative VOLTS decline ≥ threshold, keyed by pubkey', async () => {
    const { calls, deps } = recorder();
    await autos.createAutomation({ name: 'mc-trend', enabled: true, config: JSON.stringify(mcTrendGraph(12, 20)) });
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'mc', nodeNum: null, publicKey: 'ABCDEF0123', lastHeardMs: clock }];

    // Baseline: volts essentially flat → relative drop ~0.5% < 20% → no fire.
    setMcHistory('mc', 'ABCDEF0123', [{ timestamp: clock - 2 * HOUR, value: 4.0 }, { timestamp: clock, value: 3.98 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(0);

    // Volts fall 4.0 → 3.0: relative drop = (1.0 / 4.0) * 100 = 25% ≥ 20% → fires once.
    setMcHistory('mc', 'ABCDEF0123', [
      { timestamp: clock - 3 * HOUR, value: 4.0 },
      { timestamp: clock - 1 * HOUR, value: 3.5 },
      { timestamp: clock, value: 3.0 },
    ]);
    expect(await engine.runBatteryTrendCheck()).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
    // nodeNum interpolates empty (null); the pubkey carries the identity; drop is the relative %.
    expect(calls[0].args.body).toBe('node= key=ABCDEF0123 drop=25 start=4 latest=3');
    expect(calls[0].args.sourceId).toBe('mc');

    // Still declining next tick → no re-fire.
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('does NOT fire for a MeshCore node whose volts are stable or rising', async () => {
    const { calls, deps } = recorder();
    await autos.createAutomation({ name: 'mc-trend', enabled: true, config: JSON.stringify(mcTrendGraph(12, 20)) });
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'mc', nodeNum: null, publicKey: 'ABCDEF0123', lastHeardMs: clock }];

    // Flat.
    setMcHistory('mc', 'ABCDEF0123', [{ timestamp: clock - 4 * HOUR, value: 3.8 }, { timestamp: clock, value: 3.8 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    // Rising (charging): latest > start ⇒ negative drop.
    setMcHistory('mc', 'ABCDEF0123', [{ timestamp: clock - 4 * HOUR, value: 3.2 }, { timestamp: clock, value: 4.1 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('is restart-safe for MeshCore: an already-declining node only baselines on first sight', async () => {
    const { calls, deps } = recorder();
    await autos.createAutomation({ name: 'mc-trend', enabled: true, config: JSON.stringify(mcTrendGraph(12, 20)) });
    // Fresh engine == a process restart: batteryTrendState starts empty.
    const engine = engineWith(deps);
    await engine.load();
    candidates = [{ sourceId: 'mc', nodeNum: null, publicKey: 'ABCDEF0123', lastHeardMs: clock }];

    // Node is ALREADY deep into a steep volts decline when the engine starts.
    setMcHistory('mc', 'ABCDEF0123', [{ timestamp: clock - 5 * HOUR, value: 4.1 }, { timestamp: clock, value: 3.0 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(0); // first sighting → baseline, no fire
    expect(await engine.runBatteryTrendCheck()).toBe(0); // still declining, still no fire
    expect(calls).toHaveLength(0);
  });

  it('scopes MeshCore state per source: the same pubkey on two sources is tracked separately', async () => {
    const { calls, deps } = recorder();
    await autos.createAutomation({ name: 'mc-trend', enabled: true, config: JSON.stringify(mcTrendGraph(12, 20)) });
    const engine = engineWith(deps);
    await engine.load();
    candidates = [
      { sourceId: 'A', nodeNum: null, publicKey: 'KEY', lastHeardMs: clock },
      { sourceId: 'B', nodeNum: null, publicKey: 'KEY', lastHeardMs: clock },
    ];

    // Baseline both calm.
    setMcHistory('A', 'KEY', [{ timestamp: clock - 2 * HOUR, value: 4.0 }, { timestamp: clock, value: 3.98 }]);
    setMcHistory('B', 'KEY', [{ timestamp: clock - 2 * HOUR, value: 4.0 }, { timestamp: clock, value: 3.98 }]);
    await engine.runBatteryTrendCheck();

    // Only source A declines; B stays flat.
    setMcHistory('A', 'KEY', [{ timestamp: clock - 3 * HOUR, value: 4.0 }, { timestamp: clock, value: 3.0 }]);
    setMcHistory('B', 'KEY', [{ timestamp: clock - 3 * HOUR, value: 4.0 }, { timestamp: clock, value: 3.98 }]);
    expect(await engine.runBatteryTrendCheck()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.sourceId).toBe('A');
  });

  it('skips MeshCore nodes when no MeshCore samples provider is wired', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(12, 20));
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps,
      // has Meshtastic samples + enumeration but NO getMeshCoreBatteryTrendSamples
      data: {
        getNode: async () => null, getTelemetry: async () => null,
        listNodesForStaleCheck: async () => candidates,
        getBatteryTrendSamples: async () => [],
      },
      now: () => clock,
    });
    await engine.load();
    candidates = [{ sourceId: 'mc', nodeNum: null, publicKey: 'ABCDEF', lastHeardMs: clock }];
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('is a no-op when the provider cannot supply battery samples', async () => {
    const { calls, deps } = recorder();
    await createEnabled('trend', trendGraph(12, 20));
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps,
      // has listNodesForStaleCheck but NO getBatteryTrendSamples
      data: { getNode: async () => null, getTelemetry: async () => null, listNodesForStaleCheck: async () => candidates },
      now: () => clock,
    });
    await engine.load();
    candidates = [{ sourceId: 'default', nodeNum: 111, publicKey: null, lastHeardMs: clock }];
    expect(await engine.runBatteryTrendCheck()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
