/** Walkabout CSV / GeoJSON / JSON builders (#6573). */
import { describe, it, expect } from 'vitest';
import {
  WALKABOUT_SAMPLE_COLUMNS,
  buildWalkaboutCsv,
  buildWalkaboutGeoJson,
  buildWalkaboutJson,
  walkaboutExportFilename,
} from './walkaboutExport.js';
import { parseCsv } from './csvParse.js';
import type { WalkaboutExportDoc } from '../types/walkabout.js';

const T0 = Date.UTC(2026, 10, 26, 10);

const doc: WalkaboutExportDoc = {
  meshmonitor: { format: 'meshmonitor-walkabout', version: 1, exportedAt: T0 + 9e6, hiddenReceptionCount: 3, truncated: false },
  sessions: [
    {
      name: '=HYPERLINK("x"), park',
      startedAt: T0,
      endedAt: T0 + 60_000,
      endReason: 'user',
      samples: [
        { id: 2, latitude: 40.2, longitude: -105.2, accuracyM: 8, deviceFixAt: T0 + 6000, fixAt: T0 + 6000, receivedAt: T0 + 6100 },
        { id: 1, latitude: 40.1, longitude: -105.1, accuracyM: 5, deviceFixAt: T0, fixAt: T0 + 500, receivedAt: T0 + 600 },
      ],
      receptions: [
        {
          protocol: 'meshtastic', creditedKey: '!aabbccdd', creditedNodeNum: 0xaabbccdd, creditKind: 'direct', hopsAway: 0,
          packetKey: 'aabbccdd:1', snr: -3, rssi: -100, heardAt: T0 + 700, sampleId: 1, latitude: 40.1, longitude: -105.1,
          accuracyM: 5, sampleAgeMs: 200, longName: 'Alpha', shortName: 'AL',
        },
        {
          protocol: 'meshtastic', creditedKey: '!aabbccdd', creditedNodeNum: 0xaabbccdd, creditKind: 'direct', hopsAway: 0,
          packetKey: 'aabbccdd:2', snr: 4, rssi: -95, heardAt: T0 + 800, sampleId: 1, latitude: 40.1, longitude: -105.1,
          accuracyM: 5, sampleAgeMs: 300, longName: 'Alpha', shortName: 'AL',
        },
        {
          protocol: 'meshtastic', creditedKey: '!00000001', creditedNodeNum: 1, creditKind: 'relay', hopsAway: 1,
          packetKey: '00000002:3', snr: null, rssi: null, heardAt: T0 + 900, sampleId: null, latitude: 40.1, longitude: -105.1,
          accuracyM: 5, sampleAgeMs: 400,
        },
      ],
    },
  ],
};

describe('walkabout export builders', () => {
  it('JSON is the doc, marker first', () => {
    const text = buildWalkaboutJson(doc);
    expect(JSON.parse(text)).toEqual(doc);
    expect(text.indexOf('"meshmonitor"')).toBeLessThan(text.indexOf('"sessions"'));
  });

  it('CSV: one row per sample in fix order, with what was heard there; formula-guarded text', () => {
    const { records } = parseCsv(buildWalkaboutCsv(doc));
    expect(records[0]).toEqual([...WALKABOUT_SAMPLE_COLUMNS]);
    const rows = records.slice(1).filter((r) => r.length > 1);
    expect(rows).toHaveLength(2);
    const col = (r: string[], c: (typeof WALKABOUT_SAMPLE_COLUMNS)[number]) => r[WALKABOUT_SAMPLE_COLUMNS.indexOf(c)];
    expect(col(rows[0], 'fixAtMs')).toBe(String(T0 + 500));
    expect(col(rows[0], 'receptionCount')).toBe('2');
    expect(col(rows[0], 'nodeCount')).toBe('1');
    expect(col(rows[0], 'bestSnr')).toBe('4');
    expect(col(rows[0], 'bestRssi')).toBe('-95');
    expect(col(rows[0], 'heardNodes')).toBe('Alpha');
    expect(col(rows[0], 'sessionName')).toBe(`'=HYPERLINK("x"), park`);
    expect(col(rows[1], 'receptionCount')).toBe('0');
    expect(col(rows[1], 'bestSnr')).toBe('');
  });

  it('GeoJSON: a Point per sample plus the track, with the hidden count', () => {
    const g = JSON.parse(buildWalkaboutGeoJson(doc));
    expect(g.type).toBe('FeatureCollection');
    expect(g.meshmonitor).toMatchObject({ format: 'meshmonitor-walkabout-samples', hiddenReceptionCount: 3 });
    const points = g.features.filter((f: { properties: { kind: string } }) => f.properties.kind === 'sample');
    expect(points).toHaveLength(2);
    expect(points[0].geometry.coordinates).toEqual([-105.1, 40.1]);
    expect(points[0].properties).toMatchObject({ receptionCount: 2, bestSnr: 4 });
    const track = g.features.find((f: { properties: { kind: string } }) => f.properties.kind === 'track');
    expect(track.geometry).toEqual({ type: 'LineString', coordinates: [[-105.1, 40.1], [-105.2, 40.2]] });
  });

  it('filenames', () => {
    expect(walkaboutExportFilename('json', T0)).toBe('walkabout_20261126T100000Z.json');
    expect(walkaboutExportFilename('geojson', T0)).toMatch(/\.geojson$/);
  });
});
