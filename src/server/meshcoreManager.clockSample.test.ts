/**
 * #6273: the manager feeds passive clock samples to detectClockOffset.
 * Companion: from the raw advert stashed before the firmware push.
 * Repeater: only for an advert whose signature verified.
 * The local node's own key is never sampled from an advert.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Ed25519SignatureVerifier } from '@michaelhart/meshcore-decoder';

const detectClockOffset = vi.fn().mockResolvedValue(true);
vi.mock('./services/meshcoreDeviceHealth.js', async (orig) => ({
  ...(await orig<typeof import('./services/meshcoreDeviceHealth.js')>()),
  detectClockOffset: (...a: unknown[]) => detectClockOffset(...a),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { notificationService } from './services/notificationService.js';
import { buildAdvertFrame } from './test-helpers/meshcoreFrames.js';

const SRC_C = 'src-clock-companion';
const SRC_R = 'src-clock-repeater';
const KEY = 'ab'.repeat(32);
const SELF = 'fe'.repeat(32);
const SENDER = 1_700_000_000;

function companion(): MeshCoreManager {
  const m = new MeshCoreManager(SRC_C);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).correlateChannelEcho = vi.fn();
  (m as any).handleOtaPacket = vi.fn();
  (m as any).sendBridgeCommand = async () => ({ id: '1', success: true, data: [] });
  (m as any).nodeTriggersReady = true;
  return m;
}
const dispatch = (m: MeshCoreManager, event_type: string, data: Record<string, unknown>) =>
  (m as any).handleBridgeEvent({ event_type, data });

function repeater() {
  const m = new MeshCoreManager(SRC_R);
  const i = m as any;
  i.deviceType = MeshCoreDeviceType.REPEATER;
  i.connected = true;
  i.repeaterPublicKey = SELF;
  return (rawHex: string) => {
    i.handleSerialData(`14:02:07 - 30/9/2026 U RAW: ${rawHex.toUpperCase()}`);
    i.handleSerialData(
      `14:02:07 - 30/9/2026 U: RX, len=${rawHex.length / 2} (type=5, route=F, payload_len=1) SNR=7 RSSI=-92 score=1000 time=1 hash=00`,
    );
  };
}

describe('MeshCore manager clock samples (#6273)', () => {
  beforeEach(() => {
    detectClockOffset.mockClear();
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    vi.spyOn(meshcorePacketLogService, 'logPacket').mockResolvedValue(undefined as never);
    vi.spyOn(dataEventEmitter, 'emitMeshCoreContactUpdated').mockImplementation(() => undefined);
    vi.spyOn(dataEventEmitter, 'emitNodeDiscovered').mockImplementation(() => undefined);
    vi.spyOn(dataEventEmitter, 'emitMeshCoreNodeChanged').mockImplementation(() => undefined);
    vi.spyOn(notificationService, 'notifyNewMeshCoreNode').mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('companion: uses the sender time stashed from the raw advert when the firmware pushes it', async () => {
    const m = companion();
    const raw = buildAdvertFrame({ publicKey: KEY, name: 'Hill', advType: 2, timestamp: SENDER });
    const before = Date.now();
    dispatch(m, 'ota_packet', { payload_type: 4, raw_hex: raw });
    dispatch(m, 'contact_advertised', { public_key: KEY });
    await vi.waitFor(() => expect(detectClockOffset).toHaveBeenCalledTimes(1));
    const [tele, key, offset, source, sender, sourceId, at] = detectClockOffset.mock.calls[0];
    expect(tele).toBe(databaseService.telemetry);
    expect(key).toBe(KEY);
    expect(source).toBe('advert');
    expect(sender).toBe(SENDER);
    expect(sourceId).toBe(SRC_C);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(offset).toBe(Math.floor((at as number) / 1000) - SENDER);
  });

  it('companion: a push with no raw frame is not sampled', async () => {
    const m = companion();
    dispatch(m, 'contact_advertised', { public_key: KEY });
    await new Promise((r) => setTimeout(r, 20));
    expect(detectClockOffset).not.toHaveBeenCalled();
  });

  it('companion: never samples the local node from an advert', async () => {
    const m = companion();
    (m as any).localNode = { publicKey: KEY.toUpperCase(), name: 'me' };
    dispatch(m, 'ota_packet', { payload_type: 4, raw_hex: buildAdvertFrame({ publicKey: KEY, timestamp: SENDER }) });
    dispatch(m, 'contact_advertised', { public_key: KEY });
    await new Promise((r) => setTimeout(r, 20));
    expect(detectClockOffset).not.toHaveBeenCalled();
  });

  describe('repeater', () => {
    it('samples a verified advert', async () => {
      vi.spyOn(Ed25519SignatureVerifier, 'verifyAdvertisementSignature').mockResolvedValue(true);
      repeater()(buildAdvertFrame({ publicKey: KEY, name: 'Hill', advType: 2, timestamp: SENDER }));
      await vi.waitFor(() => expect(detectClockOffset).toHaveBeenCalledTimes(1));
      expect(detectClockOffset.mock.calls[0][1]).toBe(KEY);
      expect(detectClockOffset.mock.calls[0][3]).toBe('advert');
      expect(detectClockOffset.mock.calls[0][4]).toBe(SENDER);
      expect(detectClockOffset.mock.calls[0][5]).toBe(SRC_R);
    });

    it('ignores an advert whose signature does not verify', async () => {
      vi.spyOn(Ed25519SignatureVerifier, 'verifyAdvertisementSignature').mockResolvedValue(false);
      repeater()(buildAdvertFrame({ publicKey: KEY, name: 'Hill', advType: 2, timestamp: SENDER }));
      await new Promise((r) => setTimeout(r, 50));
      expect(detectClockOffset).not.toHaveBeenCalled();
    });

    it('never samples the repeater\'s own key', async () => {
      vi.spyOn(Ed25519SignatureVerifier, 'verifyAdvertisementSignature').mockResolvedValue(true);
      repeater()(buildAdvertFrame({ publicKey: SELF, name: 'Me', advType: 2, timestamp: SENDER }));
      await new Promise((r) => setTimeout(r, 50));
      expect(detectClockOffset).not.toHaveBeenCalled();
    });
  });
});
