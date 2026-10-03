import { describe, it, expect } from 'vitest';
import { summarizeCrossSourceCoverage } from './coverageCrossSource';
import type { CoverageReceptionDto } from '../types/coverage';

let id = 0;
function rx(o: Partial<CoverageReceptionDto>): CoverageReceptionDto {
  id += 1;
  return {
    id, sourceId: 'b', protocol: 'meshtastic', receiverKind: 'local', receiverId: '!000000b0', receiverNodeNum: 0xb0,
    receiverLatitude: null, receiverLongitude: null, senderId: '!000000a0', senderNodeNum: 0xa0,
    packetKey: `p${id}`, packetId: id, pathKey: 'k', latitude: 1, longitude: 2, altitude: null, precisionBits: null,
    snr: 5, rssi: -80, hopStart: 3, hopLimit: 3, hopsAway: 0, relayNode: null, transportMechanism: 1, channel: 0,
    rxTime: null, receivedAt: 1000 + id,
    senderIsOwnSource: true, senderSourceId: 'a', crossSourceTransport: 'rf',
    ...o,
  };
}

describe('summarizeCrossSourceCoverage (#5560)', () => {
  it('ignores rows that are not cross-source', () => {
    expect(summarizeCrossSourceCoverage([rx({ senderIsOwnSource: false, senderSourceId: null })])).toEqual([]);
    expect(summarizeCrossSourceCoverage([rx({ senderIsOwnSource: undefined, senderSourceId: undefined })])).toEqual([]);
  });

  it('groups by sender source, receiving source and receiver; counts distinct fixes', () => {
    const rows = summarizeCrossSourceCoverage([
      rx({ packetKey: 'x', snr: 2 }),
      rx({ packetKey: 'x', snr: 6, pathKey: 'other' }), // same fix, second path
      rx({ packetKey: 'y', snr: 10 }),
      rx({ sourceId: 'm', receiverId: '!000000c0', receiverKind: 'mqtt_gateway', crossSourceTransport: 'mqtt_gateway', packetKey: 'x', snr: null }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      senderSourceId: 'a', sourceId: 'b', receiverId: '!000000b0', transport: 'rf',
      fixes: 2, receptions: 3, medianSnr: 6, bestSnr: 10,
    });
    expect(rows[1]).toMatchObject({
      sourceId: 'm', receiverKind: 'mqtt_gateway', transport: 'mqtt_gateway', fixes: 1, receptions: 1,
      medianSnr: null, bestSnr: null,
    });
  });

  it('tracks the newest reception time', () => {
    const rows = summarizeCrossSourceCoverage([rx({ receivedAt: 50 }), rx({ receivedAt: 900 }), rx({ receivedAt: 70 })]);
    expect(rows[0].lastReceivedAt).toBe(900);
  });
});
