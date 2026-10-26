/**
 * Live packet traffic (#4835): a MeshCore `ota_packet` raises a
 * `packet:flight` BEFORE the Packet Monitor gate, so it works with
 * `meshcore_packet_log_enabled` off, and only while a map watches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const isEnabled = vi.fn().mockResolvedValue(false);
const logPacket = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: { meshcore: {} },
}));

vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: {
    isEnabled: (...args: unknown[]) => isEnabled(...args),
    logPacket: (...args: unknown[]) => logPacket(...args),
  },
}));

import { MeshCoreManager } from './meshcoreManager.js';
import { dataEventEmitter, type DataEvent } from './services/dataEventEmitter.js';
import { watchPacketFlights, resetPacketFlightWatchers } from './services/packetFlightWatchers.js';

const LOCAL_KEY = 'ab'.repeat(32);

// FLOOD | TXT_MSG, path_len 0x02 (1-byte hashes, 2 hops: a3, 7f),
// dest hash cd, src hash ef, then ciphertext.
const TXT_FLOOD = {
  payload_type: 0x02,
  payload_type_string: 'TXT_MSG',
  route_type: 0x01,
  route_type_string: 'FLOOD',
  path_len_raw: 0x02,
  hop_count: 2,
  path_hops: ['a3', '7f'],
  snr: 6.25,
  rssi: -42,
  payload_size: 8,
  raw_hex: '0902a37fcdefdeadbeef',
};

function dispatch(m: MeshCoreManager, data: Record<string, unknown>): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent({ event_type: 'ota_packet', data });
}

function makeManager(): MeshCoreManager {
  const m = new MeshCoreManager('mc-a');
  (m as any).localNode = { publicKey: LOCAL_KEY, name: 'Local' };
  return m;
}

describe('MeshCoreManager: packet:flight (#4835)', () => {
  let events: DataEvent[];
  const listener = (e: DataEvent) => events.push(e);

  beforeEach(() => {
    events = [];
    isEnabled.mockClear();
    logPacket.mockClear();
    resetPacketFlightWatchers();
    dataEventEmitter.on('data', listener);
  });
  afterEach(() => {
    dataEventEmitter.off('data', listener);
    resetPacketFlightWatchers();
  });

  const flights = () => events.filter((e) => e.type === 'packet:flight').map((e) => e.data as any);

  it('emits a flight with packet logging off, and stores nothing', async () => {
    watchPacketFlights('sock-1', 'mc-a');
    dispatch(makeManager(), { ...TXT_FLOOD });
    await Promise.resolve();
    expect(flights()).toEqual([{
      sourceId: 'mc-a',
      protocol: 'meshcore',
      receivedAt: expect.any(Number),
      from: 'ef',
      to: LOCAL_KEY,
      relay: '7f',
      hopsUsed: 2,
      kind: 'TXT_MSG',
      snr: 6.25,
      rssi: -42,
    }]);
    expect(logPacket).not.toHaveBeenCalled();
    // The raw frame never rides along.
    expect(JSON.stringify(flights())).not.toContain('deadbeef');
  });

  it('emits nothing while no map watches the source', async () => {
    dispatch(makeManager(), { ...TXT_FLOOD });
    await Promise.resolve();
    expect(flights()).toHaveLength(0);
  });

  it('skips a frame with neither a sender nor a last hop', async () => {
    watchPacketFlights('sock-1', 'mc-a');
    // DIRECT (0x02) | GRP_TXT (0x05 << 2): no hops, sender encrypted.
    dispatch(makeManager(), {
      payload_type: 0x05, route_type: 0x02, hop_count: 0, path_hops: [], raw_hex: '16' + '00' + '11223344556677',
    });
    await Promise.resolve();
    expect(flights()).toHaveLength(0);
  });
});
