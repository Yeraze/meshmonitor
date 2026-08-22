/**
 * trigger.nodeRebooted — Device Health Phase B (#4558).
 *
 * A reboot is an uptime RESET: the new `uptimeSeconds` reading is lower than the
 * node's prior stored reading. Detection lives at the telemetry-save seam, which
 * reads the prior value from the DB (persistent, so restart-safe) and compares
 * via the pure {@link isUptimeReboot} helper; the engine's {@link onNodeRebooted}
 * is a plain event entry point that fires the automation.
 *
 * These tests cover both halves:
 *  - the detection decision (fires on a real drop; not on a rise; not on the
 *    first reading; ignores jitter within slack; restart-safe; per-source),
 *    driven through the REAL telemetry repository + DB read the seam uses;
 *  - the engine firing + token surface + graph validation.
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
import { isUptimeReboot, REBOOT_UPTIME_SLACK_SECONDS } from '../../utils/rebootDetection.js';
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

/** nodeRebooted rule that notifies, tokenised so we can read the context back. */
function rebootGraph(): AutomationGraph {
  return {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.nodeRebooted', params: {} },
      { id: 'n', type: 'action.notify', params: { title: 'reboot', body: 'node={{ trigger.nodeNum }} prev={{ trigger.previousUptimeSeconds }} now={{ trigger.uptimeSeconds }} src={{ trigger.sourceId }}' } },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

// ─── detection decision (pure helper) ───────────────────────────────────────

describe('isUptimeReboot (#4558 Phase B)', () => {
  it('fires when uptime drops well below the prior reading', () => {
    expect(isUptimeReboot(86_400, 30)).toBe(true);       // a day of uptime → 30 s
    expect(isUptimeReboot(3_600, 5)).toBe(true);
  });

  it('does NOT fire when uptime increases normally', () => {
    expect(isUptimeReboot(3_600, 3_660)).toBe(false);    // +60 s, a normal interval
    expect(isUptimeReboot(3_600, 3_600)).toBe(false);    // unchanged
  });

  it('does NOT fire on the first-ever reading (no prior)', () => {
    expect(isUptimeReboot(null, 3_600)).toBe(false);
    expect(isUptimeReboot(undefined, 42)).toBe(false);
  });

  it('ignores a tiny decrease within the jitter slack', () => {
    // Prior 1000, new 995 — a 5 s dip (rounding / slight reorder), < slack.
    expect(isUptimeReboot(1_000, 1_000 - (REBOOT_UPTIME_SLACK_SECONDS - 1))).toBe(false);
    // A decrease exactly at the slack boundary is not yet a reboot (strict <).
    expect(isUptimeReboot(1_000, 1_000 - REBOOT_UPTIME_SLACK_SECONDS)).toBe(false);
    // One second past the slack IS a reboot.
    expect(isUptimeReboot(1_000, 1_000 - REBOOT_UPTIME_SLACK_SECONDS - 1)).toBe(true);
  });

  it('ignores non-finite readings', () => {
    expect(isUptimeReboot(1_000, NaN)).toBe(false);
    expect(isUptimeReboot(NaN, 10)).toBe(false);
  });
});

// ─── detection through the real DB read the seam uses ────────────────────────

describe('reboot detection via getLatestTelemetryForType (#4558 Phase B)', () => {
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

  const insertUptime = (nodeId: string, nodeNum: number, value: number, ts: number, sourceId: string) =>
    telem.insertTelemetry(
      { nodeId, nodeNum, telemetryType: 'uptimeSeconds', timestamp: ts, value, unit: 's', createdAt: ts },
      sourceId,
    );

  /** Replays the seam's decision: read prior for the source, compare, no insert. */
  const wouldReboot = async (nodeId: string, newValue: number, sourceId: string) => {
    const prior = await telem.getLatestTelemetryForType(nodeId, 'uptimeSeconds', sourceId);
    return isUptimeReboot(prior ? Number(prior.value) : null, newValue);
  };

  it('first reading has no prior, so nothing fires', async () => {
    expect(await wouldReboot('!node', 3_600, 'default')).toBe(false);
  });

  it('a rising reading after a stored one does not fire; a reset does', async () => {
    await insertUptime('!node', 111, 3_600, 1_000, 'default');
    expect(await wouldReboot('!node', 7_200, 'default')).toBe(false); // still climbing
    expect(await wouldReboot('!node', 12, 'default')).toBe(true);     // reset
  });

  it('is restart-safe: the prior comes from the DB, not memory', async () => {
    // Simulate a MeshMonitor restart by using a brand-new repository instance
    // (no carried-over in-memory baseline) against the same DB.
    await insertUptime('!node', 111, 10_000, 1_000, 'default');
    const freshTelem = new TelemetryRepository(drizzleDb, 'sqlite');
    const priorFromDb = await freshTelem.getLatestTelemetryForType('!node', 'uptimeSeconds', 'default');
    // A continuing-to-climb reading after the "restart" does NOT spuriously fire…
    expect(isUptimeReboot(Number(priorFromDb!.value), 10_060)).toBe(false);
    // …and a genuine reset still fires — the durable row is the only baseline.
    expect(isUptimeReboot(Number(priorFromDb!.value), 5)).toBe(true);
  });

  it('scopes the prior per source: a reboot on A ignores B’s uptime', async () => {
    // Same nodeId on two sources; A is up 1 h, B is up 10 h.
    await insertUptime('!node', 111, 3_600, 1_000, 'A');
    await insertUptime('!node', 111, 36_000, 1_000, 'B');
    // A new reading of 30 s on A is a reboot vs A's own 3 600 s prior…
    expect(await wouldReboot('!node', 30, 'A')).toBe(true);
    // …and the SAME 30 s on B is also a reboot vs B's own 36 000 s prior —
    // each source reads its own baseline, never the other's.
    expect(await wouldReboot('!node', 30, 'B')).toBe(true);
    // A reading of 3 610 s (a normal climb for A) must NOT read B's 36 000 s and
    // look like a reboot: scoped to A, it is a rise.
    expect(await wouldReboot('!node', 3_610, 'A')).toBe(false);
  });
});

// ─── engine firing + tokens + validation ─────────────────────────────────────

describe('trigger.nodeRebooted engine (#4558 Phase B)', () => {
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

  it('validateAutomationGraph accepts a nodeRebooted rule (no required params)', () => {
    expect(validateAutomationGraph(rebootGraph()).valid).toBe(true);
  });

  it('fires once on a reboot event, exposing the uptime tokens', async () => {
    const { calls, deps } = recorder();
    await createEnabled('reboot', rebootGraph());
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onNodeRebooted(111, 86_400, 12, 'default')).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['notify']);
    expect(calls[0].args.body).toBe('node=111 prev=86400 now=12 src=default');
  });

  it('does not fire when no nodeRebooted automation is loaded', async () => {
    const { calls, deps } = recorder();
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onNodeRebooted(111, 86_400, 12, 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('carries the event source id into the context', async () => {
    const { calls, deps } = recorder();
    await createEnabled('reboot', rebootGraph());
    const engine = engineWith(deps);
    await engine.load();

    await engine.onNodeRebooted(222, 5_000, 3, 'sourceZ');
    expect(calls[0].args.body).toBe('node=222 prev=5000 now=3 src=sourceZ');
  });
});
