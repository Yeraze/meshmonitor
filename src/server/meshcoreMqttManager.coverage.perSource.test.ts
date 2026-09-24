/**
 * Per-source isolation for the MeshCore Observer Coverage Report opt-in
 * (#5277 P3, §3): sources A (flag on) and B (flag off) ingest the SAME
 * message; only A records. Mirrors P2's
 * `mqttIngestion.coverage.perSource.test.ts` shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordReception = vi.fn().mockResolvedValue(true);
const upsertNode = vi.fn().mockResolvedValue(undefined);
const insertPacket = vi.fn().mockResolvedValue(undefined);
const getNodeByPublicKeyAndSource = vi.fn().mockResolvedValue(null);
const getSettingForSource = vi.fn();
const isOwnPublicKeyMock = vi.fn().mockReturnValue(false);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...a: unknown[]) => upsertNode(...a),
      insertPacket: (...a: unknown[]) => insertPacket(...a),
      getNodeByPublicKeyAndSource: (...a: unknown[]) => getNodeByPublicKeyAndSource(...a),
    },
    settings: {
      getSettingForSource: (...a: unknown[]) => getSettingForSource(...a),
    },
    coverageReceptions: { recordReception: (...a: unknown[]) => recordReception(...a) },
    getSettingAsync: vi.fn().mockResolvedValue('0'),
  },
}));

vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));

vi.mock('./utils/ownNodes.js', () => ({
  isOwnPublicKey: (...a: unknown[]) => isOwnPublicKeyMock(...a),
}));

const clients = new Map<string, FakeClient>();
class FakeClient {
  handlers = new Map<string, (arg: unknown) => void>();
  connect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn().mockResolvedValue(undefined);
  isConnected = () => true;
  on(e: string, fn: (arg: unknown) => void) {
    this.handlers.set(e, fn);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  deliver(topic: string, body: unknown) {
    this.handlers.get('message')?.({ topic, payload: Buffer.from(JSON.stringify(body)) });
  }
}
let creationOrder: string[] = [];
vi.mock('./transports/mqttBrokerClient.js', () => ({
  MqttBrokerClient: class {
    constructor() {
      const id = `client-${creationOrder.length}`;
      creationOrder.push(id);
      const c = new FakeClient();
      clients.set(id, c);
      return c as unknown as object;
    }
  },
}));

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import { __resetCoverageMeshCoreForTest } from './utils/coverageMeshCore.js';
import { __resetCoverageMqttCacheForTest } from './services/coverageMqttSettings.js';

const OBSERVER = 'AA'.repeat(32);

const GOLDEN_ZERO_HOP_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';

function body(raw: string) {
  return { type: 'PACKET', origin: 'Obs', origin_id: OBSERVER, raw, SNR: '-6', RSSI: '-90' };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  recordReception.mockClear();
  upsertNode.mockClear();
  insertPacket.mockClear();
  getNodeByPublicKeyAndSource.mockReset().mockResolvedValue(null);
  getSettingForSource.mockReset();
  isOwnPublicKeyMock.mockReset().mockReturnValue(false);
  clients.clear();
  creationOrder = [];
  __resetCoverageMeshCoreForTest();
  __resetCoverageMqttCacheForTest();
});

describe('MeshCoreMqttManager — Coverage Report per-source opt-in isolation (#5277 P3)', () => {
  it('source A (flag on) records; source B (flag off) does not, for the same message', async () => {
    getSettingForSource.mockImplementation(async (sourceId: string) => (sourceId === 'src-a' ? '1' : null));

    const mgrA = new MeshCoreMqttManager('src-a', 'Feed A', { brokerUrl: 'wss://a.example', region: 'MCO' });
    await mgrA.start();
    const clientA = clients.get(creationOrder[0])!;

    const mgrB = new MeshCoreMqttManager('src-b', 'Feed B', { brokerUrl: 'wss://b.example', region: 'MCO' });
    await mgrB.start();
    const clientB = clients.get(creationOrder[1])!;

    clientA.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX));
    clientB.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX));
    await settle();

    expect(recordReception).toHaveBeenCalledTimes(1);
    expect(recordReception.mock.calls[0][0].sourceId).toBe('src-a');
  });
});
