/**
 * Tests for MeshCoreManager's handling of `ota_packet` bridge events (the
 * MeshCore Packet Monitor capture path).
 *
 * Capture is opt-in: a packet is only persisted/broadcast when
 * `meshcore_packet_log_enabled` is on. When off, the handler is a no-op.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const isEnabled = vi.fn();
const logPacket = vi.fn().mockResolvedValue(undefined);
const emitMeshCoreOtaPacket = vi.fn();

vi.mock('../services/database.js', () => ({
  default: { meshcore: {} },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreOtaPacket: (...args: unknown[]) => emitMeshCoreOtaPacket(...args),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreContactUpdated: vi.fn(),
  },
}));

vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: {
    isEnabled: (...args: unknown[]) => isEnabled(...args),
    logPacket: (...args: unknown[]) => logPacket(...args),
  },
}));

import { MeshCoreManager } from './meshcoreManager.js';

interface BridgeEvent {
  event_type: string;
  data: Record<string, unknown>;
}

function dispatch(m: MeshCoreManager, evt: BridgeEvent): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent(evt);
}

const SAMPLE = {
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MeshCoreManager — ota_packet capture gate', () => {
  beforeEach(() => {
    isEnabled.mockReset();
    logPacket.mockClear();
    emitMeshCoreOtaPacket.mockClear();
  });

  it('does nothing when capture is disabled', async () => {
    isEnabled.mockResolvedValue(false);
    const m = new MeshCoreManager('src-a');
    dispatch(m, { event_type: 'ota_packet', data: { ...SAMPLE } });
    await flush();
    expect(logPacket).not.toHaveBeenCalled();
    expect(emitMeshCoreOtaPacket).not.toHaveBeenCalled();
  });

  it('persists and broadcasts a source-stamped packet when enabled', async () => {
    isEnabled.mockResolvedValue(true);
    const m = new MeshCoreManager('src-a');
    dispatch(m, { event_type: 'ota_packet', data: { ...SAMPLE } });
    await flush();

    expect(logPacket).toHaveBeenCalledTimes(1);
    const persisted = logPacket.mock.calls[0][0];
    expect(persisted).toMatchObject({
      sourceId: 'src-a',
      payloadType: 0x02,
      payloadTypeName: 'TXT_MSG',
      routeType: 0x01,
      routeTypeName: 'FLOOD',
      pathLenRaw: 0x02,
      hopCount: 2,
      pathHops: 'a3,7f',
      snr: 6.25,
      rssi: -42,
      payloadSize: 24,
      rawHex: 'deadbeef',
    });
    expect(typeof persisted.timestamp).toBe('number');

    expect(emitMeshCoreOtaPacket).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreOtaPacket).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'src-a' }), 'src-a');
  });

  it('stores null pathHops for a direct packet with no relay chain', async () => {
    isEnabled.mockResolvedValue(true);
    const m = new MeshCoreManager('src-a');
    dispatch(m, {
      event_type: 'ota_packet',
      data: { ...SAMPLE, path_hops: [], hop_count: 0, path_len_raw: 0xff },
    });
    await flush();
    expect(logPacket.mock.calls[0][0].pathHops).toBeNull();
    expect(logPacket.mock.calls[0][0].hopCount).toBe(0);
  });
});
