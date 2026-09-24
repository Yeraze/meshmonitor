/**
 * Tests for MeshCoreManager's Coverage Report recording hook on the
 * companion `ota_packet` path (#5277 P3, §2.3, §3 "Recording").
 *
 * The hook records ALWAYS (D8) — independent of the opt-in
 * `meshcore_packet_log_enabled` packet monitor, which this suite
 * deliberately leaves OFF throughout to prove the two are decoupled.
 *
 * `GOLDEN_ZERO_HOP_RAW_HEX` is the same genuinely Ed25519-signed advert
 * fixture used in `coverageMeshCore.test.ts` — see that file's header
 * comment for provenance. A real signature is required here because
 * `maybeRecordMeshCoreCoverageReception` verifies it before recording.
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

// Real `sourceManagerRegistry` is unused by the 'local' receiverKind path
// (only the Observer own-key check reads it), but mocked anyway so this
// suite never depends on cross-file singleton state.
vi.mock('./utils/ownNodes.js', () => ({
  isOwnPublicKey: vi.fn().mockReturnValue(false),
}));

import { MeshCoreManager } from './meshcoreManager.js';
import { __resetCoverageMeshCoreForTest } from './utils/coverageMeshCore.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';

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

const GOLDEN_PUBLIC_KEY = 'f3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0';
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

const NON_ADVERT_SAMPLE = {
  payload_type: 0x02,
  payload_type_string: 'TXT_MSG',
  route_type: 0x01,
  route_type_string: 'FLOOD',
  path_len_raw: 0x02,
  hop_count: 2,
  path_hops: ['a3', '7f'],
  snr: 6.25,
  rssi: -42,
  payload_size: 24,
  raw_hex: 'deadbeef',
};

const RECEIVER = 'b'.repeat(64);

describe('MeshCoreManager — Coverage Report recording (#5277 P3, D8: always on)', () => {
  beforeEach(() => {
    recordReception.mockClear();
    __resetCoverageMeshCoreForTest();
    (meshcorePacketLogService.isEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  it('records a reception for an ADVERT ota_packet with the packet log OFF', async () => {
    const m = new MeshCoreManager('src-a');
    (m as any).localNode = { publicKey: RECEIVER, latitude: 10, longitude: 20 };

    dispatch(m, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    await flush();

    expect(recordReception).toHaveBeenCalledTimes(1);
    const row = recordReception.mock.calls[0][0];
    expect(row).toMatchObject({
      sourceId: 'src-a',
      protocol: 'meshcore',
      receiverKind: 'local',
      receiverId: RECEIVER,
      senderId: GOLDEN_PUBLIC_KEY,
      pathKey: 'h0:-',
      hopsAway: 0,
      snr: 6.25,
      rssi: -42,
      latitude: 37.7749,
      longitude: -122.4194,
      receiverLatitude: 10,
      receiverLongitude: 20,
    });
    // Confirms D8: recorded even though the packet monitor never turned on.
    expect(meshcorePacketLogService.logPacket).not.toHaveBeenCalled();
  });

  it('also records when the packet log is ON (independent settings)', async () => {
    (meshcorePacketLogService.isEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const m = new MeshCoreManager('src-a');
    (m as any).localNode = { publicKey: RECEIVER, latitude: 10, longitude: 20 };

    dispatch(m, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    await flush();

    expect(recordReception).toHaveBeenCalledTimes(1);
    expect(meshcorePacketLogService.logPacket).toHaveBeenCalledTimes(1);
  });

  it('a non-advert packet does not record a Coverage reception', async () => {
    const m = new MeshCoreManager('src-a');
    (m as any).localNode = { publicKey: RECEIVER, latitude: 10, longitude: 20 };

    dispatch(m, { event_type: 'ota_packet', data: { ...NON_ADVERT_SAMPLE } });
    await flush();

    expect(recordReception).not.toHaveBeenCalled();
  });

  it('our own advert relayed back to us is not recorded (own-advert)', async () => {
    const m = new MeshCoreManager('src-a');
    (m as any).localNode = { publicKey: GOLDEN_PUBLIC_KEY, latitude: 10, longitude: 20 };

    dispatch(m, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    await flush();

    expect(recordReception).not.toHaveBeenCalled();
  });

  it('does nothing when localNode is null (not yet connected)', async () => {
    const m = new MeshCoreManager('src-a');
    // localNode defaults to null.

    dispatch(m, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    await flush();

    expect(recordReception).not.toHaveBeenCalled();
  });

  it('a coverageReceptions.recordReception throw does not stop the ota_packet re-emit or the packet monitor', async () => {
    (meshcorePacketLogService.isEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    recordReception.mockRejectedValueOnce(new Error('db down'));
    const m = new MeshCoreManager('src-a');
    (m as any).localNode = { publicKey: RECEIVER, latitude: 10, longitude: 20 };

    const seen: unknown[] = [];
    m.on('ota_packet', (d) => seen.push(d));

    await expect(async () => {
      dispatch(m, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
      await flush();
    }).not.toThrow();

    expect(seen).toHaveLength(1);
    expect(meshcorePacketLogService.logPacket).toHaveBeenCalledTimes(1);
  });

  it('never emits on dataEventEmitter beyond the existing packet-monitor emit', async () => {
    (meshcorePacketLogService.isEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const dataEventEmitterModule = await import('./services/dataEventEmitter.js');
    const emitSpy = dataEventEmitterModule.dataEventEmitter.emitMeshCoreOtaPacket as ReturnType<typeof vi.fn>;
    emitSpy.mockClear();

    const m = new MeshCoreManager('src-a');
    (m as any).localNode = { publicKey: RECEIVER, latitude: 10, longitude: 20 };

    dispatch(m, { event_type: 'ota_packet', data: { ...ADVERT_SAMPLE } });
    await flush();

    // Exactly the one pre-existing packet-monitor emit — Coverage recording
    // adds no event of its own.
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });
});
