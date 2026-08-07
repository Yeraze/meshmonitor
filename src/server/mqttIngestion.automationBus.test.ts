/**
 * End-to-end guard for #4593: an MQTT-ingested text message must reach the
 * Automation Engine — WITHOUT letting MeshMonitor answer its own traffic.
 *
 * The chain exercised here is the real one, minus the singleton bootstrap:
 *   ingestServiceEnvelope → dataEventEmitter('data', message:new)
 *     → engine.onMessage (the exact mapping automationEngineSingleton does)
 *       → self-origin guard → action deps
 *
 * The engine runs against a real in-memory automations repo and the REAL
 * `createMeshNodeDataProvider`, so the self-origin guard resolves identity the
 * same way production does: through `sourceManagerRegistry`.
 *
 * Why the self-origin half matters (the #3914 hazard, re-opened by #4593):
 * an `mqtt_bridge` has no local node of its own, so a message MeshMonitor sent
 * on a Meshtastic source comes back down the bridge — uplinked by somebody
 * else's gateway — as an ordinary inbound packet from our own nodeNum. If the
 * engine fired on that, an auto-reply automation would answer its own reply
 * forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: vi.fn(async () => undefined),
    nodes: {
      getNode: vi.fn(async () => null),
      getNodesByNums: vi.fn(async () => new Map()),
      upsertNode: vi.fn(async () => undefined),
    },
    ignoredNodes: {
      isIgnoredCached: vi.fn(() => false),
      addGeoIgnoreAsync: vi.fn(async () => true),
      liftGeoIgnoreAsync: vi.fn(async () => false),
    },
    messages: {
      getMessage: vi.fn(async () => null),
      insertMessage: vi.fn(async (_msg: any, _sourceId?: string) => true),
    },
    channels: {
      upsertChannel: vi.fn(async () => undefined),
      getChannelById: vi.fn(async () => null),
      getAllChannels: vi.fn(async () => []),
    },
    channelDatabase: {
      findOrCreateByNameAndHashAsync: vi.fn(async () => undefined),
      findOrCreatePassiveByNameAsync: vi.fn(async () => undefined),
      getEnabledAsync: vi.fn(async () => []),
    },
    settings: {
      getSettingForSource: vi.fn(async () => null),
    },
    sources: {
      getSource: vi.fn(async () => null),
    },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number, payload: Uint8Array) =>
      portnum === 1 ? new TextDecoder('utf-8').decode(payload) : null,
    ),
    getPortNumName: vi.fn((portnum: number) => `PORT_${portnum}`),
  },
}));

vi.mock('./services/mqttPacketLogService.js', () => ({
  default: { logEnvelope: vi.fn(async () => undefined) },
}));

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ingestServiceEnvelope, _resetMqttIngestCachesForTest } from './mqttIngestion.js';
import { dataEventEmitter, type DataEvent } from './services/dataEventEmitter.js';
import { AutomationEngineService } from './services/automation/automationEngineService.js';
import { createMeshNodeDataProvider } from './services/automation/meshNodeData.js';
import { VariableResolver } from './services/automation/variableResolver.js';
import { automationTraceBus } from './services/automation/automationTraceBus.js';
import type { ActionDeps } from './services/automation/actionExecutor.js';
import { AutomationsRepository } from '../db/repositories/automations.js';
import { AutomationVariablesRepository } from '../db/repositories/automationVariables.js';
import { createTestDb } from './test-helpers/testDb.js';
import { sourceManagerRegistry, type ISourceManager } from './sourceManagerRegistry.js';
import type { DbMessage } from '../services/database.js';
import * as schema from '../db/schema/index.js';
import type { ServiceEnvelopeShape } from './mqttPacketFilter.js';

const BRIDGE = 'bridge-1';
const TCP_SOURCE = 'tcp-1';
const OUR_NODE = 0x11223344;
const FOREIGN_NODE = 0x0a0b0c0d;

/** Minimal ISourceManager stand-in — only the identity accessors matter here. */
function fakeManager(sourceId: string, sourceType: any, nodeNum: number | null): ISourceManager {
  return {
    sourceId,
    sourceType,
    start: async () => undefined,
    stop: async () => undefined,
    getStatus: () => ({ sourceId, sourceName: sourceId, sourceType, connected: true }),
    getLocalNodeInfo: () =>
      nodeNum == null
        ? null
        : { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'Ours', shortName: 'US' },
    startDistanceDeleteScheduler: async () => undefined,
    stopDistanceDeleteScheduler: () => undefined,
  } as ISourceManager;
}

function envFrom(from: number, text: string): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId: '!00000001',
    packet: {
      id: 0x4a4b4c4d,
      from,
      to: 0xffffffff,
      channel: 0,
      decoded: { portnum: 1, payload: new TextEncoder().encode(text) },
    },
  } as ServiceEnvelopeShape;
}

describe('MQTT ingestion → Automation Engine (#4593)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let autos: AutomationsRepository;
  let engine: AutomationEngineService;
  let calls: Array<{ fn: string; args: any }>;
  let pending: Promise<unknown>[];
  let listener: (e: DataEvent) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetMqttIngestCachesForTest();

    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    autos = new AutomationsRepository(drizzleDb, 'sqlite');
    const resolver = new VariableResolver(new AutomationVariablesRepository(drizzleDb, 'sqlite'));

    calls = [];
    // Only the four action deps this suite's automation can reach are stubbed.
    const deps = {
      sendMessage: async (a: any) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
      sendTapback: async (a: any) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
      manageNode: async (a: any) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
      notify: async (a: any) => { calls.push({ fn: 'notify', args: a }); return 4; },
    } as unknown as ActionDeps;

    engine = new AutomationEngineService({
      automationsRepo: autos,
      varResolver: resolver,
      deps,
      // The REAL provider — its self-identity accessors read sourceManagerRegistry.
      data: createMeshNodeDataProvider(),
    });
    await autos.createAutomation({
      name: 'auto-reply',
      enabled: true,
      config: JSON.stringify({
        version: 1,
        nodes: [
          { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
          { id: 's', type: 'action.sendMessage', params: { text: 'pong', sourceId: TCP_SOURCE } },
        ],
        edges: [{ from: 't', to: 's' }],
      }),
    });
    await engine.load();

    // Same event → trigger mapping automationEngineSingleton.handleEvent uses.
    pending = [];
    listener = (event: DataEvent) => {
      if (event.type === 'message:new') {
        pending.push(engine.onMessage(event.data as DbMessage, event.sourceId ?? null));
      }
    };
    dataEventEmitter.on('data', listener);
  });

  afterEach(async () => {
    dataEventEmitter.off('data', listener);
    for (const id of ['bridge-1', TCP_SOURCE]) {
      await sourceManagerRegistry.removeManager(id);
    }
    db.close();
    automationTraceBus.reset();
    automationTraceBus.setSink(null);
  });

  it('fires a message automation for a message ingested from an mqtt_bridge source', async () => {
    await sourceManagerRegistry.addManager(fakeManager(BRIDGE, 'mqtt_bridge', null));

    await ingestServiceEnvelope({ sourceId: BRIDGE, envelope: envFrom(FOREIGN_NODE, 'ping') });
    const fired = await Promise.all(pending);

    expect(fired).toEqual([1]);
    expect(calls.map((c) => c.fn)).toEqual(['sendMessage']);
    expect(calls[0].args.text).toBe('pong');
  });

  it('does NOT fire for our own message relayed back down the bridge (no self-response loop)', async () => {
    // A bridge has no identity of its own…
    await sourceManagerRegistry.addManager(fakeManager(BRIDGE, 'mqtt_bridge', null));
    // …but the Meshtastic source that actually sent the message does.
    await sourceManagerRegistry.addManager(fakeManager(TCP_SOURCE, 'meshtastic_tcp', OUR_NODE));

    await ingestServiceEnvelope({ sourceId: BRIDGE, envelope: envFrom(OUR_NODE, 'ping') });
    const fired = await Promise.all(pending);

    // The row was still ingested and emitted (the UI wants it); only the
    // automation trigger is suppressed.
    expect(fired).toEqual([0]);
    expect(calls).toHaveLength(0);
  });

  it('still fires for a third party when one of our own nodes is registered', async () => {
    await sourceManagerRegistry.addManager(fakeManager(BRIDGE, 'mqtt_bridge', null));
    await sourceManagerRegistry.addManager(fakeManager(TCP_SOURCE, 'meshtastic_tcp', OUR_NODE));

    await ingestServiceEnvelope({ sourceId: BRIDGE, envelope: envFrom(FOREIGN_NODE, 'ping') });
    const fired = await Promise.all(pending);

    expect(fired).toEqual([1]);
    expect(calls.map((c) => c.fn)).toEqual(['sendMessage']);
  });
});
