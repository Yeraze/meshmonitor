import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutomationsRepository } from '../../../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { AutomationEngineService } from './automationEngineService.js';
import type { ActionDeps } from './actionExecutor.js';
import type { DbMessage } from '../../../services/database.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import type { ReticulumMessageRow } from '../../../db/repositories/reticulum.js';
import type { AutomationGraph } from '../../../types/automation.js';
import * as schema from '../../../db/schema/index.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { automationTraceBus } from './automationTraceBus.js';

const FAR_FUTURE = 9_000_000_000_000;

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

function message(over: Partial<DbMessage> = {}): DbMessage {
  const from = (over.fromNodeNum as number) ?? 111;
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
    ...over,
  } as DbMessage;
}

function mcMessage(over: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'mc1',
    fromPublicKey: 'channel-0', // channel message on slot 0
    text: 'ping',
    timestamp: 1000,
    ...over,
  } as MeshCoreMessage;
}

function retMessage(over: Partial<ReticulumMessageRow> = {}): ReticulumMessageRow {
  return {
    id: 'default_hash1',
    sourceId: 'default',
    fromHash: 'peer'.padEnd(32, '0'),
    toHash: 'self'.padEnd(32, '0'),
    title: null,
    content: 'ping',
    timestamp: 1000,
    receivedAt: 1000,
    createdAt: 1000,
    state: 'delivered',
    method: 'opportunistic',
    signatureValidated: true,
    ratcheted: false,
    fields: null,
    replyToHash: null,
    threadHash: null,
    rssi: null,
    snr: null,
    quality: null,
    ...over,
  };
}

describe('AutomationEngineService', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let varsRepo: AutomationVariablesRepository;
  let resolver: VariableResolver;
  let clock: number;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    varsRepo = new AutomationVariablesRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(varsRepo);
    clock = 1_000_000;
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  const data = { getNode: async () => null, getTelemetry: async () => null };
  const engineWith = (deps: ActionDeps) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => clock });

  async function createEnabled(name: string, graph: AutomationGraph) {
    return autos.createAutomation({ name, enabled: true, config: JSON.stringify(graph) });
  }

  it('fires a ping → tapback automation and writes a completed run', async () => {
    const { calls, deps } = recorder();
    const a = await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    expect(engine.countFor('trigger.message')).toBe(1);

    const fired = await engine.onMessage(message({ text: 'ping me' }), 'default');
    expect(fired).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['sendTapback']);

    const runs = await autos.listRuns(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
  });

  it('applies the trigger pre-filter (no match → no fire)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    const fired = await engine.onMessage(message({ text: 'hello' }), 'default');
    expect(fired).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('matches a message trigger by channel NAME, resolving the per-source slot→name', async () => {
    const { calls, deps } = recorder();
    await createEnabled('on-gauntlet', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { channelName: 'gauntlet' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    // Slot 2 is "Gauntlet" on this source; slot 0 is "Primary".
    const chData = {
      getNode: async () => null,
      getTelemetry: async () => null,
      getChannelName: async (_sourceId: string | null, idx: number) => (idx === 2 ? 'Gauntlet' : 'Primary'),
    };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: chData, now: () => clock });
    await engine.load();

    expect(await engine.onMessage(message({ channel: 2 }), 'default')).toBe(1); // name matches (case-insensitive)
    expect(await engine.onMessage(message({ channel: 0 }), 'default')).toBe(0); // "Primary" ≠ "gauntlet"
    expect(calls.map((c) => c.fn)).toEqual(['sendTapback']);
  });

  it('matches a message trigger by the multi-channel OR-list, resolving slot→name (#3974)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('on-gauntlet-or-ops', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { channels: [{ name: 'gauntlet', protocol: 'meshtastic' }, { name: 'ops', protocol: 'meshtastic' }] } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    // Slot 2 = "Gauntlet", slot 3 = "Ops", everything else "Primary".
    const chData = {
      getNode: async () => null,
      getTelemetry: async () => null,
      getChannelName: async (_sourceId: string | null, idx: number) => (idx === 2 ? 'Gauntlet' : idx === 3 ? 'Ops' : 'Primary'),
    };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: chData, now: () => clock });
    await engine.load();

    expect(await engine.onMessage(message({ channel: 2 }), 'default')).toBe(1); // matches "gauntlet"
    expect(await engine.onMessage(message({ channel: 3 }), 'default')).toBe(1); // matches "ops"
    expect(await engine.onMessage(message({ channel: 0 }), 'default')).toBe(0); // "Primary" in neither
    expect(calls.map((c) => c.fn)).toEqual(['sendTapback', 'sendTapback']);
  });

  it('fires a message automation on a MeshCore message and replies on the trigger scope (#3833)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong', scopeMode: 'trigger' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    const fired = await engine.onMeshCoreMessage(mcMessage({ text: 'ping me', scopeName: 'paris', scopeCode: 9 }), 'default');
    expect(fired).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['sendMessage']);
    expect(calls[0].args.scopeOverride).toBe('paris');
  });

  it('replies UNSCOPED when trigger-scope mode meets an explicitly-unscoped MeshCore trigger (#3833)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong', scopeMode: 'trigger' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    // scopeCode 0 = arrived explicitly unscoped, scopeName absent → reply unscoped ('').
    const fired = await engine.onMeshCoreMessage(mcMessage({ text: 'ping', scopeCode: 0 }), 'default');
    expect(fired).toBe(1);
    expect(calls[0].args.scopeOverride).toBe('');
  });

  it('does not fire a MeshCore message automation when the text filter misses', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onMeshCoreMessage(mcMessage({ text: 'hello' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('fires a message automation on a Reticulum LXMF message (#3960 Phase 2 WP3)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ret-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    const fired = await engine.onReticulumMessage(retMessage({ content: 'ping me' }), 'default');
    expect(fired).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(['sendMessage']);
  });

  it('does not fire a Reticulum message automation when the text filter misses', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ret-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onReticulumMessage(retMessage({ content: 'hello' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a channel-scoped message automation never fires on a Reticulum message (LXMF has no channel concept)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ret-channel', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { channel: 0 } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onReticulumMessage(retMessage(), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('self-origin (#3914): ignores a Meshtastic message from our own local node', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const selfData = { ...data, getLocalNodeNum: async () => 111 };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    // From our own node (111) → dropped before it can loop.
    expect(await engine.onMessage(message({ fromNodeNum: 111, text: 'ping' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
    // From a different node → fires normally.
    expect(await engine.onMessage(message({ fromNodeNum: 222, text: 'ping' }), 'default')).toBe(1);
  });

  it('self-origin (#4593): ignores our own node on a source with no local identity (MQTT bridge)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    // A bridge has no local node → getLocalNodeNum resolves null; the
    // cross-source owned-node set is the only thing that can recognise us.
    const selfData = {
      ...data,
      getLocalNodeNum: async () => null,
      isOwnNodeNum: async (n: number) => n === 111,
    };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    // Our own message, relayed back to us by a third-party gateway → dropped.
    expect(await engine.onMessage(message({ fromNodeNum: 111, text: 'ping' }), 'bridge-1')).toBe(0);
    expect(calls).toHaveLength(0);
    // Anyone else on the bridge still fires.
    expect(await engine.onMessage(message({ fromNodeNum: 222, text: 'ping' }), 'bridge-1')).toBe(1);
  });

  it('self-origin (#3914): ignores a MeshCore message from our own public key (case-insensitive)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const selfData = { ...data, getSelfPublicKey: async () => 'ABCD' };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    // Our own send (key differs only in case) → dropped.
    expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'abcd', text: 'ping' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
    // A different sender → fires.
    expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'channel-0', text: 'ping' }), 'default')).toBe(1);
  });

  it('self-origin (#4577 P2): ignores our own key on a MeshCore source with no self key yet (cross-source fallback)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mc-ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    // This source's own key hasn't resolved (getSelfPublicKey → null); only the
    // cross-source owned-pubkey set (another MeshCore source) can recognise us.
    const selfData = {
      ...data,
      getSelfPublicKey: async () => null,
      isOwnPublicKey: async (k: string) => k.toLowerCase() === 'abcd',
    };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    // Our own key, relayed back via a different MeshCore source → dropped.
    expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'ABCD', text: 'ping' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
    // A different sender → fires.
    expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'channel-0', text: 'ping' }), 'default')).toBe(1);
  });

  it('self-origin opt-out (#4694): a trigger.message automation with includeSelf:true still fires on our own Meshtastic node', async () => {
    const { calls, deps } = recorder();
    await createEnabled('bridge-like', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping', includeSelf: true } },
        { id: 's', type: 'action.sendMessage', params: { text: 'relayed' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const selfData = { ...data, getLocalNodeNum: async () => 111 };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    // Our own message → still fires because this automation opted back in.
    expect(await engine.onMessage(message({ fromNodeNum: 111, text: 'ping' }), 'default')).toBe(1);
    expect(calls).toHaveLength(1);
    // A different automation on the same event WITHOUT includeSelf keeps dropping self-origin.
    await createEnabled('normal', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    await engine.load();
    expect(await engine.onMessage(message({ fromNodeNum: 111, text: 'ping' }), 'default')).toBe(1); // only the includeSelf one fires
  });

  it('self-origin opt-out (#4694): includeSelf:false behaves identically to includeSelf absent (still dropped)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('explicit-false', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping', includeSelf: false } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const selfData = { ...data, getLocalNodeNum: async () => 111 };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    expect(await engine.onMessage(message({ fromNodeNum: 111, text: 'ping' }), 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('self-origin opt-out (#4694): a trigger.message automation with includeSelf:true still fires on our own MeshCore key', async () => {
    const { calls, deps } = recorder();
    await createEnabled('bridge-like', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping', includeSelf: true } },
        { id: 's', type: 'action.sendMessage', params: { text: 'relayed' } },
      ],
      edges: [{ from: 't', to: 's' }],
    });
    const selfData = { ...data, getSelfPublicKey: async () => 'ABCD' };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'abcd', text: 'ping' }), 'default')).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('self-origin (#3914): ignores our own node telemetry', async () => {
    const { deps } = recorder();
    await createEnabled('batt', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.telemetry', params: {} },
        { id: 'n', type: 'action.notify', params: { title: 'low', body: 'batt' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const selfData = { ...data, getLocalNodeNum: async () => 111 };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: selfData, now: () => clock });
    await engine.load();
    expect(await engine.onTelemetry(111, 'batteryLevel', 50, '%', 'default')).toBe(0); // our own → dropped
    expect(await engine.onTelemetry(222, 'batteryLevel', 50, '%', 'default')).toBe(1); // another node → fires
  });

  it('enforces the per-automation cooldown', async () => {
    const { calls, deps } = recorder();
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60 } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onMessage(message(), 'default')).toBe(1); // t0
    clock += 30_000;
    expect(await engine.onMessage(message(), 'default')).toBe(0); // within cooldown
    clock += 31_000;
    expect(await engine.onMessage(message(), 'default')).toBe(1); // past cooldown
    expect(calls).toHaveLength(2);
  });

  // ── cooldownScope (#4340 Phase 2) ───────────────────────────────────────────
  describe('cooldownScope (#4340 Phase 2)', () => {
    it('(a) headline: two senders on one channel cool down independently under node scope', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'node' } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1); // node 111 fires (t0)
      clock += 5_000;
      expect(await engine.onMessage(message({ fromNodeNum: 222 }), 'default')).toBe(1); // node 222 fires — same window, unaffected
      clock += 15_000;
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(0); // node 111 still cooling down (t0+20s)
      clock += 41_000;
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1); // node 111 past its window (t0+61s)
      expect(calls).toHaveLength(3);
    });

    it('(b) regression: cooldownScope absent reproduces per-automation behaviour exactly', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          // No cooldownScope param at all — the pre-Phase-2 shape.
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60 } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1); // fires (t0)
      clock += 5_000;
      // A DIFFERENT node's message is suppressed too — automation-wide, not per-node.
      expect(await engine.onMessage(message({ fromNodeNum: 222 }), 'default')).toBe(0);
      clock += 56_000;
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1); // past cooldown (t0+61s)
      expect(calls).toHaveLength(2);
    });

    it('(c) explicit cooldownScope: automation behaves identically to absent', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'automation' } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1);
      clock += 5_000;
      expect(await engine.onMessage(message({ fromNodeNum: 222 }), 'default')).toBe(0);
      clock += 56_000;
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1);
      expect(calls).toHaveLength(2);
    });

    it('(d) sourceNode: the same node on two different sources cools down independently', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'sourceNode' } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'a')).toBe(1); // fires on source 'a'
      clock += 1_000;
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'b')).toBe(1); // same node, different source — fires
      clock += 1_000;
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'a')).toBe(0); // repeat on 'a' — still cooling down
      expect(calls).toHaveLength(2);
    });

    // (e) Spec §6 describes 'bogus' as degrading to automation-wide at RUNTIME —
    // that is parseCooldownScope's own contract, exercised directly by WP1's
    // src/types/automation.test.ts. In this engine, though, `load()`
    // unconditionally runs every stored graph through validateAutomationGraph
    // (WP1 §2.2, orchestrator-approved §9.1 guard), and that guard rejects an
    // unrecognised params.cooldownScope on ANY trigger node — so an automation
    // with cooldownScope: 'bogus' never reaches parseCooldownScope at all; it is
    // skipped at load with a warning, same as any other structurally-invalid
    // graph. That is a stricter (and safer) outcome than "silently degrades" —
    // documented here rather than asserting the spec's literal wording, which
    // does not hold given WP1's landed validation.
    it('(e) an unrecognised cooldownScope fails graph validation and the automation never loads', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'bogus' } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(engine.countFor('trigger.message')).toBe(0);
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('(f1) trace: message dispatch under node scope names the cooling-down node', async () => {
      const got: any[] = [];
      automationTraceBus.setSink((_id, payload) => got.push(payload));
      const a = await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'node' } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(recorder().deps);
      await engine.load();
      automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

      await engine.onMessage(message({ fromNodeNum: 111, text: 'ping' }), 'default'); // fires
      clock += 5_000;
      await engine.onMessage(message({ fromNodeNum: 111, text: 'ping' }), 'default'); // suppressed
      const cooldownEvent = got.find((g) => g.outcome === 'cooldown');
      expect(cooldownEvent.reason).toMatch(/cooldown active/);
      expect(cooldownEvent.reason).toMatch(/node 111/);
    });

    it('(f2) trace: onSchedule under node scope names automation-wide (no subject node)', async () => {
      const got: any[] = [];
      automationTraceBus.setSink((_id, payload) => got.push(payload));
      const a = await createEnabled('cron', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.schedule', params: { cron: '* * * * *', cooldownSeconds: 60, cooldownScope: 'node' } },
          { id: 'n', type: 'action.notify', params: { body: 'tick' } },
        ],
        edges: [{ from: 't', to: 'n' }],
      });
      const engine = engineWith(recorder().deps);
      await engine.load();
      automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

      await engine.onSchedule(a.id); // fires (t0)
      clock += 5_000;
      await engine.onSchedule(a.id); // within cooldown
      const cooldownEvent = got.find((g) => g.outcome === 'cooldown');
      expect(cooldownEvent.reason).toMatch(/cooldown active/);
      expect(cooldownEvent.reason).toMatch(/automation-wide/);
    });

    it('(f3) trace: checkGeofences under node scope names the moving node', async () => {
      const got: any[] = [];
      automationTraceBus.setSink((_id, payload) => got.push(payload));
      const a = await createEnabled('geo-enter', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.geofence', params: { event: 'enter', lat: 0, lon: 0, radiusKm: 5, cooldownSeconds: 60, cooldownScope: 'node' } },
          { id: 'n', type: 'action.notify', params: { body: 'entered' } },
        ],
        edges: [{ from: 't', to: 'n' }],
      });
      const pos = { lat: 1, lon: 0 }; // outside
      const geoData = { getNode: async () => ({ nodeNum: 5, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
      const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps: recorder().deps, data: geoData, now: () => clock });
      await engine.load();
      automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

      await engine.checkGeofences(5, 'default'); // baseline (outside)
      pos.lat = 0.01; // move inside
      await engine.checkGeofences(5, 'default'); // enter → fires, marks node 5
      pos.lat = 1; // move outside (mode is 'enter'; not a fire, just updates state)
      await engine.checkGeofences(5, 'default');
      pos.lat = 0.01; // move inside again — same cooldown window
      await engine.checkGeofences(5, 'default');

      const cooldownEvent = got.find((g) => g.outcome === 'cooldown');
      expect(cooldownEvent).toBeDefined();
      expect(cooldownEvent.reason).toMatch(/cooldown active/);
      expect(cooldownEvent.reason).toMatch(/node 5/);
    });

    it('(g1) MeshCore: two DMs from different pubkeys under node scope both fire', async () => {
      const { calls, deps } = recorder();
      await createEnabled('mc-ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'node' } },
          { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
        ],
        edges: [{ from: 't', to: 's' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'nodeA', text: 'ping' }), 'default')).toBe(1);
      clock += 5_000;
      expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'nodeB', text: 'ping' }), 'default')).toBe(1);
      clock += 5_000;
      expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'nodeA', text: 'ping' }), 'default')).toBe(0); // still cooling
      expect(calls).toHaveLength(2);
    });

    it('(g2) MeshCore: two channel messages under node scope degrade to automation-wide — second suppressed', async () => {
      const { calls, deps } = recorder();
      await createEnabled('mc-ping-ch', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'node' } },
          { id: 's', type: 'action.sendMessage', params: { text: 'pong' } },
        ],
        edges: [{ from: 't', to: 's' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      // Both on channel slot 0 — fromPublicKey is the synthetic 'channel-0' key,
      // which subjectKeyOf() never uses, so both events share the degraded
      // automation-wide key even though they'd naively look like two "senders".
      expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'channel-0', text: 'ping' }), 'default')).toBe(1);
      clock += 5_000;
      expect(await engine.onMeshCoreMessage(mcMessage({ fromPublicKey: 'channel-0', text: 'ping' }), 'default')).toBe(0);
      expect(calls).toHaveLength(1);
    });

    it('(h) cooldownSeconds: 0 with cooldownScope: node fires on every event', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 0, cooldownScope: 'node' } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1);
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1);
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1);
      expect(calls).toHaveLength(3);
    });

    it('(i) eviction: a node inside its window stays suppressed after driving the key set past its bound', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 1, cooldownScope: 'node' } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      // node 999999 fires and starts its 1s cooldown window.
      expect(await engine.onMessage(message({ fromNodeNum: 999_999 }), 'default')).toBe(1);
      // Drive > COOLDOWN_KEYS_MAX (4096) distinct senders through, one per ms —
      // well inside node 999999's 1s window for the earliest ones, well past it
      // for the bulk, exercising both the exact-expiry prune and the hard trim.
      for (let i = 0; i < 4200; i++) {
        clock += 1;
        await engine.onMessage(message({ fromNodeNum: 1_000_000 + i }), 'default');
      }
      // node 999999 is now WAY past its 1s window — it must fire again (behaviour,
      // not map size, is what eviction must preserve).
      expect(await engine.onMessage(message({ fromNodeNum: 999_999 }), 'default')).toBe(1);

      // Re-verify the suppression half of the contract still holds post-eviction:
      // a fresh node fires once, then is suppressed inside its own window.
      const freshCalls = calls.length;
      expect(await engine.onMessage(message({ fromNodeNum: 2_000_000 }), 'default')).toBe(1);
      expect(await engine.onMessage(message({ fromNodeNum: 2_000_000 }), 'default')).toBe(0);
      expect(calls.length).toBe(freshCalls + 1);
    });

    it('(j) load-prune: disabling and re-enabling inside the cooldown window lets it fire immediately', async () => {
      const { calls, deps } = recorder();
      const a = await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'node' } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1); // fires, marks node 111
      await autos.setEnabled(a.id, false);
      await engine.load(); // automation drops out of the index → its cooldown state is pruned
      await autos.setEnabled(a.id, true);
      await engine.load(); // re-enabled with a clean slate

      clock += 5_000; // still well inside the original 60s window
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1); // fires immediately
      expect(calls).toHaveLength(2);
    });
  });

  it('welcome-once anti-spam via a per-node flag', async () => {
    const { calls, deps } = recorder();
    await varsRepo.createVariable({ name: 'welcomed', type: 'flag', scope: 'node' });
    // trigger → if NOT welcomed (false branch) → send welcome → set flag
    await createEnabled('welcome', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'c', type: 'condition.variable', params: { variable: 'welcomed' } },
        { id: 'send', type: 'action.sendMessage', params: { text: 'welcome {{ trigger.fromId }}' } },
        { id: 'flag', type: 'flow.setVar', params: { variable: 'welcomed', op: 'flag' } },
      ],
      edges: [
        { from: 't', to: 'c' },
        { from: 'c', to: 'send', port: 'false' },
        { from: 'send', to: 'flag' },
      ],
    });
    const engine = engineWith(deps);
    await engine.load();

    // node 111 first time → welcomed
    await engine.onMessage(message({ fromNodeNum: 111 }), 'default');
    // node 111 again → already welcomed, no send
    await engine.onMessage(message({ fromNodeNum: 111 }), 'default');
    // node 222 → welcomed (independent per-node flag)
    await engine.onMessage(message({ fromNodeNum: 222 }), 'default');

    const sends = calls.filter((c) => c.fn === 'sendMessage');
    expect(sends).toHaveLength(2); // 111 once + 222 once, NOT the 2nd 111
    expect(sends.map((s) => s.args.text).sort()).toEqual(['welcome !0000006f', 'welcome !000000de']);
  });

  it('skips invalid/unparseable configs on load', async () => {
    await autos.createAutomation({ name: 'bad-json', enabled: true, config: 'not json' });
    await autos.createAutomation({ name: 'no-trigger', enabled: true, config: JSON.stringify({ version: 1, nodes: [{ id: 'a', type: 'action.tapback' }], edges: [] }) });
    const { deps } = recorder();
    const engine = engineWith(deps);
    await engine.load();
    expect(engine.countFor('trigger.message')).toBe(0);
  });

  it('geofence: baseline does not fire; enter fires once on outside→inside', async () => {
    const { calls, deps } = recorder();
    await createEnabled('geo-enter', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'a', type: 'action.notify', params: { body: 'entered' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 1, lon: 0 }; // ~111km away → outside
    const geoData = { getNode: async () => ({ nodeNum: 5, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    expect(await engine.checkGeofences(5, 'default')).toBe(0); // baseline (outside)
    pos.lat = 0.01; // move inside (~1.1km)
    expect(await engine.checkGeofences(5, 'default')).toBe(1); // enter
    expect(await engine.checkGeofences(5, 'default')).toBe(0); // still inside → no re-fire
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
  });

  it('system: a trigger only fires for its configured event (prefilter)', async () => {
    const { calls, deps } = recorder();
    await createEnabled('on-boot', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.system', params: { event: 'bootup' } },
        { id: 'a', type: 'action.notify', params: { body: 'booted' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    expect(await engine.onSystem('source-connected', 'default', null)).toBe(0); // wrong event
    expect(await engine.onSystem('bootup', null, null)).toBe(1); // matching event
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
  });

  it('system: upgrade-available exposes version fields to interpolation', async () => {
    const { calls, deps } = recorder();
    await createEnabled('upgrade-msg', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.system', params: { event: 'upgrade-available' } },
        { id: 'a', type: 'action.sendMessage', params: { text: '{{ trigger.currentVersion }} -> {{ trigger.latestVersion }}' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const engine = engineWith(deps);
    await engine.load();

    const fired = await engine.onSystem('upgrade-available', null, null, undefined, {
      latestVersion: '9.9.9',
      currentVersion: '1.0.0',
    });
    expect(fired).toBe(1);
    const send = calls.find((c) => c.fn === 'sendMessage');
    expect(send?.args.text).toBe('1.0.0 -> 9.9.9');
  });

  it('records a failed run when a notify action throws', async () => {
    const { deps } = recorder();
    deps.notify = async () => { throw new Error('apprise down'); };
    const a = await createEnabled('notify-fail', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.system', params: { event: 'bootup' } },
        { id: 'n', type: 'action.notify', params: { body: 'x' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const engine = engineWith(deps);
    await engine.load();
    expect(await engine.onSystem('bootup', null, null)).toBe(1);
    const runs = await autos.listRuns(a.id);
    expect(runs[0].status).toBe('failed');
  });

  it('geofence: exit fires on inside→outside', async () => {
    const { deps } = recorder();
    await createEnabled('geo-exit', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'exit', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'a', type: 'action.notify', params: { body: 'left' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 0.01, lon: 0 }; // inside
    const geoData = { getNode: async () => ({ nodeNum: 7, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    expect(await engine.checkGeofences(7, 'default')).toBe(0); // baseline (inside)
    pos.lat = 1; // move outside
    expect(await engine.checkGeofences(7, 'default')).toBe(1); // exit
  });

  it('geofence: polygon region — enter fires on outside→inside', async () => {
    const { calls, deps } = recorder();
    // A 2°×2° square centred on (0,0).
    const vertices = [
      { lat: -1, lng: -1 }, { lat: -1, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: -1 },
    ];
    await createEnabled('geo-poly', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', shape: { type: 'polygon', vertices } } },
        { id: 'a', type: 'action.notify', params: { body: 'entered poly' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 5, lon: 5 }; // outside the square
    const geoData = { getNode: async () => ({ nodeNum: 9, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    expect(await engine.checkGeofences(9, 'default')).toBe(0); // baseline (outside)
    pos.lat = 0; pos.lon = 0; // move inside
    expect(await engine.checkGeofences(9, 'default')).toBe(1); // enter
    expect(await engine.checkGeofences(9, 'default')).toBe(0); // still inside → no re-fire
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
  });

  // ─── geofenceState bounds (#4399) ──────────────────────────────────────────

  it('(geofence load-prune) disabling then re-enabling drops the stale baseline', async () => {
    const { calls, deps } = recorder();
    const a = await createEnabled('geo-reload', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'n', type: 'action.notify', params: { body: 'entered' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const pos = { lat: 1, lon: 0 }; // outside
    const geoData = { getNode: async () => ({ nodeNum: 42, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    expect(await engine.checkGeofences(42, 'default')).toBe(0); // baseline (outside)
    pos.lat = 0.01; // move inside — would fire on the next check if the baseline survives

    await autos.setEnabled(a.id, false);
    await engine.load(); // automation drops out of the index → its geofence state is pruned, like lastFired
    await autos.setEnabled(a.id, true);
    await engine.load(); // re-enabled with a clean slate

    // With the stale baseline dropped, this reads as a fresh first sighting
    // (already inside) rather than an outside→inside transition — it does NOT fire.
    expect(await engine.checkGeofences(42, 'default')).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('(geofence load) reloading a still-enabled automation preserves its baseline', async () => {
    const { calls, deps } = recorder();
    await createEnabled('geo-reload-live', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'n', type: 'action.notify', params: { body: 'entered' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const pos = { lat: 1, lon: 0 }; // outside
    const geoData = { getNode: async () => ({ nodeNum: 43, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    expect(await engine.checkGeofences(43, 'default')).toBe(0); // baseline (outside)
    await engine.load(); // reload; the automation never left the index

    pos.lat = 0.01; // move inside
    expect(await engine.checkGeofences(43, 'default')).toBe(1); // enter fires — baseline survived the reload
    expect(calls).toHaveLength(1);
  });

  it('(geofence eviction) a recently-touched baseline survives driving the per-automation node set past its bound; a stale one is dropped and logged', async () => {
    const { deps } = recorder();
    await createEnabled('geo-evict', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'n', type: 'action.notify', params: { body: 'entered' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const OUTSIDE = 1;
    const INSIDE = 0.01;
    const positions = new Map<number, number>();
    const geoData = {
      getNode: async (_sourceId: string | null, nodeNum: number) =>
        ({ nodeNum, latitude: positions.get(nodeNum) ?? OUTSIDE, longitude: 0 }),
      getTelemetry: async () => null,
    };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();

    const loggerModule = await import('../../../utils/logger.js');
    const warnSpy = vi.spyOn(loggerModule.logger, 'warn');

    // OLD is touched once, before anything else — it will be the least-recently
    // touched entry once the flood below pushes the per-automation node set past
    // GEOFENCE_STATE_MAX (4096), so it must be the one evicted.
    const OLD_NUM = 500_000;
    expect(await engine.checkGeofences(OLD_NUM, 'default')).toBe(0); // baseline (outside)

    // Drive > GEOFENCE_STATE_MAX (4096) distinct nodes through, one per ms, all
    // establishing an outside baseline. RECENT_NUM (the last one touched) must
    // survive any trim pass — it is always the newest entry at the time it lands.
    let RECENT_NUM = OLD_NUM;
    for (let i = 0; i < 4200; i++) {
      clock += 1;
      RECENT_NUM = 1_000_000 + i;
      expect(await engine.checkGeofences(RECENT_NUM, 'default')).toBe(0); // baseline
    }

    // The eviction warning fired at least once, naming the trade-off.
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('geofence state trimmed'))).toBe(true);

    // OLD was evicted: its baseline is gone, so moving it inside now reads as a
    // fresh first sighting (not a transition) — the documented, accepted miss.
    clock += 1;
    positions.set(OLD_NUM, INSIDE);
    expect(await engine.checkGeofences(OLD_NUM, 'default')).toBe(0);

    // RECENT survived: moving it inside is correctly recognised as outside→inside.
    clock += 1;
    positions.set(RECENT_NUM, INSIDE);
    expect(await engine.checkGeofences(RECENT_NUM, 'default')).toBe(1);
  });

  // ─── schedule (cron) ───────────────────────────────────────────────────────
  function fakeCron() {
    const jobs: Array<{ expr: string; cb: () => void; stopped: boolean }> = [];
    const cron = {
      schedule: (expr: string, cb: () => void) => {
        const j = { expr, cb, stopped: false };
        jobs.push(j);
        return { stop: () => { j.stopped = true; } };
      },
      validate: (expr: string) => /\S/.test(expr) && expr !== 'BAD',
    };
    return { jobs, cron };
  }
  const scheduleGraph = (cron: string, cooldownSeconds?: number): AutomationGraph => ({
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.schedule', params: { cron, ...(cooldownSeconds ? { cooldownSeconds } : {}) } },
      { id: 'a', type: 'action.notify', params: { body: 'tick' } },
    ],
    edges: [{ from: 't', to: 'a' }],
  });
  const engineWithCron = (deps: ActionDeps, cron: ReturnType<typeof fakeCron>['cron']) =>
    new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data, now: () => clock, cron });

  it('schedule: arms a cron job per enabled schedule automation and onSchedule fires it', async () => {
    const { calls, deps } = recorder();
    const a = await createEnabled('cron-job', scheduleGraph('0 * * * *'));
    const { jobs, cron } = fakeCron();
    const engine = engineWithCron(deps, cron);
    await engine.load();

    expect(jobs.map((j) => j.expr)).toEqual(['0 * * * *']);
    expect(await engine.onSchedule(a.id)).toBe(1);
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
    // invoking the registered cron callback also fires it
    jobs[0].cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(2);
  });

  it('schedule: an invalid/missing cron is not armed', async () => {
    const { deps } = recorder();
    await createEnabled('bad-cron', scheduleGraph('BAD'));
    const { jobs, cron } = fakeCron();
    const engine = engineWithCron(deps, cron);
    await engine.load();
    expect(jobs).toHaveLength(0);
  });

  it('schedule: reload stops the old job and re-arms', async () => {
    const { deps } = recorder();
    await createEnabled('cron-job', scheduleGraph('0 * * * *'));
    const { jobs, cron } = fakeCron();
    const engine = engineWithCron(deps, cron);
    await engine.load();
    await engine.load(); // simulate a reload after CRUD
    expect(jobs).toHaveLength(2);
    expect(jobs[0].stopped).toBe(true);  // old job cancelled
    expect(jobs[1].stopped).toBe(false); // new job live
  });

  it('schedule: onSchedule honors the per-automation cooldown', async () => {
    const { calls, deps } = recorder();
    const a = await createEnabled('cron-cooldown', scheduleGraph('* * * * *', 60));
    const { cron } = fakeCron();
    const engine = engineWithCron(deps, cron);
    await engine.load();

    expect(await engine.onSchedule(a.id)).toBe(1); // t0
    clock += 30_000;
    expect(await engine.onSchedule(a.id)).toBe(0); // within cooldown
    clock += 31_000;
    expect(await engine.onSchedule(a.id)).toBe(1); // past cooldown
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(2);
  });

  // ── Live trace ("view logs") emit instrumentation ──────────────────────────
  it('emits a FIRED trace (with steps) for a traced rule that matches', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onMessage(message({ text: 'ping me' }), 'default');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ automationId: a.id, outcome: 'fired', status: 'completed' });
    expect(Array.isArray(got[0].steps)).toBe(true);
    expect(got[0].steps.length).toBeGreaterThan(0);
  });

  it('emits a PREFILTERED trace with a human reason when the filter misses', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onMessage(message({ text: 'hello' }), 'default');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ automationId: a.id, outcome: 'prefiltered' });
    expect(got[0].reason).toBe('text does not contain "ping"');
  });

  it('emits a COOLDOWN trace while a traced rule is cooling down', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping', cooldownSeconds: 60 } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onMessage(message({ text: 'ping' }), 'default'); // fires (t0)
    clock += 30_000;
    await engine.onMessage(message({ text: 'ping' }), 'default'); // within cooldown
    const outcomes = got.map((g) => g.outcome);
    expect(outcomes).toContain('fired');
    expect(outcomes).toContain('cooldown');
    expect(got.find((g) => g.outcome === 'cooldown').reason).toMatch(/cooldown active/);
  });

  it('emits a FIRED trace for a traced schedule (cron) rule', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('cron', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.schedule', params: { cron: '* * * * *' } },
        { id: 'n', type: 'action.notify', params: { body: 'tick' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onSchedule(a.id);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ automationId: a.id, outcome: 'fired', triggerType: 'trigger.schedule' });
  });

  it('emits a COOLDOWN trace for a throttled schedule rule', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const a = await createEnabled('cron', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.schedule', params: { cron: '* * * * *', cooldownSeconds: 60 } },
        { id: 'n', type: 'action.notify', params: { body: 'tick' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.onSchedule(a.id); // fires (t0)
    clock += 30_000;
    await engine.onSchedule(a.id); // within cooldown
    const outcomes = got.map((g) => g.outcome);
    expect(outcomes).toEqual(['fired', 'cooldown']);
    expect(got[1].reason).toMatch(/cooldown active/);
  });

  it('emits geofence traces: baseline (prefiltered) then enter (fired)', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    const { deps } = recorder();
    const a = await createEnabled('geo-enter', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.geofence', params: { event: 'enter', lat: 0, lon: 0, radiusKm: 5 } },
        { id: 'n', type: 'action.notify', params: { body: 'entered' } },
      ],
      edges: [{ from: 't', to: 'n' }],
    });
    const pos = { lat: 1, lon: 0 }; // outside
    const geoData = { getNode: async () => ({ nodeNum: 5, latitude: pos.lat, longitude: pos.lon }), getTelemetry: async () => null };
    const engine = new AutomationEngineService({ automationsRepo: autos, varResolver: resolver, deps, data: geoData, now: () => clock });
    await engine.load();
    automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

    await engine.checkGeofences(5, 'default'); // baseline (outside)
    pos.lat = 0.01;                            // move inside
    await engine.checkGeofences(5, 'default'); // enter → fires

    const outcomes = got.map((g) => g.outcome);
    expect(outcomes).toEqual(['prefiltered', 'fired']);
    expect(got[0].reason).toMatch(/baseline only/);
    expect(got[1]).toMatchObject({ status: 'completed' });
  });

  it('emits NOTHING when the rule is not being traced (hot-path no-op)', async () => {
    const got: any[] = [];
    automationTraceBus.setSink((_id, payload) => got.push(payload));
    await createEnabled('ping', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'tap' }],
    });
    const engine = engineWith(recorder().deps);
    await engine.load();
    // No arm() → nothing traced.
    await engine.onMessage(message({ text: 'ping' }), 'default');
    await engine.onMessage(message({ text: 'hello' }), 'default');
    expect(got).toHaveLength(0);
  });

  // ── rate limit (#4577 Phase 2, RATE-LIMIT) ─────────────────────────────────
  //
  // Distinct from cooldownScope above: rateLimit is keyed by automation id
  // ONLY, so it bounds total fires across every subject, not one subject's
  // debounce window.
  describe('rate limit (#4577 Phase 2, RATE-LIMIT)', () => {
    it('caps total fires across ALL subjects within the window, then replenishes once it elapses', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', rateLimit: { maxActions: 2, windowSeconds: 60 } } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      // Three DISTINCT senders inside the same 60s window — only the first two
      // may fire; the rate ceiling is per-automation, not per-sender.
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1);
      clock += 1_000;
      expect(await engine.onMessage(message({ fromNodeNum: 222 }), 'default')).toBe(1);
      clock += 1_000;
      expect(await engine.onMessage(message({ fromNodeNum: 333 }), 'default')).toBe(0); // budget spent
      expect(calls).toHaveLength(2);

      // Advance the injected clock past the window: the two prior fires age
      // out and the budget replenishes.
      clock += 60_000;
      expect(await engine.onMessage(message({ fromNodeNum: 444 }), 'default')).toBe(1);
      expect(calls).toHaveLength(3);
    });

    it('trace: emits outcome "ratelimited" with the max/window in the reason', async () => {
      const got: any[] = [];
      automationTraceBus.setSink((_id, payload) => got.push(payload));
      const a = await createEnabled('ping', {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping', rateLimit: { maxActions: 1, windowSeconds: 60 } } },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(recorder().deps);
      await engine.load();
      automationTraceBus.arm(a.id, 'sock1', FAR_FUTURE);

      await engine.onMessage(message({ fromNodeNum: 111 }), 'default'); // fires, spends the one slot
      await engine.onMessage(message({ fromNodeNum: 222 }), 'default'); // rate-limited
      const rlEvent = got.find((g) => g.outcome === 'ratelimited');
      expect(rlEvent).toBeDefined();
      expect(rlEvent.reason).toMatch(/rate limit reached — 1\/60s/);
    });

    it('a cooldown-suppressed event does not consume rate budget (precedence: cooldown before rate limit)', async () => {
      const { calls, deps } = recorder();
      await createEnabled('ping', {
        version: 1,
        nodes: [
          {
            id: 't',
            type: 'trigger.message',
            params: { textContains: 'ping', cooldownSeconds: 60, cooldownScope: 'node', rateLimit: { maxActions: 2, windowSeconds: 60 } },
          },
          { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        ],
        edges: [{ from: 't', to: 'tap' }],
      });
      const engine = engineWith(deps);
      await engine.load();

      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(1); // fires — rate budget 1/2
      clock += 1_000;
      // Same node, still inside its own node-scoped cooldown → suppressed by
      // cooldownGate BEFORE the rate gate is ever consulted. If this wrongly
      // consumed budget, the ceiling would already read 2/2 and the distinct
      // sender below would be dropped too.
      expect(await engine.onMessage(message({ fromNodeNum: 111 }), 'default')).toBe(0);
      clock += 1_000;
      expect(await engine.onMessage(message({ fromNodeNum: 222 }), 'default')).toBe(1); // budget still available
      expect(calls).toHaveLength(2);
    });
  });
});

// ── MQTT-source tapback glyph (#4594) ─────────────────────────────────────
//
// The engine resolves the source's configured TYPE and hands it to
// buildMessageContext, which swaps the hop keycap for #️⃣. Keyed on source type
// rather than the per-packet via_mqtt flag precisely so no existing automation
// on a meshtastic_tcp source changes what it emits.
describe('#4594 MQTT-source hop glyph', () => {
  const hopTapback: AutomationGraph = {
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
      { id: 'tap', type: 'action.tapback', params: { emojiMode: 'hopCount' } },
    ],
    edges: [{ from: 't', to: 'tap' }],
  };

  /** Run a ping through an engine whose provider reports `sourceType`. */
  async function tapbackEmojiFor(sourceType: string | null, over: Partial<DbMessage> = {}) {
    const t = createTestDb();
    try {
      const repo = new AutomationsRepository(t.db, 'sqlite');
      const vres = new VariableResolver(new AutomationVariablesRepository(t.db, 'sqlite'));
      const { calls, deps } = recorder();
      const provider: any = { getNode: async () => null, getTelemetry: async () => null };
      // `null` models a provider that predates the accessor entirely.
      if (sourceType !== null) provider.getSourceType = async () => sourceType;
      await repo.createAutomation({ name: 'ping', enabled: true, config: JSON.stringify(hopTapback) });
      const engine = new AutomationEngineService({
        automationsRepo: repo, varResolver: vres, deps, data: provider, now: () => 1_000_000,
      });
      await engine.load();
      // hopStart 3 / hopLimit 1 ⇒ 2 hops ⇒ 2️⃣ under the plain hop table.
      await engine.onMessage(message({ text: 'ping', hopStart: 3, hopLimit: 1, ...over }), 'default');
      return calls.find((c) => c.fn === 'sendTapback')?.args.emoji;
    } finally {
      t.sqlite.close();
    }
  }

  it('reacts #️⃣ for an mqtt_bridge source', async () => {
    expect(await tapbackEmojiFor('mqtt_bridge')).toBe('#️⃣');
  });

  it('reacts #️⃣ for an mqtt_broker source (same "never touched our RF" semantics)', async () => {
    expect(await tapbackEmojiFor('mqtt_broker')).toBe('#️⃣');
  });

  it('reacts with the unchanged hop keycap for a meshtastic_tcp source', async () => {
    expect(await tapbackEmojiFor('meshtastic_tcp')).toBe('2️⃣');
  });

  it('reacts with the unchanged hop keycap for a meshcore source', async () => {
    expect(await tapbackEmojiFor('meshcore')).toBe('2️⃣');
  });

  it('a provider without getSourceType keeps the pre-#4594 behaviour', async () => {
    expect(await tapbackEmojiFor(null)).toBe('2️⃣');
  });

  it('a per-packet viaMqtt flag on a meshtastic_tcp source does NOT change the glyph', async () => {
    // The critical back-compat case: this packet WAS relayed via MQTT at some
    // point, but our radio still received it over RF, so its hop count stands.
    expect(await tapbackEmojiFor('meshtastic_tcp', { viaMqtt: true } as Partial<DbMessage>)).toBe('2️⃣');
  });
});

describe('AutomationEngineService — becameMobile / leftHome', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let varsRepo: AutomationVariablesRepository;
  let resolver: VariableResolver;
  let clock: number;
  let homeAnchors: import('../../../db/repositories/automationHomeAnchors.js').AutomationHomeAnchorsRepository;

  beforeEach(async () => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    varsRepo = new AutomationVariablesRepository(drizzleDb, 'sqlite');
    resolver = new VariableResolver(varsRepo);
    const { AutomationHomeAnchorsRepository } = await import('../../../db/repositories/automationHomeAnchors.js');
    homeAnchors = new AutomationHomeAnchorsRepository(drizzleDb, 'sqlite');
    clock = 1_000_000;
  });
  afterEach(() => { db.close(); automationTraceBus.reset(); automationTraceBus.setSink(null); });

  async function createEnabled(name: string, graph: AutomationGraph) {
    return autos.createAutomation({ name, enabled: true, config: JSON.stringify(graph) });
  }

  it('becameMobile: fires only on 0→1 for a watched node', async () => {
    const { calls, deps } = recorder();
    await createEnabled('mob', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.becameMobile', params: { nodeNums: [42] } },
        { id: 'a', type: 'action.notify', params: { body: 'moved {{ trigger.nodeNum }}' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const data = {
      getNode: async () => ({ nodeNum: 42, latitude: 1, longitude: 2, longName: 'Site A' }),
      getTelemetry: async () => null,
    };
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps, data, homeAnchorsRepo: homeAnchors, now: () => clock,
    });
    await engine.load();

    expect(await engine.checkBecameMobile(42, 0, 0, 'default')).toBe(0);
    expect(await engine.checkBecameMobile(42, 1, 1, 'default')).toBe(0);
    expect(await engine.checkBecameMobile(99, 0, 1, 'default')).toBe(0); // not watched
    expect(await engine.checkBecameMobile(42, 0, 1, 'default')).toBe(1);
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
    expect(calls[0].args.body).toBe('moved 42');
  });

  it('leftHome: establishes home without firing, then fires on exceed and re-arms on return', async () => {
    const { calls, deps } = recorder();
    const created = await createEnabled('home', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.leftHome', params: { nodeNums: [7], thresholdMeters: 100 } },
        { id: 'a', type: 'action.notify', params: { body: 'away {{ trigger.distanceMeters }}' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 30.0, lon: -90.0 };
    const data = {
      getNode: async () => ({ nodeNum: 7, latitude: pos.lat, longitude: pos.lon }),
      getTelemetry: async () => null,
    };
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps, data, homeAnchorsRepo: homeAnchors, now: () => clock,
    });
    await engine.load();

    expect(await engine.checkLeftHome(7, 'default')).toBe(0); // establish home
    const anchor = await homeAnchors.getAnchor(created.id, 7);
    expect(anchor?.latitude).toBe(30.0);

    // ~222 m north → beyond 100 m
    pos.lat = 30.002;
    expect(await engine.checkLeftHome(7, 'default')).toBe(1);
    expect(await engine.checkLeftHome(7, 'default')).toBe(0); // still alarmed
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);

    // Return home → re-arm
    pos.lat = 30.0;
    expect(await engine.checkLeftHome(7, 'default')).toBe(0);
    pos.lat = 30.002;
    expect(await engine.checkLeftHome(7, 'default')).toBe(1);
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(2);
  });

  it('leftHome: persists home across engine reload', async () => {
    const { calls, deps } = recorder();
    await createEnabled('persist-home', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.leftHome', params: { nodeNums: [3], thresholdMeters: 100 } },
        { id: 'a', type: 'action.notify', params: { body: 'stolen' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 10.0, lon: 20.0 };
    const data = {
      getNode: async () => ({ nodeNum: 3, latitude: pos.lat, longitude: pos.lon }),
      getTelemetry: async () => null,
    };
    const engine1 = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps, data, homeAnchorsRepo: homeAnchors, now: () => clock,
    });
    await engine1.load();
    expect(await engine1.checkLeftHome(3, 'default')).toBe(0); // home set

    // New engine instance (simulates restart) — must NOT re-home at stolen coords
    pos.lat = 10.002;
    const engine2 = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps, data, homeAnchorsRepo: homeAnchors, now: () => clock,
    });
    await engine2.load();
    expect(await engine2.checkLeftHome(3, 'default')).toBe(1);
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(1);
  });

  it('leftHome: averages home while within threshold/2; does not pull home toward a far glitch', async () => {
    const { deps } = recorder();
    const created = await createEnabled('refine-home', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.leftHome', params: { nodeNums: [5], thresholdMeters: 200 } },
        { id: 'a', type: 'action.notify', params: { body: 'away' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    // Start with a slightly-off "glitch" home, then walk toward the true site
    // with fixes well inside threshold/2 (100 m) so EMA can pull the anchor.
    const pos = { lat: 40.0, lon: -70.0 };
    const data = {
      getNode: async () => ({ nodeNum: 5, latitude: pos.lat, longitude: pos.lon }),
      getTelemetry: async () => null,
    };
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps, data, homeAnchorsRepo: homeAnchors, now: () => clock,
    });
    await engine.load();
    expect(await engine.checkLeftHome(5, 'default')).toBe(0);
    const home0 = await homeAnchors.getAnchor(created.id, 5);
    expect(home0?.latitude).toBe(40.0);

    // ~55 m north (≈ 0.0005°) — inside refine radius 100 m → average toward it.
    pos.lat = 40.0005;
    expect(await engine.checkLeftHome(5, 'default')).toBe(0);
    const home1 = await homeAnchors.getAnchor(created.id, 5);
    expect(home1).toBeTruthy();
    expect(home1!.latitude).toBeGreaterThan(40.0);
    expect(home1!.latitude).toBeLessThan(40.0005);

    // Far glitch (~1.1 km) — beyond threshold → would fire, must NOT average into home.
    const latBeforeGlitch = home1!.latitude;
    pos.lat = 40.01;
    expect(await engine.checkLeftHome(5, 'default')).toBe(1);
    const homeAfterGlitch = await homeAnchors.getAnchor(created.id, 5);
    expect(homeAfterGlitch!.latitude).toBe(latBeforeGlitch);
  });

  it('leftHome: seeds home from estimateHomeFromHistory when provided', async () => {
    const { deps } = recorder();
    const created = await createEnabled('hist-home', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.leftHome', params: { nodeNums: [8], thresholdMeters: 300 } },
        { id: 'a', type: 'action.notify', params: { body: 'away' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const data = {
      getNode: async () => ({ nodeNum: 8, latitude: 1.0, longitude: 2.0 }), // live glitch
      getTelemetry: async () => null,
    };
    const engine = new AutomationEngineService({
      automationsRepo: autos,
      varResolver: resolver,
      deps,
      data,
      homeAnchorsRepo: homeAnchors,
      now: () => clock,
      estimateHomeFromHistory: async () => ({ latitude: 46.05, longitude: 14.5 }),
    });
    await engine.load();
    expect(await engine.checkLeftHome(8, 'default')).toBe(0);
    const anchor = await homeAnchors.getAnchor(created.id, 8);
    expect(anchor?.latitude).toBe(46.05);
    expect(anchor?.longitude).toBe(14.5);
  });

  it('clearLeftHomeRuntimeState drops alarmed so a beyond fix can fire again', async () => {
    const { calls, deps } = recorder();
    const created = await createEnabled('rearm-clear', {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.leftHome', params: { nodeNums: [9], thresholdMeters: 100 } },
        { id: 'a', type: 'action.notify', params: { body: 'away' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    const pos = { lat: 20.0, lon: 30.0 };
    const data = {
      getNode: async () => ({ nodeNum: 9, latitude: pos.lat, longitude: pos.lon }),
      getTelemetry: async () => null,
    };
    const engine = new AutomationEngineService({
      automationsRepo: autos, varResolver: resolver, deps, data, homeAnchorsRepo: homeAnchors, now: () => clock,
    });
    await engine.load();
    expect(await engine.checkLeftHome(9, 'default')).toBe(0);
    pos.lat = 20.002;
    expect(await engine.checkLeftHome(9, 'default')).toBe(1);
    expect(await engine.checkLeftHome(9, 'default')).toBe(0); // alarmed

    engine.clearLeftHomeRuntimeState(created.id);
    expect(await engine.checkLeftHome(9, 'default')).toBe(1);
    expect(calls.filter((c) => c.fn === 'notify')).toHaveLength(2);
  });
});
