/**
 * #6382 — node-name anti-spam at the two repository write seams, per source.
 *
 * Runs against the REAL singleton `databaseService` (`:memory:` SQLite, real
 * migrations, real settings table). Proves:
 *   - a rewrite happens on the Meshtastic (`nodes`) and MeshCore
 *     (`meshcore_nodes`) seams once the setting is on, and not while it is off;
 *   - a source's own node is never rewritten, while the same node heard on a
 *     different source is;
 *   - the real MQTT ingest paths (Meshtastic NodeInfo via
 *     `ingestServiceEnvelope`, MeshCore adverts via `ingestAdvertFrame`) store
 *     the cleaned name;
 *   - the re-scan cleans rows already stored, on every source, MQTT included.
 *
 * Only protobuf decode is mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const nodeInfoPayload = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../meshtasticProtobufService.js', () => ({
  default: {
    processPayload: vi.fn((portnum: number) => (portnum === 4 ? nodeInfoPayload.value : null)),
  },
}));

import databaseService from '../../services/database.js';
import { ingestServiceEnvelope } from '../mqttIngestion.js';
import { ingestAdvertFrame } from './meshcoreFrameIngest.js';
import { buildAdvertFrame } from '../test-helpers/meshcoreFrames.js';
import type { ServiceEnvelopeShape } from '../mqttPacketFilter.js';
import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';
import { installNodeNameLocalResolver, reloadNodeNameSanitizer, rescanNodeNames } from './nodeNameSanitizerService.js';
import { __resetNodeNameSanitizerForTest, getNodeNameSanitizerStats } from '../../utils/nodeNameSanitizerRuntime.js';

const SRC_A = 'nns-ps-src-a';      // Meshtastic TCP; LOCAL_NUM is its own node
const SRC_B = 'nns-ps-src-b';      // Meshtastic TCP; hears LOCAL_NUM as a remote node
const SRC_MQTT = 'nns-ps-mqtt';    // Meshtastic MQTT broker
const SRC_MC = 'nns-ps-mc';        // MeshCore companion; LOCAL_KEY is its own node
const SRC_MC2 = 'nns-ps-mc2';      // MeshCore MQTT; hears LOCAL_KEY as a remote node

const LOCAL_NUM = 0x6382_0001;
const REMOTE_NUM = 0x6382_0002;
const MQTT_NUM = 0x6382_0003;
const LOCAL_KEY = 'a1'.repeat(32);
const REMOTE_KEY = 'b2'.repeat(32);
const ADVERT_KEY = 'c3'.repeat(32);

const SPAM = 'Spammer t.me/spam_channel';
const CLEAN = 'Spammer [spammer]';

const fakeRegistry = {
  getManager: (sourceId: string) => {
    if (sourceId === SRC_A) {
      return { sourceType: 'meshtastic_tcp', getLocalNodeInfo: () => ({ nodeNum: LOCAL_NUM, nodeId: '!63820001', longName: 'x', shortName: 'x' }) };
    }
    if (sourceId === SRC_MC) {
      return { sourceType: 'meshcore', getLocalNodeInfo: () => null, getLocalNode: () => ({ publicKey: LOCAL_KEY }) };
    }
    return undefined;
  },
} as unknown as SourceManagerRegistry;

async function setSanitizer(enabled: boolean): Promise<void> {
  await databaseService.settings.setSetting('nodeNameSanitizeEnabled', enabled ? 'true' : 'false');
  await reloadNodeNameSanitizer();
}

async function upsertMt(nodeNum: number, sourceId: string, longName: string, shortName = 'SPAM'): Promise<void> {
  await databaseService.nodes.upsertNode({
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName,
    shortName,
  }, sourceId);
}

const longNameOf = async (nodeNum: number, sourceId: string) => (await databaseService.nodes.getNode(nodeNum, sourceId))?.longName;
const mcNameOf = async (publicKey: string, sourceId: string) =>
  (await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId))?.name;

describe('node-name anti-spam, per source (#6382)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    for (const [id, type] of [
      [SRC_A, 'meshtastic_tcp'], [SRC_B, 'meshtastic_tcp'], [SRC_MQTT, 'mqtt_broker'],
      [SRC_MC, 'meshcore'], [SRC_MC2, 'meshcore_mqtt'],
    ] as const) {
      await databaseService.sources.deleteSource(id).catch(() => {});
      await databaseService.sources.createSource({ id, name: id, type, config: {}, enabled: true });
    }
  });

  beforeEach(async () => {
    __resetNodeNameSanitizerForTest();
    installNodeNameLocalResolver(fakeRegistry);
    await databaseService.settings.setSetting('nodeNameSanitizeEnabled', 'false');
    await reloadNodeNameSanitizer();
  });

  afterAll(async () => {
    __resetNodeNameSanitizerForTest();
    await databaseService.settings.setSetting('nodeNameSanitizeEnabled', 'false');
    for (const id of [SRC_A, SRC_B, SRC_MQTT, SRC_MC, SRC_MC2]) {
      await databaseService.sources.deleteSource(id).catch(() => {});
    }
  });

  it('stores names untouched while the setting is off (the default)', async () => {
    await upsertMt(REMOTE_NUM, SRC_A, SPAM);
    expect(await longNameOf(REMOTE_NUM, SRC_A)).toBe(SPAM);
    await databaseService.meshcore.upsertNode({ publicKey: REMOTE_KEY, name: SPAM }, SRC_MC);
    expect(await mcNameOf(REMOTE_KEY, SRC_MC)).toBe(SPAM);
  });

  it('Meshtastic seam: rewrites a remote node, never the source\'s own node', async () => {
    await setSanitizer(true);
    await upsertMt(REMOTE_NUM, SRC_A, SPAM);
    await upsertMt(LOCAL_NUM, SRC_A, SPAM);
    // The same physical node is a remote node on source B.
    await upsertMt(LOCAL_NUM, SRC_B, SPAM);

    expect(await longNameOf(REMOTE_NUM, SRC_A)).toBe(CLEAN);
    expect(await longNameOf(LOCAL_NUM, SRC_A)).toBe(SPAM);
    expect(await longNameOf(LOCAL_NUM, SRC_B)).toBe(CLEAN);
    expect(getNodeNameSanitizerStats().meshtastic).toBe(2);
  });

  it('MeshCore seam: rewrites a remote node, never the source\'s own node', async () => {
    await setSanitizer(true);
    await databaseService.meshcore.upsertNode({ publicKey: REMOTE_KEY, name: SPAM }, SRC_MC);
    await databaseService.meshcore.upsertNode({ publicKey: LOCAL_KEY, name: SPAM }, SRC_MC);
    await databaseService.meshcore.upsertNode({ publicKey: LOCAL_KEY, name: SPAM }, SRC_MC2);

    expect(await mcNameOf(REMOTE_KEY, SRC_MC)).toBe(CLEAN);
    expect(await mcNameOf(LOCAL_KEY, SRC_MC)).toBe(SPAM);
    expect(await mcNameOf(LOCAL_KEY, SRC_MC2)).toBe(CLEAN);
  });

  it('MeshCore seam: a row flagged isLocalNode is never rewritten', async () => {
    await setSanitizer(true);
    const key = 'd4'.repeat(32);
    await databaseService.meshcore.upsertNode({ publicKey: key, name: 'Mine', isLocalNode: true }, SRC_MC2);
    await databaseService.meshcore.upsertNode({ publicKey: key, name: SPAM }, SRC_MC2);
    expect(await mcNameOf(key, SRC_MC2)).toBe(SPAM);
  });

  it('Meshtastic MQTT: a NodeInfo through ingestServiceEnvelope stores the cleaned name', async () => {
    await setSanitizer(true);
    nodeInfoPayload.value = { longName: 'Relay https://t.me/buy_now', shortName: 'RLY', hwModel: 9 };
    const envelope: ServiceEnvelopeShape = {
      channelId: 'LongFast',
      gatewayId: '!00000001',
      packet: {
        id: 0x63820099,
        from: MQTT_NUM,
        to: 0xffffffff,
        channel: 0,
        rxTime: Math.floor(Date.now() / 1000),
        decoded: { portnum: 4 /* NODEINFO_APP */, payload: new Uint8Array([0]) },
      },
    };
    const result = await ingestServiceEnvelope({ sourceId: SRC_MQTT, envelope });
    expect(result.ingested).toBe(true);
    await vi.waitFor(async () => {
      expect(await longNameOf(MQTT_NUM, SRC_MQTT)).toBe('Relay [spammer]');
    });
  });

  it('MeshCore MQTT: an advert through ingestAdvertFrame stores the cleaned name', async () => {
    await setSanitizer(true);
    await ingestAdvertFrame(
      buildAdvertFrame({ publicKey: ADVERT_KEY, name: 'Rpt discord.gg/x' }),
      SRC_MC2,
      { lastHeardMs: Date.now() },
    );
    expect(await mcNameOf(ADVERT_KEY, SRC_MC2)).toBe('Rpt [spammer]');
  });

  it('re-scan cleans stored rows on every source, skips own nodes, and is idempotent', async () => {
    // Store spam while the filter is off.
    await upsertMt(REMOTE_NUM, SRC_A, SPAM);
    await upsertMt(LOCAL_NUM, SRC_A, SPAM);
    await upsertMt(LOCAL_NUM, SRC_B, SPAM);
    await upsertMt(MQTT_NUM, SRC_MQTT, SPAM);
    await databaseService.meshcore.upsertNode({ publicKey: REMOTE_KEY, name: SPAM }, SRC_MC);
    await databaseService.meshcore.upsertNode({ publicKey: LOCAL_KEY, name: SPAM }, SRC_MC);
    await databaseService.meshcore.upsertNode({ publicKey: ADVERT_KEY, name: SPAM }, SRC_MC2);

    await expect(rescanNodeNames(fakeRegistry)).rejects.toThrow(/disabled/);

    await setSanitizer(true);
    const first = await rescanNodeNames(fakeRegistry);
    expect(first.nodesChanged).toBeGreaterThanOrEqual(3);
    expect(first.meshcoreNodesChanged).toBeGreaterThanOrEqual(2);

    expect(await longNameOf(REMOTE_NUM, SRC_A)).toBe(CLEAN);
    expect(await longNameOf(LOCAL_NUM, SRC_A)).toBe(SPAM);
    expect(await longNameOf(LOCAL_NUM, SRC_B)).toBe(CLEAN);
    expect(await longNameOf(MQTT_NUM, SRC_MQTT)).toBe(CLEAN);
    expect(await mcNameOf(REMOTE_KEY, SRC_MC)).toBe(CLEAN);
    expect(await mcNameOf(LOCAL_KEY, SRC_MC)).toBe(SPAM);
    expect(await mcNameOf(ADVERT_KEY, SRC_MC2)).toBe(CLEAN);

    const second = await rescanNodeNames(fakeRegistry);
    expect(second.nodesChanged).toBe(0);
    expect(second.meshcoreNodesChanged).toBe(0);
  });
});
