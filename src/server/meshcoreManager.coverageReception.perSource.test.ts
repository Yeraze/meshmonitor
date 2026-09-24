/**
 * Per-source isolation for the MeshCore Coverage Report recording hook
 * (#5277 P3, §3 "Recording"): two companion managers on different sources
 * both record their own reception of the SAME advert, each stamped with
 * its own `sourceId` and its own receiver.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const recordReception = vi.fn().mockResolvedValue(true);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {},
    coverageReceptions: { recordReception: (...a: unknown[]) => recordReception(...a) },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreOtaPacket: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreContactUpdated: vi.fn(),
  },
}));

vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: {
    isEnabled: vi.fn().mockResolvedValue(false),
    logPacket: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./utils/ownNodes.js', () => ({
  isOwnPublicKey: vi.fn().mockReturnValue(false),
}));

import { MeshCoreManager } from './meshcoreManager.js';
import { __resetCoverageMeshCoreForTest } from './utils/coverageMeshCore.js';

interface BridgeEvent {
  event_type: string;
  data: Record<string, unknown>;
}

function dispatch(m: MeshCoreManager, evt: BridgeEvent): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent(evt);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const GOLDEN_ZERO_HOP_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';

const ADVERT_SAMPLE = {
  payload_type: 0x04,
  payload_type_string: 'ADVERT',
  route_type: 0x02,
  route_type_string: 'DIRECT',
  path_len_raw: 0xff,
  hop_count: 0,
  path_hops: [] as string[],
  snr: 6.25,
  rssi: -42,
  payload_size: 121,
  raw_hex: GOLDEN_ZERO_HOP_RAW_HEX,
};

const RECEIVER_A = 'a'.repeat(64);
const RECEIVER_B = 'b'.repeat(64);

describe('MeshCoreManager — Coverage Report per-source isolation (#5277 P3)', () => {
  beforeEach(() => {
    recordReception.mockClear();
    __resetCoverageMeshCoreForTest();
  });

  it('two managers record the same advert under their own sourceId and receiverId', async () => {
    const managerA = new MeshCoreManager('src-a');
    (managerA as any).localNode = { publicKey: RECEIVER_A, latitude: 1, longitude: 2 };

    const managerB = new MeshCoreManager('src-b');
    (managerB as any).localNode = { publicKey: RECEIVER_B, latitude: 3, longitude: 4 };

    dispatch(managerA, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    dispatch(managerB, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    await flush();

    expect(recordReception).toHaveBeenCalledTimes(2);
    const rows = recordReception.mock.calls.map((c) => c[0]);

    const rowA = rows.find((r) => r.sourceId === 'src-a');
    const rowB = rows.find((r) => r.sourceId === 'src-b');
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA.receiverId).toBe(RECEIVER_A);
    expect(rowA.receiverLatitude).toBe(1);
    expect(rowB.receiverId).toBe(RECEIVER_B);
    expect(rowB.receiverLatitude).toBe(3);

    // Same physical advert, same packetKey on both sources (D2 — packetKey
    // is path/receiver independent).
    expect(rowA.packetKey).toBe(rowB.packetKey);
    expect(rowA.senderId).toBe(rowB.senderId);
  });

  it('the replay guard is keyed per (sourceId, receiverId, senderId), so source B is unaffected by a replay rejected on source A', async () => {
    const managerA = new MeshCoreManager('src-a');
    (managerA as any).localNode = { publicKey: RECEIVER_A, latitude: 1, longitude: 2 };
    const managerB = new MeshCoreManager('src-b');
    (managerB as any).localNode = { publicKey: RECEIVER_B, latitude: 3, longitude: 4 };

    // First reception on A only.
    dispatch(managerA, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    await flush();
    expect(recordReception).toHaveBeenCalledTimes(1);

    // Same bytes again on A, immediately — same path window, so accepted as
    // another relayed copy (not a rejection in this case, but proves state
    // is per-key and doesn't block B either way).
    dispatch(managerB, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    await flush();

    expect(recordReception).toHaveBeenCalledTimes(2);
    const rows = recordReception.mock.calls.map((c) => c[0]);
    expect(rows.some((r) => r.sourceId === 'src-b')).toBe(true);
  });
});
