/**
 * MeshCore reaction triggers (#5763): opt-in param, target lookup, self guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import type { AutomationGraph } from '../../../types/automation.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

const THUMB = '\u{1F44D}';

function recorder() {
  const calls: Array<{ fn: string; args: any }> = [];
  const deps: ActionDeps = {
    sendMessage: async (a) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
    sendTapback: async (a) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
    manageNode: async (a) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
    notify: async (a) => { calls.push({ fn: 'notify', args: a }); return 4; },
  };
  return { calls, deps };
}

function reaction(over: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'r1',
    fromPublicKey: 'channel-0',
    fromName: 'Bob',
    text: THUMB,
    timestamp: 1000,
    reactionEmoji: THUMB,
    reactionTargetId: 't1',
    ...over,
  } as MeshCoreMessage;
}

const graph = (params: Record<string, unknown>): AutomationGraph => ({
  version: 1,
  nodes: [
    { id: 't', type: 'trigger.message', params },
    { id: 's', type: 'action.sendMessage', params: { text: 'r:{{ trigger.reactionTargetText }}' } },
  ],
  edges: [{ from: 't', to: 's' }],
});

describe('MeshCore reaction trigger (#5763)', () => {
  let db: { close(): void };
  let drizzleDb: BetterSQLite3Database<any>;
  let autos: AutomationsRepository;
  let resolver: VariableResolver;
  let clock: number;
  const getMeshCoreMessage = vi.fn();
  const isOwnMeshCoreName = vi.fn();

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(new AutomationVariablesRepository(drizzleDb, 'sqlite'));
    clock = 1_000_000;
    getMeshCoreMessage.mockReset().mockResolvedValue({ text: 'hello world', fromName: 'Alice' });
    isOwnMeshCoreName.mockReset().mockResolvedValue(false);
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const make = async (params: Record<string, unknown>, deps: ActionDeps, extra: Record<string, unknown> = {}) => {
    await autos.createAutomation({ name: 'r', enabled: true, config: JSON.stringify(graph(params)) });
    const data = { getNode: async () => null, getTelemetry: async () => null, getMeshCoreMessage, isOwnMeshCoreName, ...extra };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => clock });
    await engine.load();
    return engine;
  };

  it('rule without the param: zero fires and zero target reads', async () => {
    const { calls, deps } = recorder();
    const engine = await make({}, deps);
    expect(await engine.onMeshCoreMessage(reaction(), 'default')).toBe(0);
    expect(getMeshCoreMessage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('a bridge-shaped rule (regex, no param) does not fire on a reaction', async () => {
    const { calls, deps } = recorder();
    const engine = await make({ regex: '.*' }, deps);
    expect(await engine.onMeshCoreMessage(reaction(), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('rule with the param fires once and resolves the target text', async () => {
    const { calls, deps } = recorder();
    const engine = await make({ includeMeshCoreReactions: true }, deps);
    expect(await engine.onMeshCoreMessage(reaction(), 'default')).toBe(1);
    expect(getMeshCoreMessage).toHaveBeenCalledWith('default', 't1');
    expect(calls[0].args.text).toBe('r:hello world');
  });

  it('an unmatched reaction fires with no target fields', async () => {
    const { calls, deps } = recorder();
    const engine = await make({ includeMeshCoreReactions: true }, deps);
    expect(await engine.onMeshCoreMessage(reaction({ reactionTargetId: null }), 'default')).toBe(1);
    expect(getMeshCoreMessage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('a plain message still fires a rule that has the param', async () => {
    const { deps } = recorder();
    const engine = await make({ includeMeshCoreReactions: true }, deps);
    const plain = { id: 'p', fromPublicKey: 'channel-0', text: 'hi', timestamp: 1 } as MeshCoreMessage;
    expect(await engine.onMeshCoreMessage(plain, 'default')).toBe(1);
  });

  describe('self guard', () => {
    it.each([
      ['selfOrigin', { selfOrigin: true }],
      ['local sender', { fromPublicKey: 'local' }],
      ['own key', { fromPublicKey: 'abcd' }],
    ])('drops %s', async (_n, over) => {
      const { calls, deps } = recorder();
      const engine = await make({ includeMeshCoreReactions: true }, deps, { getSelfPublicKey: async () => 'ABCD' });
      expect(await engine.onMeshCoreMessage(reaction(over as Partial<MeshCoreMessage>), 'default')).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('drops a channel reaction whose name is a local node name', async () => {
      const { calls, deps } = recorder();
      isOwnMeshCoreName.mockResolvedValue(true);
      const engine = await make({ includeMeshCoreReactions: true }, deps);
      expect(await engine.onMeshCoreMessage(reaction(), 'default')).toBe(0);
      expect(isOwnMeshCoreName).toHaveBeenCalledWith('Bob');
      expect(calls).toHaveLength(0);
    });

    it('includeSelf plus the param does fire', async () => {
      const { deps } = recorder();
      const engine = await make({ includeMeshCoreReactions: true, includeSelf: true }, deps);
      expect(await engine.onMeshCoreMessage(reaction({ selfOrigin: true }), 'default')).toBe(1);
    });
  });

  describe('cooldown', () => {
    it('no implicit cooldown: two reactions 5 s apart both fire', async () => {
      const { deps } = recorder();
      const engine = await make({ includeMeshCoreReactions: true }, deps);
      expect(await engine.onMeshCoreMessage(reaction(), 'default')).toBe(1);
      clock += 5000;
      expect(await engine.onMeshCoreMessage(reaction({ id: 'r2' }), 'default')).toBe(1);
    });

    it('an explicit cooldown still gates', async () => {
      const { deps } = recorder();
      const engine = await make({ includeMeshCoreReactions: true, cooldownSeconds: 30 }, deps);
      expect(await engine.onMeshCoreMessage(reaction(), 'default')).toBe(1);
      clock += 5000;
      expect(await engine.onMeshCoreMessage(reaction({ id: 'r2' }), 'default')).toBe(0);
    });

    it('a rule without the param has no implicit cooldown', async () => {
      const { deps } = recorder();
      const engine = await make({}, deps);
      const plain = (id: string) => ({ id, fromPublicKey: 'channel-0', text: 'hi', timestamp: 1 }) as MeshCoreMessage;
      expect(await engine.onMeshCoreMessage(plain('a'), 'default')).toBe(1);
      clock += 5000;
      expect(await engine.onMeshCoreMessage(plain('b'), 'default')).toBe(1);
    });
  });
});
