import { describe, it, expect } from 'vitest';
import {
  buildFavoriteRetentions,
  sourceIdFromSettingKey,
  FAVORITE_STORAGE_DAYS_MIN,
  FAVORITE_STORAGE_DAYS_MAX,
} from './telemetryRetention';
import {
  TRANSPORT_NODES_HEARD_TYPE,
  TRANSPORT_PACKETS_RX_TYPE,
  TRANSPORT_SERIES_TYPES,
} from './transportSeries';
import { PACKET_RATE_RX_TYPE, PACKET_RATE_TX_TYPE } from '../components/PacketRateGraphs';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const favJson = (nodeId: string, telemetryType: string) =>
  JSON.stringify([{ nodeId, telemetryType }]);

describe('sourceIdFromSettingKey', () => {
  it('extracts the source id from a per-source key', () => {
    expect(sourceIdFromSettingKey('source:abc:telemetryFavorites', 'telemetryFavorites')).toBe('abc');
  });

  it('returns null for the global key', () => {
    expect(sourceIdFromSettingKey('telemetryFavorites', 'telemetryFavorites')).toBeNull();
  });

  it('returns null for a different per-source key', () => {
    expect(sourceIdFromSettingKey('source:abc:maxNodeAgeHours', 'telemetryFavorites')).toBeNull();
  });

  it('keeps a colon inside the source id intact', () => {
    expect(
      sourceIdFromSettingKey('source:mqtt:eu:868:telemetryFavorites', 'telemetryFavorites')
    ).toBe('mqtt:eu:868');
  });

  it('returns null for an empty source id', () => {
    expect(sourceIdFromSettingKey('source::telemetryFavorites', 'telemetryFavorites')).toBeNull();
  });
});

describe('buildFavoriteRetentions (#5080)', () => {
  it('reads favorites out of the per-source namespace', () => {
    const retentions = buildFavoriteRetentions(
      {
        'source:src-a:telemetryFavorites': favJson('!aabbccdd', 'batteryLevel'),
        'source:src-a:favoriteTelemetryStorageDays': '90',
      },
      NOW,
      7
    );

    expect(retentions).toEqual([
      {
        sourceId: 'src-a',
        nodeId: '!aabbccdd',
        telemetryType: 'batteryLevel',
        cutoffTimestamp: NOW - 90 * DAY,
      },
    ]);
  });

  it('gives each source its own retention window', () => {
    const retentions = buildFavoriteRetentions(
      {
        'source:src-a:telemetryFavorites': favJson('!aabbccdd', 'batteryLevel'),
        'source:src-a:favoriteTelemetryStorageDays': '90',
        'source:src-b:telemetryFavorites': favJson('!11223344', 'voltage'),
        'source:src-b:favoriteTelemetryStorageDays': '14',
      },
      NOW,
      7
    );

    const byId = new Map(retentions.map((r) => [r.sourceId, r.cutoffTimestamp]));
    expect(byId.get('src-a')).toBe(NOW - 90 * DAY);
    expect(byId.get('src-b')).toBe(NOW - 14 * DAY);
  });

  it('falls back to the global storage-days value, then to the caller default', () => {
    const withGlobal = buildFavoriteRetentions(
      {
        favoriteTelemetryStorageDays: '30',
        'source:src-a:telemetryFavorites': favJson('!aabbccdd', 'batteryLevel'),
      },
      NOW,
      7
    );
    expect(withGlobal[0].cutoffTimestamp).toBe(NOW - 30 * DAY);

    const withoutGlobal = buildFavoriteRetentions(
      { 'source:src-a:telemetryFavorites': favJson('!aabbccdd', 'batteryLevel') },
      NOW,
      21
    );
    expect(withoutGlobal[0].cutoffTimestamp).toBe(NOW - 21 * DAY);
  });

  it('keeps a legacy global favorites list, unscoped so it matches any source', () => {
    const retentions = buildFavoriteRetentions(
      {
        telemetryFavorites: favJson('!aabbccdd', 'batteryLevel'),
        favoriteTelemetryStorageDays: '45',
      },
      NOW,
      7
    );

    expect(retentions).toHaveLength(1);
    expect(retentions[0].sourceId).toBeUndefined();
    expect(retentions[0].cutoffTimestamp).toBe(NOW - 45 * DAY);
  });

  it('clamps storage days to the range the Settings UI enforces', () => {
    const tooBig = buildFavoriteRetentions(
      {
        'source:s:telemetryFavorites': favJson('!a', 'x'),
        'source:s:favoriteTelemetryStorageDays': '3650',
      },
      NOW,
      7
    );
    expect(tooBig[0].cutoffTimestamp).toBe(NOW - FAVORITE_STORAGE_DAYS_MAX * DAY);

    const tooSmall = buildFavoriteRetentions(
      {
        'source:s:telemetryFavorites': favJson('!a', 'x'),
        'source:s:favoriteTelemetryStorageDays': '0',
      },
      NOW,
      7
    );
    expect(tooSmall[0].cutoffTimestamp).toBe(NOW - FAVORITE_STORAGE_DAYS_MIN * DAY);
  });

  it('ignores malformed or non-array favorites payloads', () => {
    expect(
      buildFavoriteRetentions({ 'source:s:telemetryFavorites': 'not json' }, NOW, 7)
    ).toEqual([]);
    expect(
      buildFavoriteRetentions({ 'source:s:telemetryFavorites': '{"nodeId":"!a"}' }, NOW, 7)
    ).toEqual([]);
    expect(
      buildFavoriteRetentions({ 'source:s:telemetryFavorites': '[{"nodeId":5}]' }, NOW, 7)
    ).toEqual([]);
    expect(buildFavoriteRetentions({ 'source:s:telemetryFavorites': '' }, NOW, 7)).toEqual([]);
  });

  it('ignores unrelated per-source settings keys', () => {
    expect(
      buildFavoriteRetentions(
        { 'source:s:maxNodeAgeHours': '24', maxNodeAgeHours: '24' },
        NOW,
        7
      )
    ).toEqual([]);
  });
});

describe('buildFavoriteRetentions — pseudo favorite expansion (#5101 P3 D7)', () => {
  it('expands a per-source transportNodesHeard favorite into its 3 component types', () => {
    const retentions = buildFavoriteRetentions(
      {
        'source:src-a:telemetryFavorites': favJson('!aabbccdd', TRANSPORT_NODES_HEARD_TYPE),
        'source:src-a:favoriteTelemetryStorageDays': '90',
      },
      NOW,
      7
    );

    expect(retentions).toHaveLength(3);
    const types = retentions.map((r) => r.telemetryType).sort();
    expect(types).toEqual(
      [
        TRANSPORT_SERIES_TYPES.nodesHeard.rf,
        TRANSPORT_SERIES_TYPES.nodesHeard.udp,
        TRANSPORT_SERIES_TYPES.nodesHeard.mqtt,
      ].sort()
    );
    for (const r of retentions) {
      expect(r.sourceId).toBe('src-a');
      expect(r.nodeId).toBe('!aabbccdd');
      expect(r.cutoffTimestamp).toBe(NOW - 90 * DAY);
    }
  });

  it('expands a per-source transportPacketsRx favorite into its 3 component types', () => {
    const retentions = buildFavoriteRetentions(
      { 'source:src-a:telemetryFavorites': favJson('!aabbccdd', TRANSPORT_PACKETS_RX_TYPE) },
      NOW,
      7
    );
    const types = retentions.map((r) => r.telemetryType).sort();
    expect(types).toEqual(
      [
        TRANSPORT_SERIES_TYPES.packetsRx.rf,
        TRANSPORT_SERIES_TYPES.packetsRx.udp,
        TRANSPORT_SERIES_TYPES.packetsRx.mqtt,
      ].sort()
    );
  });

  it('expands the existing packetRateRx favorite into its component types (fixes the long-standing 7-day purge bug)', () => {
    const retentions = buildFavoriteRetentions(
      {
        'source:src-a:telemetryFavorites': favJson('!aabbccdd', PACKET_RATE_RX_TYPE),
        'source:src-a:favoriteTelemetryStorageDays': '60',
      },
      NOW,
      7
    );
    const types = retentions.map((r) => r.telemetryType).sort();
    expect(types).toEqual(['numPacketsRx', 'numPacketsRxBad', 'numRxDupe'].sort());
    for (const r of retentions) {
      expect(r.cutoffTimestamp).toBe(NOW - 60 * DAY);
    }
  });

  it('expands the existing packetRateTx favorite into its component types', () => {
    const retentions = buildFavoriteRetentions(
      { 'source:src-a:telemetryFavorites': favJson('!aabbccdd', PACKET_RATE_TX_TYPE) },
      NOW,
      7
    );
    const types = retentions.map((r) => r.telemetryType).sort();
    expect(types).toEqual(['numPacketsTx', 'numTxDropped', 'numTxRelay', 'numTxRelayCanceled'].sort());
  });

  it('expands a legacy global pseudo-favorite the same way as a per-source one', () => {
    const retentions = buildFavoriteRetentions(
      {
        telemetryFavorites: favJson('!aabbccdd', TRANSPORT_NODES_HEARD_TYPE),
        favoriteTelemetryStorageDays: '45',
      },
      NOW,
      7
    );
    expect(retentions).toHaveLength(3);
    for (const r of retentions) {
      expect(r.sourceId).toBeUndefined();
      expect(r.cutoffTimestamp).toBe(NOW - 45 * DAY);
    }
  });

  it('leaves an ordinary (non-pseudo) favorite type unexpanded', () => {
    const retentions = buildFavoriteRetentions(
      { 'source:src-a:telemetryFavorites': favJson('!aabbccdd', 'batteryLevel') },
      NOW,
      7
    );
    expect(retentions).toHaveLength(1);
    expect(retentions[0].telemetryType).toBe('batteryLevel');
  });
});
