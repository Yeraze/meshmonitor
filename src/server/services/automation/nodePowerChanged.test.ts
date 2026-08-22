/**
 * trigger.nodePowerChanged — Device Health Phase C (#4558).
 *
 * A power-source change is a batteryLevel crossing the firmware's "powered"
 * convention: `battery_level > 100` means external/USB power, 0–100 means on
 * battery at that percent. Detection lives at the telemetry-save seam, which
 * reads the prior batteryLevel from the DB (persistent, so restart-safe) and
 * compares via the pure {@link detectPowerTransition} helper; the engine's
 * {@link AutomationEngineService.onNodePowerChanged} is the event entry point
 * that fires the automation, honoring the rule's `direction` param.
 *
 * These tests cover both halves:
 *  - the detection decision (powered threshold at 100/101; lost/restored/no
 *    transition; null handling; first reading; restart-safe; per-source),
 *    driven through the REAL telemetry repository + DB read the seam uses;
 *  - the engine firing + direction filter + token surface + graph validation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { TelemetryRepository } from '../../../db/repositories/telemetry.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { NodeDataProvider } from './engineContext.js';
import type { AutomationGraph } from '../../../types/automation.js';
import { validateAutomationGraph } from '../../../types/automation.js';
import { isPowered, isPoweredMv, detectPowerTransition, POWERED_BATTERY_LEVEL_THRESHOLD, MESHCORE_POWERED_MV_THRESHOLD } from '../../utils/poweredState.js';
import { buildNodePowerChangedContext } from './triggerContext.js';
import { detectMeshCorePowerChange } from '../meshcoreDeviceHealth.js';
import { dataEventEmitter, type DataEvent } from '../dataEventEmitter.js';
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

/** nodePowerChanged rule that notifies, tokenised so we can read the context back. */
function powerGraph(direction?: 'lost' | 'restored' | 'either'): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.nodePowerChanged', params: direction ? { direction } : {} },
      { id: 'n', type: 'action.notify', params: { title: 'power', body: 'node={{ trigger.nodeNum }} dir={{ trigger.direction }} prev={{ trigger.previousPowered }} now={{ trigger.powered }} batt={{ trigger.batteryLevel }} src={{ trigger.sourceId }}' } },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

// ─── detection decision (pure helper) ────────────────────────────────────────

describe('isPowered / detectPowerTransition (#4558 Phase C)', () => {
  it('treats battery_level > 100 as powered, 0–100 as on battery', () => {
    expect(POWERED_BATTERY_LEVEL_THRESHOLD).toBe(100);
    expect(isPowered(101)).toBe(true);        // firmware "powered" sentinel
    expect(isPowered(150)).toBe(true);
    expect(isPowered(100)).toBe(false);       // exactly full battery, not powered
    expect(isPowered(0)).toBe(false);
    expect(isPowered(50)).toBe(false);
  });

  it('treats a missing / non-finite reading as not powered', () => {
    expect(isPowered(null)).toBe(false);
    expect(isPowered(undefined)).toBe(false);
    expect(isPowered(NaN)).toBe(false);
  });

  it('classifies a restored transition (battery → powered)', () => {
    expect(detectPowerTransition(80, 101)).toBe('restored');
    expect(detectPowerTransition(100, 101)).toBe('restored'); // boundary: 100 → 101
  });

  it('classifies a lost transition (powered → battery)', () => {
    expect(detectPowerTransition(101, 80)).toBe('lost');
    expect(detectPowerTransition(101, 100)).toBe('lost');     // boundary: 101 → 100
  });

  it('returns null when the powered-state does not change', () => {
    expect(detectPowerTransition(80, 90)).toBeNull();     // battery → battery
    expect(detectPowerTransition(101, 105)).toBeNull();   // powered → powered
    expect(detectPowerTransition(50, 50)).toBeNull();     // unchanged
  });

  it('returns null on the first-ever reading (no prior)', () => {
    expect(detectPowerTransition(null, 101)).toBeNull();
    expect(detectPowerTransition(undefined, 50)).toBeNull();
  });

  it('returns null when the new reading is non-finite', () => {
    expect(detectPowerTransition(101, NaN)).toBeNull();
    expect(detectPowerTransition(80, null)).toBeNull();
  });
});

// ─── MeshCore powered-voltage heuristic (#4558 MeshCore parity) ───────────────

describe('isPoweredMv (#4558 MeshCore parity)', () => {
  it('treats >= 4200 mV as powered (the Li-ion full/charging voltage)', () => {
    expect(MESHCORE_POWERED_MV_THRESHOLD).toBe(4200);
    expect(isPoweredMv(4200)).toBe(true);   // exactly at the threshold
    expect(isPoweredMv(4201)).toBe(true);
    expect(isPoweredMv(4500)).toBe(true);
  });

  it('treats < 4200 mV as on battery', () => {
    expect(isPoweredMv(4199)).toBe(false);  // just under the threshold
    expect(isPoweredMv(3700)).toBe(false);  // nominal Li-ion
    expect(isPoweredMv(0)).toBe(false);
  });

  it('treats a missing / non-finite reading as not powered', () => {
    expect(isPoweredMv(null)).toBe(false);
    expect(isPoweredMv(undefined)).toBe(false);
    expect(isPoweredMv(NaN)).toBe(false);
  });
});

// ─── detection through the real DB read the seam uses ────────────────────────

describe('power-change detection via getLatestTelemetryForType (#4558 Phase C)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let telem: TelemetryRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    telem = new TelemetryRepository(drizzleDb, 'sqlite');
  });
  afterEach(() => { db.close(); });

  const insertBattery = (nodeId: string, nodeNum: number, value: number, ts: number, sourceId: string) =>
    telem.insertTelemetry(
      { nodeId, nodeNum, telemetryType: 'batteryLevel', timestamp: ts, value, unit: '%', createdAt: ts },
      sourceId,
    );

  /** Replays the seam's decision: read prior for the source, compare, no insert. */
  const transitionFor = async (nodeId: string, newValue: number, sourceId: string) => {
    const prior = await telem.getLatestTelemetryForType(nodeId, 'batteryLevel', sourceId);
    return detectPowerTransition(prior ? Number(prior.value) : null, newValue);
  };

  it('first reading has no prior, so nothing fires', async () => {
    expect(await transitionFor('!node', 101, 'default')).toBeNull();
  });

  it('on-battery → powered is a "restored" transition', async () => {
    await insertBattery('!node', 111, 80, 1_000, 'default');
    expect(await transitionFor('!node', 101, 'default')).toBe('restored');
  });

  it('powered → on-battery is a "lost" transition', async () => {
    await insertBattery('!node', 111, 101, 1_000, 'default');
    expect(await transitionFor('!node', 80, 'default')).toBe('lost');
  });

  it('does not fire when the powered-state is unchanged', async () => {
    await insertBattery('!node', 111, 80, 1_000, 'default');
    expect(await transitionFor('!node', 60, 'default')).toBeNull();   // battery → battery
    await insertBattery('!node', 111, 101, 2_000, 'default');
    expect(await transitionFor('!node', 105, 'default')).toBeNull();  // powered → powered
  });

  it('is restart-safe: the prior comes from the DB, not memory', async () => {
    // Simulate a MeshMonitor restart by using a brand-new repository instance
    // (no carried-over in-memory baseline) against the same DB.
    await insertBattery('!node', 111, 101, 1_000, 'default');
    const freshTelem = new TelemetryRepository(drizzleDb, 'sqlite');
    const priorFromDb = await freshTelem.getLatestTelemetryForType('!node', 'batteryLevel', 'default');
    // A still-powered reading after the "restart" does NOT spuriously fire…
    expect(detectPowerTransition(Number(priorFromDb!.value), 105)).toBeNull();
    // …and a genuine drop to battery still fires — the durable row is the only baseline.
    expect(detectPowerTransition(Number(priorFromDb!.value), 80)).toBe('lost');
  });

  it('scopes the prior per source: a transition on A ignores B’s battery', async () => {
    // Same nodeId on two sources; on A it is powered, on B it is on battery.
    await insertBattery('!node', 111, 101, 1_000, 'A');
    await insertBattery('!node', 111, 80, 1_000, 'B');
    // A reading of 80 on A is a "lost" vs A's own powered prior…
    expect(await transitionFor('!node', 80, 'A')).toBe('lost');
    // …and the SAME 80 on B is unchanged vs B's own on-battery prior — each
    // source reads its own baseline, never the other's.
    expect(await transitionFor('!node', 80, 'B')).toBeNull();
    // A powered reading on B is "restored" scoped to B, not read against A.
    expect(await transitionFor('!node', 101, 'B')).toBe('restored');
  });
});

// ─── MeshCore seam: detectMeshCorePowerChange → node:powerChanged (parity) ────

describe('detectMeshCorePowerChange seam (#4558 MeshCore parity)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let telem: TelemetryRepository;
  let events: DataEvent[];
  let listener: (e: DataEvent) => void;

  // 4300 mV ≥ 4200 threshold ⇒ "powered"; 3700 mV ⇒ on battery.
  const POWERED_MV = 4300;
  const BATTERY_MV = 3700;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    telem = new TelemetryRepository(drizzleDb, 'sqlite');
    events = [];
    listener = (e) => { if (e.type === 'node:powerChanged') events.push(e); };
    dataEventEmitter.on('data', listener);
  });
  afterEach(() => { dataEventEmitter.off('data', listener); db.close(); });

  const insertBattery = (pk: string, telemetryType: string, value: number, ts: number, unit: string, sourceId: string) =>
    telem.insertTelemetry(
      { nodeId: pk, nodeNum: 1, telemetryType, timestamp: ts, value, unit, createdAt: ts },
      sourceId,
    );

  // Local-poller path: prior stored as mc_battery_mv (mV → scale 1).
  const insertMv = (pk: string, value: number, ts: number, sourceId: string) =>
    insertBattery(pk, 'mc_battery_mv', value, ts, 'mV', sourceId);
  const detectMv = (pk: string, newMv: number, sourceId: string) =>
    detectMeshCorePowerChange(telem, pk, 'mc_battery_mv', 1, newMv, sourceId);

  it('emits node:powerChanged (nodeNum null, pubkey) on powered → battery as "lost"', async () => {
    await insertMv('PUBKEY', POWERED_MV, 1_000, 'mc');
    await detectMv('PUBKEY', BATTERY_MV, 'mc');
    expect(events).toHaveLength(1);
    const data = events[0].data as { nodeNum: number | null; publicKey?: string; previousPowered: boolean; powered: boolean; batteryLevel: number };
    expect(data.nodeNum).toBeNull();
    expect(data.publicKey).toBe('PUBKEY');
    expect(data.previousPowered).toBe(true);
    expect(data.powered).toBe(false);
    expect(data.batteryLevel).toBe(BATTERY_MV);
    expect(events[0].sourceId).toBe('mc');
  });

  it('emits "restored" on battery → powered', async () => {
    await insertMv('PUBKEY', BATTERY_MV, 1_000, 'mc');
    await detectMv('PUBKEY', POWERED_MV, 'mc');
    expect(events).toHaveLength(1);
    const data = events[0].data as { previousPowered: boolean; powered: boolean };
    expect(data.previousPowered).toBe(false);
    expect(data.powered).toBe(true);
  });

  it('does not emit when the powered-state is unchanged', async () => {
    // battery → battery
    await insertMv('A', BATTERY_MV, 1_000, 'mc');
    await detectMv('A', 3_600, 'mc');
    // powered → powered
    await insertMv('B', POWERED_MV, 1_000, 'mc');
    await detectMv('B', 4_400, 'mc');
    expect(events).toHaveLength(0);
  });

  it('does not emit on the first-ever reading (no prior)', async () => {
    await detectMv('PUBKEY', POWERED_MV, 'mc');
    expect(events).toHaveLength(0);
  });

  it('is restart-safe: the prior comes from the DB, not memory', async () => {
    await insertMv('PUBKEY', POWERED_MV, 1_000, 'mc');
    // A brand-new repository instance stands in for a MeshMonitor restart — the
    // durable row is the only baseline.
    const freshTelem = new TelemetryRepository(drizzleDb, 'sqlite');
    await detectMeshCorePowerChange(freshTelem, 'PUBKEY', 'mc_battery_mv', 1, BATTERY_MV, 'mc');
    expect(events).toHaveLength(1);
    expect((events[0].data as { powered: boolean }).powered).toBe(false);
  });

  it('reads the prior per source: a fresh source baselines rather than firing', async () => {
    await insertMv('PUBKEY', POWERED_MV, 1_000, 'A');
    // Source B has no prior of its own → first reading, does not fire.
    await detectMv('PUBKEY', BATTERY_MV, 'B');
    expect(events).toHaveLength(0);
    // Source A's own powered prior → a battery reading is a "lost" transition.
    await detectMv('PUBKEY', BATTERY_MV, 'A');
    expect(events).toHaveLength(1);
    expect(events[0].sourceId).toBe('A');
  });

  it('works on the remote-scheduler volts series (mc_status_battery_volts, scale 1000)', async () => {
    // The scheduler stores battery in VOLTS; the helper scales the prior ×1000.
    await insertBattery('PUBKEY', 'mc_status_battery_volts', 4.3, 1_000, 'V', 'mc');
    await detectMeshCorePowerChange(telem, 'PUBKEY', 'mc_status_battery_volts', 1000, BATTERY_MV, 'mc');
    expect(events).toHaveLength(1);
    const data = events[0].data as { publicKey?: string; previousPowered: boolean; powered: boolean };
    expect(data.publicKey).toBe('PUBKEY');
    expect(data.previousPowered).toBe(true);
    expect(data.powered).toBe(false);
  });

  it('does not emit when newBatteryMv is null / non-finite', async () => {
    await insertMv('PUBKEY', POWERED_MV, 1_000, 'mc');
    await detectMeshCorePowerChange(telem, 'PUBKEY', 'mc_battery_mv', 1, null, 'mc');
    await detectMeshCorePowerChange(telem, 'PUBKEY', 'mc_battery_mv', 1, NaN, 'mc');
    expect(events).toHaveLength(0);
  });
});

// ─── engine firing + direction filter + tokens + validation ──────────────────

describe('trigger.nodePowerChanged engine (#4558 Phase C)', () => {
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

  it('validateAutomationGraph accepts a nodePowerChanged rule (no required params)', () => {
    expect(validateAutomationGraph(powerGraph()).valid).toBe(true);
    expect(validateAutomationGraph(powerGraph('lost')).valid).toBe(true);
    expect(validateAutomationGraph(powerGraph('restored')).valid).toBe(true);
    expect(validateAutomationGraph(powerGraph('either')).valid).toBe(true);
  });

  it('rejects an unknown direction value', () => {
    const bad = powerGraph();
    (bad.nodes[0].params as any).direction = 'sideways';
    const result = validateAutomationGraph(bad);
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.includes('direction'))).toBe(true);
  });

  it('fires on a matching transition, exposing the power tokens', async () => {
    const { calls, deps } = recorder();
    await createEnabled('power', powerGraph('either'));
    const engine = engineWith(deps);
    await engine.load();

    // previousPowered=true, powered=false → "lost"
    expect(await engine.onNodePowerChanged(111, null, true, false, 80, 'default')).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
    expect(calls[0].args.body).toBe('node=111 dir=lost prev=true now=false batt=80 src=default');
  });

  it('direction filter fires only on the matching transition', async () => {
    const { calls, deps } = recorder();
    await createEnabled('lost-only', powerGraph('lost'));
    const engine = engineWith(deps);
    await engine.load();

    // A "restored" transition must NOT fire a lost-only rule…
    expect(await engine.onNodePowerChanged(111, null, false, true, 101, 'default')).toBe(0);
    expect(calls).toHaveLength(0);
    // …but a "lost" transition does.
    expect(await engine.onNodePowerChanged(111, null, true, false, 80, 'default')).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
    expect(calls[0].args.body).toContain('dir=lost');
  });

  it('does not fire when no nodePowerChanged automation is loaded', async () => {
    const { calls, deps } = recorder();
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onNodePowerChanged(111, null, true, false, 80, 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('carries the event source id into the context', async () => {
    const { calls, deps } = recorder();
    await createEnabled('power', powerGraph('restored'));
    const engine = engineWith(deps);
    await engine.load();

    // previousPowered=false, powered=true → "restored"
    await engine.onNodePowerChanged(222, null, false, true, 101, 'sourceZ');
    expect(calls[0].args.body).toBe('node=222 dir=restored prev=false now=true batt=101 src=sourceZ');
  });

  // ── MeshCore parity (#4558) ──────────────────────────────────────────────────

  it('fires for a MeshCore node identified by pubkey (nodeNum null)', async () => {
    const { calls, deps } = recorder();
    // A rule that reads the MeshCore identity: nodeNum is null, publicKey is set.
    await autos.createAutomation({
      name: 'mc-power', enabled: true,
      config: JSON.stringify({
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.nodePowerChanged', params: {} },
          { id: 'n', type: 'action.notify', params: { title: 'p', body: 'node={{ trigger.nodeNum }} key={{ trigger.publicKey }} dir={{ trigger.direction }} batt={{ trigger.batteryLevel }}' } },
        ],
        edges: [{ from: 't', to: 'n' }],
      }),
    });
    const engine = engineWith(deps);
    await engine.load();

    // previousPowered=true, powered=false → "lost"; batteryLevel is mV on MeshCore.
    expect(await engine.onNodePowerChanged(null, 'ABCDEF0123', true, false, 3700, 'mc')).toBe(1);
    // nodeNum interpolates empty (null); the pubkey carries the identity.
    expect(calls[0].args.body).toBe('node= key=ABCDEF0123 dir=lost batt=3700');
  });
});

// ─── context identity: pubkey vs nodeNum ─────────────────────────────────────

describe('buildNodePowerChangedContext identity (#4558 MeshCore parity)', () => {
  it('Meshtastic subject binds subjectNodeNum and leaves subjectNodeKey to derive', () => {
    const ctx = buildNodePowerChangedContext(111, null, true, false, 80, 'default', 1_000);
    expect(ctx.subjectNodeNum).toBe(111);
    // undefined ⇒ derive from subjectNodeNum (a Meshtastic node), not an explicit key.
    expect(ctx.subjectNodeKey).toBeUndefined();
    expect(ctx.fields.nodeNum).toBe(111);
    expect(ctx.fields.publicKey).toBeUndefined();
  });

  it('MeshCore subject binds subjectNodeKey to the pubkey with a null node number', () => {
    const ctx = buildNodePowerChangedContext(null, 'ABCDEF0123', true, false, 3700, 'mc', 1_000);
    expect(ctx.subjectNodeNum).toBeNull();
    expect(ctx.subjectNodeKey).toBe('ABCDEF0123');
    expect(ctx.fields.nodeNum).toBeNull();
    expect(ctx.fields.publicKey).toBe('ABCDEF0123');
    expect(ctx.fields.direction).toBe('lost');
  });
});
