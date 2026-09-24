/**
 * coverageMapGrouping (#5277 Phase 2 WP4) — pure cross-source collapse
 * helpers behind CoverageMap. See COVERAGE_P2_SPEC.md §2.9 / Decision D7.
 */
import { describe, it, expect } from 'vitest';
import {
  dedupeReceiverMarkers,
  buildDedupedReceiverIndex,
  collapseFixReceptionsBySource,
  physicalReceiverKey,
} from './coverageMapGrouping';
import { receiverKey } from './coverageReceiverFilter';
import type { CoverageReceiverDto, CoverageReceptionDto } from '../types/coverage';

function receiver(overrides: Partial<CoverageReceiverDto>): CoverageReceiverDto {
  return {
    sourceId: 'src-a',
    sourceName: 'Source A',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    longName: 'Receiver One',
    shortName: 'R1',
    latitude: 26.1,
    longitude: -80.2,
    lastReceivedAt: 1,
    receptionCount: 10,
    ...overrides,
  };
}

function reception(overrides: Partial<CoverageReceptionDto>): CoverageReceptionDto {
  return {
    id: 1,
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    receiverLatitude: 26.1,
    receiverLongitude: -80.2,
    senderId: '!bbbbbbbb',
    senderNodeNum: 2,
    packetKey: '100',
    packetId: 100,
    pathKey: 'r0:h0',
    latitude: 26.15,
    longitude: -80.25,
    altitude: null,
    precisionBits: null,
    snr: 5,
    rssi: -80,
    hopStart: 0,
    hopLimit: 0,
    hopsAway: 0,
    relayNode: 0,
    transportMechanism: null,
    channel: 0,
    rxTime: 1_700_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('physicalReceiverKey', () => {
  it('combines kind and id', () => {
    expect(physicalReceiverKey('mqtt_gateway', '!abc')).toBe('mqtt_gateway|!abc');
  });
});

describe('dedupeReceiverMarkers', () => {
  it('merges the same gateway seen through two sources into one marker', () => {
    const receivers = [
      receiver({
        sourceId: 'src-a', receiverKind: 'mqtt_gateway', receiverId: '!gw1',
        latitude: 26.1, longitude: -80.2, lastReceivedAt: 100, longName: 'Old Snapshot',
      }),
      receiver({
        sourceId: 'src-b', receiverKind: 'mqtt_gateway', receiverId: '!gw1',
        latitude: 26.11, longitude: -80.21, lastReceivedAt: 200, longName: 'New Snapshot',
      }),
    ];
    const markers = dedupeReceiverMarkers(receivers);
    expect(markers).toHaveLength(1);
    expect(markers[0].key).toBe('mqtt_gateway|!gw1');
    expect(markers[0].label).toBe('New Snapshot');
    expect(markers[0].lastReceivedAt).toBe(200);
    expect(markers[0].sourceIds.sort()).toEqual(['src-a', 'src-b']);
  });

  it('keeps a positioned row over a newer unpositioned one', () => {
    const receivers = [
      receiver({
        sourceId: 'src-a', receiverKind: 'mqtt_gateway', receiverId: '!gw1',
        latitude: 26.1, longitude: -80.2, lastReceivedAt: 100,
      }),
      receiver({
        sourceId: 'src-b', receiverKind: 'mqtt_gateway', receiverId: '!gw1',
        latitude: null, longitude: null, lastReceivedAt: 999,
      }),
    ];
    const markers = dedupeReceiverMarkers(receivers);
    expect(markers).toHaveLength(1);
    expect(markers[0].latitude).toBe(26.1);
  });

  it('drops a physical receiver with no positioned row anywhere', () => {
    const receivers = [
      receiver({ receiverId: '!nopos', latitude: null, longitude: null }),
    ];
    expect(dedupeReceiverMarkers(receivers)).toHaveLength(0);
  });

  it('keeps distinct receiverIds separate, and local vs gateway of the same id separate', () => {
    const receivers = [
      receiver({ receiverKind: 'local', receiverId: '!x' }),
      receiver({ receiverKind: 'mqtt_gateway', receiverId: '!x' }),
    ];
    const markers = dedupeReceiverMarkers(receivers);
    expect(markers.map((m) => m.key).sort()).toEqual(['local|!x', 'mqtt_gateway|!x']);
  });
});

describe('buildDedupedReceiverIndex', () => {
  it('indexes markers by physical key', () => {
    const markers = dedupeReceiverMarkers([receiver({ receiverKind: 'mqtt_gateway', receiverId: '!gw1' })]);
    const index = buildDedupedReceiverIndex(markers);
    expect(index.get('mqtt_gateway|!gw1')?.receiverId).toBe('!gw1');
  });
});

describe('collapseFixReceptionsBySource', () => {
  it('collapses receptions sharing kind|id|pathKey across sources into one line', () => {
    const receptions = [
      reception({ id: 1, sourceId: 'src-a', receiverKind: 'mqtt_gateway', receiverId: '!gw1', pathKey: 'r0:h0', snr: 4 }),
      reception({ id: 2, sourceId: 'src-b', receiverKind: 'mqtt_gateway', receiverId: '!gw1', pathKey: 'r0:h0', snr: 7 }),
    ];
    const names = new Map([
      [receiverKey('src-a', '!gw1'), 'Source A'],
      [receiverKey('src-b', '!gw1'), 'Source B'],
    ]);

    const collapsed = collapseFixReceptionsBySource(receptions, names);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].sourceLabels).toEqual(['Source A', 'Source B']);
    // Best = highest SNR among the collapsed rows.
    expect(collapsed[0].best.id).toBe(2);
  });

  it('keeps a different pathKey as its own line', () => {
    const receptions = [
      reception({ id: 1, receiverKind: 'mqtt_gateway', receiverId: '!gw1', pathKey: 'r0:h0' }),
      reception({ id: 2, receiverKind: 'mqtt_gateway', receiverId: '!gw1', pathKey: 'r1:h2' }),
    ];
    const collapsed = collapseFixReceptionsBySource(receptions, new Map());
    expect(collapsed).toHaveLength(2);
  });

  it('a local receiver (single source) collapses to one line with one label', () => {
    const receptions = [reception({ id: 1, receiverKind: 'local', receiverId: '!aaaaaaaa', pathKey: 'r0:h0' })];
    const names = new Map([[receiverKey('src-a', '!aaaaaaaa'), 'Source A']]);
    const collapsed = collapseFixReceptionsBySource(receptions, names);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].sourceLabels).toEqual(['Source A']);
  });

  it('falls back to the sourceId when no name is known', () => {
    const receptions = [reception({ id: 1, sourceId: 'src-x' })];
    const collapsed = collapseFixReceptionsBySource(receptions, new Map());
    expect(collapsed[0].sourceLabels).toEqual(['src-x']);
  });

  it('ties on null SNR break deterministically by sourceId', () => {
    const receptions = [
      reception({ id: 1, sourceId: 'src-b', receiverKind: 'mqtt_gateway', receiverId: '!gw1', pathKey: 'r0:h0', snr: null }),
      reception({ id: 2, sourceId: 'src-a', receiverKind: 'mqtt_gateway', receiverId: '!gw1', pathKey: 'r0:h0', snr: null }),
    ];
    const collapsed = collapseFixReceptionsBySource(receptions, new Map());
    expect(collapsed[0].best.sourceId).toBe('src-a');
  });
});
