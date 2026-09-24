/**
 * Coverage Report MeshCore Observer recording hook (#5277 P3, §2.3 / §3).
 *
 * Opt-in per source (U1), reusing P2's `coverage_mqtt_enabled` toggle and
 * cache/invalidation. `GOLDEN_ZERO_HOP_RAW_HEX` is the same genuinely
 * Ed25519-signed advert fixture used in `coverageMeshCore.test.ts` — a real
 * signature is required because `maybeRecordMeshCoreCoverageReception`
 * verifies it before recording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordReception = vi.fn().mockResolvedValue(true);
const upsertNode = vi.fn().mockResolvedValue(undefined);
const insertPacket = vi.fn().mockResolvedValue(undefined);
const getNodeByPublicKeyAndSource = vi.fn().mockResolvedValue(null);
const getSettingForSource = vi.fn().mockResolvedValue(null);
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

let lastClient: FakeClient | null = null;
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
vi.mock('./transports/mqttBrokerClient.js', () => ({
  MqttBrokerClient: class {
    constructor() {
      lastClient = new FakeClient();
      return lastClient as unknown as object;
    }
  },
}));

import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import { __resetCoverageMeshCoreForTest } from './utils/coverageMeshCore.js';
import { __resetCoverageMqttCacheForTest, invalidateCoverageMqttEnabled } from './services/coverageMqttSettings.js';

const OBSERVER = 'AA'.repeat(32);
const OBSERVER_LOWER = OBSERVER.toLowerCase();

const GOLDEN_PUBLIC_KEY = 'f3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0';
const GOLDEN_ZERO_HOP_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';

function body(raw: string, overrides: Record<string, unknown> = {}) {
  return { type: 'PACKET', origin: 'Obs', origin_id: OBSERVER, raw, SNR: '-6', RSSI: '-90', ...overrides };
}

async function started(sourceId = 'src-mqtt') {
  const mgr = new MeshCoreMqttManager(sourceId, 'Feed', { brokerUrl: 'wss://b.example', region: 'MCO' });
  await mgr.start();
  return mgr;
}

/** Wait out the fire-and-forget ingest promise. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  recordReception.mockClear();
  upsertNode.mockClear();
  insertPacket.mockClear();
  getNodeByPublicKeyAndSource.mockReset().mockResolvedValue(null);
  getSettingForSource.mockReset().mockResolvedValue(null);
  isOwnPublicKeyMock.mockReset().mockReturnValue(false);
  lastClient = null;
  __resetCoverageMeshCoreForTest();
  __resetCoverageMqttCacheForTest();
});

describe('MeshCoreMqttManager — Coverage Report Observer recording (#5277 P3, U1)', () => {
  it('flag off (default): no reception is recorded', async () => {
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX));
    await settle();

    expect(recordReception).not.toHaveBeenCalled();
  });

  it('flag on: records one row with the observer\'s SNR/RSSI', async () => {
    getSettingForSource.mockResolvedValue('1');
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX));
    await settle();

    expect(recordReception).toHaveBeenCalledTimes(1);
    const row = recordReception.mock.calls[0][0];
    expect(row).toMatchObject({
      sourceId: 'src-mqtt',
      protocol: 'meshcore',
      receiverKind: 'mqtt_gateway',
      receiverId: OBSERVER_LOWER,
      senderId: GOLDEN_PUBLIC_KEY,
      snr: -6,
      rssi: -90,
      pathKey: 'h0:-',
      hopsAway: 0,
      latitude: 37.7749,
      longitude: -122.4194,
    });
  });

  it('own-observer is skipped (D5): an observer that is our own companion never records', async () => {
    getSettingForSource.mockResolvedValue('1');
    isOwnPublicKeyMock.mockReturnValue(true);
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX));
    await settle();

    expect(recordReception).not.toHaveBeenCalled();
  });

  it("the observer's own receiver position comes from this source's meshcore_nodes row", async () => {
    getSettingForSource.mockResolvedValue('1');
    getNodeByPublicKeyAndSource.mockResolvedValue({ publicKey: OBSERVER_LOWER, latitude: 12.5, longitude: -34.5 });
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX));
    await settle();

    expect(recordReception).toHaveBeenCalledTimes(1);
    const row = recordReception.mock.calls[0][0];
    expect(row.receiverLatitude).toBe(12.5);
    expect(row.receiverLongitude).toBe(-34.5);
    expect(getNodeByPublicKeyAndSource).toHaveBeenCalledWith(OBSERVER_LOWER, 'src-mqtt');
  });

  it('an observer with no meshcore_nodes row records with null receiver coordinates (no marker, like a P2 gateway with no NodeInfo)', async () => {
    getSettingForSource.mockResolvedValue('1');
    getNodeByPublicKeyAndSource.mockResolvedValue(null);
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX));
    await settle();

    expect(recordReception).toHaveBeenCalledTimes(1);
    const row = recordReception.mock.calls[0][0];
    expect(row.receiverLatitude).toBeNull();
    expect(row.receiverLongitude).toBeNull();
  });

  it('a non-advert frame never reads the coverage flag', async () => {
    await started();
    // A plain FLOOD text frame: header, path_len 0, payload.
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body('0500deadbeef'));
    await settle();

    expect(getSettingForSource).not.toHaveBeenCalled();
    expect(recordReception).not.toHaveBeenCalled();
  });

  it('a flag flip applies immediately after invalidateCoverageMqttEnabled (no TTL wait)', async () => {
    getSettingForSource.mockResolvedValue(null); // off
    const mgr = await started();

    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX, { origin_id: OBSERVER }));
    await settle();
    expect(recordReception).not.toHaveBeenCalled();

    getSettingForSource.mockResolvedValue('1'); // now on
    invalidateCoverageMqttEnabled(mgr.sourceId);

    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX, { origin_id: OBSERVER }));
    await settle();
    expect(recordReception).toHaveBeenCalledTimes(1);
  });

  it('never throws when the coverage write fails', async () => {
    getSettingForSource.mockResolvedValue('1');
    recordReception.mockRejectedValueOnce(new Error('db down'));
    const mgr = await started();

    expect(() => {
      lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(GOLDEN_ZERO_HOP_RAW_HEX));
    }).not.toThrow();
    await settle();
    expect(mgr.getIngestStats().accepted).toBe(1);
  });
});
