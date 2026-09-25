import { describe, it, expect } from 'vitest';
import { median, summarizeCoverage } from './coverageSummary.js';
import type { CoverageReceptionDto } from '../types/coverage.js';

function reception(overrides: Partial<CoverageReceptionDto> & Pick<CoverageReceptionDto, 'id' | 'packetKey'>): CoverageReceptionDto {
  return {
    id: overrides.id,
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!rrrrrrrr',
    receiverNodeNum: 1,
    receiverLatitude: 40,
    receiverLongitude: -80,
    senderId: '!ssssssss',
    senderNodeNum: 2,
    packetKey: overrides.packetKey,
    packetId: 1,
    pathKey: 'r0:h0',
    latitude: 40.001,
    longitude: -80.001,
    altitude: null,
    precisionBits: 16,
    snr: 5,
    rssi: -80,
    hopStart: 0,
    hopLimit: 0,
    hopsAway: 0,
    relayNode: null,
    transportMechanism: null,
    channel: 0,
    rxTime: 1_700_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('median', () => {
  it('returns null for an empty array', () => {
    expect(median([])).toBeNull();
  });

  it('returns the single value for a 1-element array', () => {
    expect(median([7])).toBe(7);
  });

  it('returns the middle value for an odd-length array', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('ignores non-finite values', () => {
    expect(median([1, NaN, 3])).toBe(2);
  });
});

describe('summarizeCoverage', () => {
  it('returns zeros/nulls/empties for an empty input', () => {
    const summary = summarizeCoverage([]);
    expect(summary).toEqual({
      fixesHeard: 0,
      receptions: 0,
      bestSnr: null,
      worstSnr: null,
      bestRssi: null,
      worstRssi: null,
      receivers: [],
      distancePoints: [],
    });
  });

  it('counts distinct fixes (packetKey) separately from raw reception rows', () => {
    const items = [
      reception({ id: 1, packetKey: 'p1', receiverId: '!aaaaaaaa' }),
      reception({ id: 2, packetKey: 'p1', receiverId: '!bbbbbbbb' }), // same fix, second receiver
      reception({ id: 3, packetKey: 'p2', receiverId: '!aaaaaaaa' }),
    ];
    const summary = summarizeCoverage(items);
    expect(summary.fixesHeard).toBe(2);
    expect(summary.receptions).toBe(3);
  });

  it('computes best/worst SNR and RSSI, ignoring nulls', () => {
    const items = [
      reception({ id: 1, packetKey: 'p1', snr: 10, rssi: -70 }),
      reception({ id: 2, packetKey: 'p2', snr: -3, rssi: -110 }),
      reception({ id: 3, packetKey: 'p3', snr: null, rssi: null }),
    ];
    const summary = summarizeCoverage(items);
    expect(summary.bestSnr).toBe(10);
    expect(summary.worstSnr).toBe(-3);
    expect(summary.bestRssi).toBe(-70);
    expect(summary.worstRssi).toBe(-110);
  });

  it('all-null snr/rssi input yields null best/worst', () => {
    const items = [reception({ id: 1, packetKey: 'p1', snr: null, rssi: null })];
    const summary = summarizeCoverage(items);
    expect(summary.bestSnr).toBeNull();
    expect(summary.worstSnr).toBeNull();
    expect(summary.bestRssi).toBeNull();
    expect(summary.worstRssi).toBeNull();
  });

  it('builds a per-receiver breakdown keyed by sourceId|receiverId, sorted by fixesHeard desc', () => {
    const items = [
      reception({ id: 1, packetKey: 'p1', receiverId: '!aaaaaaaa', snr: 4 }),
      reception({ id: 2, packetKey: 'p2', receiverId: '!aaaaaaaa', snr: 8 }),
      reception({ id: 3, packetKey: 'p1', receiverId: '!bbbbbbbb', snr: -2 }),
    ];
    const summary = summarizeCoverage(items);
    expect(summary.receivers).toHaveLength(2);
    expect(summary.receivers[0].receiverId).toBe('!aaaaaaaa');
    expect(summary.receivers[0].fixesHeard).toBe(2);
    expect(summary.receivers[0].medianSnr).toBe(6);
    expect(summary.receivers[1].receiverId).toBe('!bbbbbbbb');
    expect(summary.receivers[1].fixesHeard).toBe(1);
    expect(summary.receivers[0].key).toBe('src-a|!aaaaaaaa');
  });

  it('furthestDirectM ignores relayed (hopsAway != 0) rows', () => {
    const items = [
      reception({ id: 1, packetKey: 'p1', hopsAway: 0, latitude: 40.01, longitude: -80.01 }),
      reception({ id: 2, packetKey: 'p2', hopsAway: 2, latitude: 41, longitude: -81 }), // relayed, far away — must be ignored
    ];
    const summary = summarizeCoverage(items);
    expect(summary.receivers[0].furthestDirectM).not.toBeNull();
    // The relayed row (much farther) must not have won.
    expect(summary.receivers[0].furthestDirectM).toBeLessThan(50_000);
  });

  it('furthestDirectM ignores rows with a null receiver position snapshot', () => {
    const items = [
      reception({ id: 1, packetKey: 'p1', hopsAway: 0, receiverLatitude: null, receiverLongitude: null }),
    ];
    const summary = summarizeCoverage(items);
    expect(summary.receivers[0].furthestDirectM).toBeNull();
  });

  it('furthestDirectM is the max distance across multiple direct receptions', () => {
    const items = [
      reception({ id: 1, packetKey: 'p1', hopsAway: 0, latitude: 40.001, longitude: -80.001 }),
      reception({ id: 2, packetKey: 'p2', hopsAway: 0, latitude: 40.1, longitude: -80.1 }),
    ];
    const summary = summarizeCoverage(items);
    const closeM = summary.receivers[0].furthestDirectM;
    // Second reception is much farther from the fixed receiver position (40, -80).
    expect(closeM).toBeGreaterThan(1000);
  });

  it('distancePoints only include 0-hop, non-null-snr, known-receiver-position rows', () => {
    const items = [
      reception({ id: 1, packetKey: 'p1', hopsAway: 0, snr: 4 }), // included
      reception({ id: 2, packetKey: 'p2', hopsAway: 1, snr: 4 }), // relayed, excluded
      reception({ id: 3, packetKey: 'p3', hopsAway: 0, snr: null }), // no snr, excluded
      reception({ id: 4, packetKey: 'p4', hopsAway: 0, snr: 4, receiverLatitude: null, receiverLongitude: null }), // no receiver snapshot, excluded
    ];
    const summary = summarizeCoverage(items);
    expect(summary.distancePoints).toHaveLength(1);
    expect(summary.distancePoints[0].snr).toBe(4);
    expect(summary.distancePoints[0].receiverKey).toBe('src-a|!rrrrrrrr');
  });
});
