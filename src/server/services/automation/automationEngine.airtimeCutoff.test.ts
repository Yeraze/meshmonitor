/**
 * The engine side of the airtime cutoff: a run whose every send was held back
 * gives back its cooldown and rate-limit stamp (in memory and on disk), a run
 * that did anything else keeps it, all-skipped runs write at most one run-log
 * row per rule per 10 minutes, and a manual "Run now" sends anyway and says so.
 * Also: the Test panel's dry run reports the skip with the rendered text.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { AutomationFireStateRepository } from '../../../db/repositories/automationFireState.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import { simulateAutomation } from './automationSimulator.js';
import type { ActionDeps } from './actionExecutor.js';
import type { NodeDataProvider } from './engineContext.js';
import type { DbMessage } from '../../../services/database.js';
import type { AutomationGraph, AutomationNode } from '../../../types/automation.js';
import { createTestDb, type TestDb } from '../../test-helpers/testDb.js';

const NO_CRON = { schedule: () => ({ stop: () => {} }), validate: () => true };

function message(from: number, packetId = 42): DbMessage {
  return {
    id: `mt_${from}_${packetId}`,
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
  } as DbMessage;
}

const SEND: AutomationNode = { id: 's', type: 'action.sendMessage', params: { text: 'pong', sourceIds: ['mt'] } };
const NOTIFY: AutomationNode = { id: 'n', type: 'action.notify', params: { body: 'heard ping' } };
const NOTHING: AutomationNode = { id: 'z', type: 'action.nothing', params: {} };

function graph(trigger: Record<string, unknown>, actions: AutomationNode[]): AutomationGraph {
  const nodes: AutomationNode[] = [{ id: 't', type: 'trigger.message', params: { textContains: 'ping', ...trigger } }, ...actions];
  const edges = actions.map((a, i) => ({ from: i === 0 ? 't' : actions[i - 1].id, to: a.id }));
  return { version: 1, nodes, edges };
}

describe('Automation Engine airtime cutoff — refund, run-log throttle, Run now', () => {
  let t: TestDb;
  let autos: AutomationsRepository;
  let fireRepo: AutomationFireStateRepository;
  let resolver: VariableResolver;
  let clock: number;
  let busy: boolean;
  let sends: unknown[];
  let notifies: number;
  const engines: AutomationEngineService[] = [];

  const deps = {
    sendMessage: async (a: unknown) => { sends.push(a); return { sent: true }; },
    notify: async () => { notifies++; return 1; },
  } as unknown as ActionDeps;

  const data: NodeDataProvider = {
    getNode: async () => null,
    getTelemetry: async () => null,
    getSourceProtocol: async () => 'meshtastic',
    getAirtimeGate: async () => ({ gated: busy, channelUtilization: busy ? 45 : 10, threshold: 30, measuredFrom: 'local' }),
  };

  beforeEach(() => {
    t = createTestDb();
    autos = new AutomationsRepository(t.db, 'sqlite');
    fireRepo = new AutomationFireStateRepository(t.db, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(t.db, 'sqlite'));
    clock = 10_000_000;
    busy = true;
    sends = [];
    notifies = 0;
  });
  afterEach(() => {
    for (const e of engines.splice(0)) e.stop();
    t.close();
  });

  async function boot() {
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps, data,
      now: () => clock, cron: NO_CRON, fireStateRepo: fireRepo,
    });
    engines.push(engine);
    await engine.load();
    return engine;
  }

  const create = (trigger: Record<string, unknown>, actions: AutomationNode[]) =>
    autos.createAutomation({ name: 'pong', enabled: true, config: JSON.stringify(graph(trigger, actions)) });

  it('an all-skipped run gives back its cooldown, in memory and on disk', async () => {
    const a = await create({ cooldownSeconds: 600 }, [SEND]);
    const engine = await boot();

    expect(await engine.onMessage(message(111), 'mt')).toBe(1);
    clock += 1000;
    // Not suppressed by the cooldown: the first run sent nothing.
    expect(await engine.onMessage(message(111, 43), 'mt')).toBe(1);
    expect(sends).toHaveLength(0);
    await engine.flushFireState();
    expect(await fireRepo.listAll()).toEqual([]);

    // The channel clears: the next event sends and stamps the cooldown.
    busy = false;
    clock += 1000;
    expect(await engine.onMessage(message(111, 44), 'mt')).toBe(1);
    expect(sends).toHaveLength(1);
    clock += 1000;
    expect(await engine.onMessage(message(111, 45), 'mt')).toBe(0);
    await engine.flushFireState();
    expect((await fireRepo.listByAutomation(a.id)).map((r) => r.kind)).toEqual(['cooldown']);
  });

  it('a refund restores the earlier stamp rather than deleting it', async () => {
    const a = await create({ cooldownSeconds: 600 }, [SEND]);
    const engine = await boot();
    busy = false;
    const firstFire = clock;
    expect(await engine.onMessage(message(111), 'mt')).toBe(1);
    clock += 700_000; // past the cooldown
    busy = true;
    expect(await engine.onMessage(message(111, 43), 'mt')).toBe(1);
    await engine.flushFireState();
    const rows = await fireRepo.listByAutomation(a.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].firedAt)).toBe(firstFire);
  });

  it('an all-skipped run gives back its rate-limit slot', async () => {
    await create({ rateLimit: { maxActions: 1, windowSeconds: 3600 } }, [SEND]);
    const engine = await boot();
    for (let i = 0; i < 3; i++) {
      clock += 1000;
      expect(await engine.onMessage(message(111, 50 + i), 'mt')).toBe(1);
    }
    busy = false;
    clock += 1000;
    expect(await engine.onMessage(message(111, 60), 'mt')).toBe(1);
    expect(sends).toHaveLength(1);
    clock += 1000;
    expect(await engine.onMessage(message(111, 61), 'mt')).toBe(0);
    await engine.flushFireState();
    const rate = (await fireRepo.listAll()).filter((r) => r.kind === 'rate');
    expect(rate).toHaveLength(1);
  });

  it('a mixed run (notify ran, send skipped) keeps its stamp and stays completed', async () => {
    const a = await create({ cooldownSeconds: 600 }, [NOTIFY, SEND]);
    const engine = await boot();
    expect(await engine.onMessage(message(111), 'mt')).toBe(1);
    expect(notifies).toBe(1);
    expect(sends).toHaveLength(0);
    clock += 1000;
    expect(await engine.onMessage(message(111, 43), 'mt')).toBe(0);
    const runs = await autos.listRuns(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    const log = JSON.parse(String(runs[0].log)) as Array<{ type: string; detail?: Record<string, unknown> }>;
    const send = log.find((s) => s.type === 'action.sendMessage');
    expect(send?.detail).toMatchObject({ skipped: true, airtimeCutoff: true, sourceId: 'mt', channelUtilization: 45, threshold: 30 });
    expect(JSON.stringify(log)).not.toContain('pong');
  });

  it('action.nothing is neutral: nothing + a skipped send still refunds', async () => {
    await create({ cooldownSeconds: 600 }, [NOTHING, SEND]);
    const engine = await boot();
    expect(await engine.onMessage(message(111), 'mt')).toBe(1);
    clock += 1000;
    expect(await engine.onMessage(message(111, 43), 'mt')).toBe(1);
  });

  it('all-skipped runs write at most one run-log row per rule per 10 minutes; a real send resets that', async () => {
    const a = await create({}, [SEND]);
    const engine = await boot();
    for (let i = 0; i < 5; i++) {
      clock += 30_000;
      await engine.onMessage(message(111, 70 + i), 'mt');
    }
    expect(await autos.listRuns(a.id)).toHaveLength(1);

    clock += 10 * 60_000;
    await engine.onMessage(message(111, 80), 'mt');
    expect(await autos.listRuns(a.id)).toHaveLength(2);

    busy = false;
    clock += 1000;
    await engine.onMessage(message(111, 81), 'mt');
    expect(await autos.listRuns(a.id)).toHaveLength(3);
    busy = true;
    clock += 1000;
    await engine.onMessage(message(111, 82), 'mt');
    expect(await autos.listRuns(a.id)).toHaveLength(4);
  });

  it('a run where no action ran does not re-open the run-log window', async () => {
    // Only "ping" reaches the send; "skip" stops at a false condition.
    const g: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'c', type: 'condition.string', params: { field: 'text', op: 'contains', value: 'ping' } },
        SEND,
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 's', port: 'true' }],
    };
    const a = await autos.createAutomation({ name: 'pong', enabled: true, config: JSON.stringify(g) });
    const engine = await boot();
    await engine.onMessage(message(111, 90), 'mt');
    const before = (await autos.listRuns(a.id)).length;
    clock += 30_000;
    await engine.onMessage({ ...message(111, 91), text: 'skip' } as DbMessage, 'mt');
    const afterMiss = (await autos.listRuns(a.id)).length;
    clock += 30_000;
    await engine.onMessage(message(111, 92), 'mt');
    // The skipped send after the miss is still inside the 10-minute window.
    expect((await autos.listRuns(a.id)).length).toBe(afterMiss);
    expect(before).toBe(1);
  });

  it('Run now sends anyway, is always logged, and says it ignored the cutoff', async () => {
    const a = await create({}, [SEND]);
    const engine = await boot();
    for (let i = 0; i < 2; i++) {
      const r = await engine.runNow(a.id);
      expect(r.ran).toBe(true);
    }
    expect(sends).toHaveLength(2);
    const runs = await autos.listRuns(a.id);
    expect(runs).toHaveLength(2);
    const log = JSON.parse(String(runs[0].log)) as Array<{ outcome: string; detail?: Record<string, unknown> }>;
    expect(log.find((s) => s.outcome === 'airtime:bypassed')?.detail).toMatchObject({ sourceId: 'mt', channelUtilization: 45, threshold: 30 });
  });
});

describe('Automation Engine airtime cutoff — Test panel dry run', () => {
  let t: TestDb;
  beforeEach(() => { t = createTestDb(); });
  afterEach(() => t.close());

  it('reports the skip with the figures and still shows the rendered text', async () => {
    const r = await simulateAutomation({
      graph: graph({}, [{ id: 's', type: 'action.sendMessage', params: { text: 'pong {{ trigger.text }}', sourceIds: ['mt'] } }]),
      varsRepo: new AutomationVariablesRepository(t.db, 'sqlite'),
      event: { kind: 'message', text: 'ping', from: 111, sourceId: 'mt' },
      liveData: {
        getNode: async () => null,
        getTelemetry: async () => null,
        getSourceProtocol: async () => 'meshtastic',
        getAirtimeGate: async () => ({ gated: true, channelUtilization: 45, threshold: 30 }),
      },
    });
    expect(r.status).toBe('completed');
    expect(r.actions[0].resolvedParams).toMatchObject({ skipped: true, airtimeCutoff: true, channelUtilization: 45, threshold: 30, text: 'pong ping' });
    const step = r.steps.find((s) => s.type === 'action.sendMessage') as { detail?: Record<string, unknown> } | undefined;
    expect(step?.detail).toMatchObject({ airtimeCutoff: true });
    expect(step?.detail?.text).toBeUndefined();
  });
});
