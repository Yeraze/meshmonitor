/**
 * Cooldown and rate-limit state survives a restart (CLAUDE.md Mesh impact
 * checklist §3). Each "restart" is a NEW AutomationEngineService over the same
 * database, so only what reached `automation_fire_state` carries over.
 *
 * Every rule here uses action.notify through a recorder; nothing reaches a mesh.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { AutomationFireStateRepository } from '../../../db/repositories/automationFireState.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { DbMessage } from '../../../services/database.js';
import type { AutomationGraph } from '../../../types/automation.js';
import { createTestDb, type TestDb } from '../../test-helpers/testDb.js';

const NO_CRON = {
  schedule: () => ({ stop: () => {} }),
  validate: () => true,
};

function recorder() {
  const calls: string[] = [];
  const deps = {
    notify: async () => { calls.push('notify'); return 1; },
  } as unknown as ActionDeps;
  return { calls, deps };
}

function message(from: number): DbMessage {
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
  } as DbMessage;
}

const messageGraph = (params: Record<string, unknown>): AutomationGraph => ({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params: { textContains: 'ping', ...params } },
    { id: 'n', type: 'action.notify', params: { body: 'heard ping' } },
  ],
  edges: [{ from: 't', to: 'n' }],
});

describe('AutomationEngineService fire-state persistence', () => {
  let t: TestDb;
  let autos: AutomationsRepository;
  let fireRepo: AutomationFireStateRepository;
  let resolver: VariableResolver;
  let clock: number;
  const engines: AutomationEngineService[] = [];

  beforeEach(() => {
    t = createTestDb();
    autos = new AutomationsRepository(t.db, 'sqlite');
    fireRepo = new AutomationFireStateRepository(t.db, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(t.db, 'sqlite'));
    clock = 10_000_000;
  });
  afterEach(() => {
    for (const e of engines.splice(0)) e.stop();
    t.close();
  });

  /** A fresh engine over the same DB: what a process restart looks like. */
  async function boot(deps: ActionDeps, repo: AutomationFireStateRepository | null = fireRepo) {
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps,
      data: { getNode: async () => null, getTelemetry: async () => null },
      now: () => clock, cron: NO_CRON, fireStateRepo: repo,
    });
    engines.push(engine);
    await engine.load();
    return engine;
  }

  async function create(params: Record<string, unknown>, enabled = true) {
    return autos.createAutomation({ name: 'ping', enabled, config: JSON.stringify(messageGraph(params)) });
  }

  it('a cooldown survives a restart, and lapses on time', async () => {
    await create({ cooldownSeconds: 600 });
    const { calls, deps } = recorder();
    const first = await boot(deps);
    expect(await first.onMessage(message(111), 'default')).toBe(1);
    await first.flushFireState();
    first.stop();

    clock += 60_000; // 1 min later, new process
    const second = await boot(deps);
    expect(await second.onMessage(message(111), 'default')).toBe(0);

    clock += 540_000; // 10 min after the first fire
    expect(await second.onMessage(message(111), 'default')).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('a restart does not count as a fire: boot alone writes nothing and fires nothing', async () => {
    await create({ cooldownSeconds: 600 });
    const { calls, deps } = recorder();
    const engine = await boot(deps);
    await engine.flushFireState();
    expect(calls).toHaveLength(0);
    expect(await fireRepo.listAll()).toEqual([]);
    expect(await engine.onMessage(message(111), 'default')).toBe(1);
  });

  it('node-scoped cooldowns restore per node', async () => {
    await create({ cooldownSeconds: 600, cooldownScope: 'node' });
    const { deps } = recorder();
    const first = await boot(deps);
    expect(await first.onMessage(message(111), 'default')).toBe(1);
    await first.flushFireState();

    const second = await boot(deps);
    expect(await second.onMessage(message(111), 'default')).toBe(0); // same node: held
    expect(await second.onMessage(message(222), 'default')).toBe(1); // other node: free
  });

  it('disable then re-enable keeps the last fire (within one process)', async () => {
    const a = await create({ cooldownSeconds: 600 });
    const { deps } = recorder();
    const engine = await boot(deps);
    expect(await engine.onMessage(message(111), 'default')).toBe(1);

    await autos.setEnabled(a.id, false);
    await engine.load();
    expect(engine.countFor('trigger.message')).toBe(0);
    await autos.setEnabled(a.id, true);
    await engine.load();

    clock += 60_000;
    expect(await engine.onMessage(message(111), 'default')).toBe(0);
  });

  it('a disabled rule keeps its rows across a restart, then is gated once re-enabled', async () => {
    const a = await create({ cooldownSeconds: 600 });
    const { deps } = recorder();
    const first = await boot(deps);
    expect(await first.onMessage(message(111), 'default')).toBe(1);
    await first.flushFireState();
    await autos.setEnabled(a.id, false);

    clock += 60_000;
    const second = await boot(deps); // disabled: not loaded
    await second.flushFireState();
    expect(await fireRepo.listAll()).toHaveLength(1);

    await autos.setEnabled(a.id, true);
    await second.load();
    expect(await second.onMessage(message(111), 'default')).toBe(0);
  });

  it('saving the rule (same id, edited config) keeps its cooldown', async () => {
    const a = await create({ cooldownSeconds: 600 });
    const { deps } = recorder();
    const engine = await boot(deps);
    expect(await engine.onMessage(message(111), 'default')).toBe(1);

    await autos.updateAutomation(a.id, { config: JSON.stringify(messageGraph({ cooldownSeconds: 900 })) });
    await engine.load();
    clock += 700_000; // past the old 600 s, inside the new 900 s
    expect(await engine.onMessage(message(111), 'default')).toBe(0);

    // And across a restart after the save.
    await engine.flushFireState();
    const second = await boot(deps);
    expect(await second.onMessage(message(111), 'default')).toBe(0);
    clock += 200_000; // 900 s after the fire
    expect(await second.onMessage(message(111), 'default')).toBe(1);
  });

  it('deleting the rule removes its rows (load() prunes orphans)', async () => {
    const a = await create({ cooldownSeconds: 600, rateLimit: { maxActions: 3, windowSeconds: 3600 } });
    const { deps } = recorder();
    const engine = await boot(deps);
    expect(await engine.onMessage(message(111), 'default')).toBe(1);
    await engine.flushFireState();
    expect((await fireRepo.listAll()).map((r) => r.kind).sort()).toEqual(['cooldown', 'rate']);

    await autos.deleteAutomation(a.id);
    await engine.load();
    await engine.flushFireState();
    expect(await fireRepo.listAll()).toEqual([]);
  });

  it('the rate-limit window survives a restart', async () => {
    await create({ rateLimit: { maxActions: 2, windowSeconds: 3600 } });
    const { calls, deps } = recorder();
    const first = await boot(deps);
    expect(await first.onMessage(message(111), 'default')).toBe(1);
    clock += 1000;
    expect(await first.onMessage(message(222), 'default')).toBe(1);
    expect(await first.onMessage(message(333), 'default')).toBe(0); // 2/2 used
    await first.flushFireState();

    clock += 60_000;
    const second = await boot(deps);
    expect(await second.onMessage(message(444), 'default')).toBe(0); // still 2/2

    clock += 3_600_000; // window rolls past both fires
    expect(await second.onMessage(message(444), 'default')).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('runNow counts against the persisted cooldown', async () => {
    const a = await autos.createAutomation({
      name: 'nightly',
      enabled: false,
      config: JSON.stringify({
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.schedule', params: { cron: '0 3 * * *', cooldownSeconds: 600 } },
          { id: 'n', type: 'action.notify', params: { body: 'nightly' } },
        ],
        edges: [{ from: 't', to: 'n' }],
      }),
    });
    const { deps } = recorder();
    const first = await boot(deps);
    expect((await first.runNow(a.id)).ran).toBe(true);
    await first.flushFireState();

    const second = await boot(deps);
    expect(await second.runNow(a.id)).toMatchObject({ ran: false, reason: 'cooldown' });
  });

  it('load() prunes expired rows, and drops rows once the cooldown is removed', async () => {
    const a = await create({ cooldownSeconds: 600, cooldownScope: 'node' });
    const { deps } = recorder();
    const engine = await boot(deps);
    expect(await engine.onMessage(message(111), 'default')).toBe(1);
    clock += 500_000;
    expect(await engine.onMessage(message(222), 'default')).toBe(1);
    await engine.flushFireState();
    expect(await fireRepo.listAll()).toHaveLength(2);

    clock += 200_000; // 111 has lapsed, 222 has not
    await engine.load();
    await engine.flushFireState();
    expect((await fireRepo.listAll()).map((r) => r.scopeKey)).toHaveLength(1);

    await autos.updateAutomation(a.id, { config: JSON.stringify(messageGraph({})) });
    await engine.load();
    await engine.flushFireState();
    expect(await fireRepo.listAll()).toEqual([]);
  });

  it('a stored time in the future is clamped to now (clock stepped back)', async () => {
    const a = await create({ cooldownSeconds: 600 });
    await fireRepo.upsertCooldown(a.id, '', clock + 10 * 365 * 86_400_000);
    const { deps } = recorder();
    const engine = await boot(deps);
    expect(await engine.onMessage(message(111), 'default')).toBe(0);
    clock += 600_000;
    expect(await engine.onMessage(message(111), 'default')).toBe(1);
  });

  it('a failing store does not stop the engine; the in-memory guard still holds', async () => {
    await create({ cooldownSeconds: 600 });
    const broken = new AutomationFireStateRepository(t.db, 'sqlite');
    broken.listAll = async () => { throw new Error('db down'); };
    broken.upsertCooldown = async () => { throw new Error('db down'); };
    const { deps } = recorder();
    const engine = await boot(deps, broken);
    expect(await engine.onMessage(message(111), 'default')).toBe(1);
    await engine.flushFireState();
    expect(await engine.onMessage(message(111), 'default')).toBe(0);
  });

  it('without a store, behaviour is unchanged (in-memory only)', async () => {
    await create({ cooldownSeconds: 600 });
    const { deps } = recorder();
    const first = await boot(deps, null);
    expect(await first.onMessage(message(111), 'default')).toBe(1);
    const second = await boot(deps, null);
    expect(await second.onMessage(message(111), 'default')).toBe(1);
  });
});
