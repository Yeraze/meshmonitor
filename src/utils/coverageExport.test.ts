import { describe, it, expect } from 'vitest';
import { buildCoverageCsv, buildCoverageGeoJson, coverageExportFilename } from './coverageExport.js';
import type { CoverageReceptionDto } from '../types/coverage.js';
import type { CoverageExportContext, CoverageGap } from '../types/coverageAnalysis.js';

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

function baseCtx(overrides: Partial<CoverageExportContext> = {}): CoverageExportContext {
  return {
    senderNames: new Map(),
    receiverNames: new Map(),
    sourceNames: new Map(),
    truncated: false,
    generatedAt: 1_700_000_100_000,
    filters: {},
    ...overrides,
  };
}

describe('buildCoverageCsv', () => {
  it('emits an RFC 4180 header + one CRLF-joined row per reception', () => {
    const csv = buildCoverageCsv([reception({ id: 1, packetKey: 'p1' })], baseCtx());
    const lines = csv.split('\r\n');
    expect(lines[0].split(',')[0]).toBe('receivedAt');
    expect(lines).toHaveLength(2);
  });

  it('quotes a field containing a comma, quote, or newline per RFC 4180', () => {
    const csv = buildCoverageCsv(
      [reception({ id: 1, packetKey: 'p1', senderId: '!aaaaaaaa' })],
      baseCtx({ senderNames: new Map([['!aaaaaaaa', 'Node, "Two"\nLines']]) }),
    );
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain('"Node, ""Two""\nLines"');
  });

  it('prefixes a formula-triggering NAME with a leading apostrophe', () => {
    const csv = buildCoverageCsv(
      [reception({ id: 1, packetKey: 'p1', senderId: '!aaaaaaaa' })],
      baseCtx({ senderNames: new Map([['!aaaaaaaa', '=HYPERLINK("http://evil")']]) }),
    );
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain("'=HYPERLINK(\"http://evil\")".replace(/"/g, '""'));
  });

  it('guards every dangerous leading character: = + - @ tab CR', () => {
    for (const trigger of ['=cmd', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd']) {
      const csv = buildCoverageCsv(
        [reception({ id: 1, packetKey: 'p1', senderId: '!aaaaaaaa' })],
        baseCtx({ senderNames: new Map([['!aaaaaaaa', trigger]]) }),
      );
      const dataLine = csv.split('\r\n')[1];
      const senderNameCol = dataLine.split(',')[4]; // receivedAt,receivedAtMs,protocol,senderId,senderName
      expect(senderNameCol.startsWith("'") || senderNameCol.startsWith('"\'')).toBe(true);
    }
  });

  it('does NOT guard a numeric SNR value that happens to start with "-"', () => {
    const csv = buildCoverageCsv([reception({ id: 1, packetKey: 'p1', snr: -7.5 })], baseCtx());
    const dataLine = csv.split('\r\n')[1];
    const cols = dataLine.split(',');
    // header: receivedAt,receivedAtMs,protocol,senderId,senderName,latitude,longitude,altitude,
    //         precisionBits,sourceId,sourceName,receiverKind,receiverId,receiverName,
    //         receiverLatitude,receiverLongitude,distanceKm,snr,...
    const header = buildCoverageCsv([], baseCtx()).split('\r\n')[0].split(',');
    const snrIdx = header.indexOf('snr');
    expect(cols[snrIdx]).toBe('-7.5');
  });

  it('leaves a blank cell (not a bare "null") for null numeric fields', () => {
    const csv = buildCoverageCsv([reception({ id: 1, packetKey: 'p1', altitude: null })], baseCtx());
    const header = csv.split('\r\n')[0].split(',');
    const altIdx = header.indexOf('altitude');
    const dataLine = csv.split('\r\n')[1].split(',');
    expect(dataLine[altIdx]).toBe('');
  });

  it('computes distanceKm from the receiver snapshot position, empty when unknown', () => {
    const csv = buildCoverageCsv(
      [
        reception({ id: 1, packetKey: 'p1' }),
        reception({ id: 2, packetKey: 'p2', receiverLatitude: null, receiverLongitude: null }),
      ],
      baseCtx(),
    );
    const header = csv.split('\r\n')[0].split(',');
    const idx = header.indexOf('distanceKm');
    const rows = csv.split('\r\n').slice(1);
    expect(Number(rows[0].split(',')[idx])).toBeGreaterThan(0);
    expect(rows[1].split(',')[idx]).toBe('');
  });

  it('resolves sender/receiver/source names via the context maps, keyed by receiverKey for receivers', () => {
    const csv = buildCoverageCsv(
      [reception({ id: 1, packetKey: 'p1', sourceId: 'src-a', receiverId: '!bbbbbbbb', senderId: '!aaaaaaaa' })],
      baseCtx({
        senderNames: new Map([['!aaaaaaaa', 'Alice']]),
        receiverNames: new Map([['src-a|!bbbbbbbb', 'Repeater One']]),
        sourceNames: new Map([['src-a', 'Home TCP']]),
      }),
    );
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain('Alice');
    expect(dataLine).toContain('Repeater One');
    expect(dataLine).toContain('Home TCP');
  });
});

describe('buildCoverageGeoJson', () => {
  it('produces a valid FeatureCollection with [lon, lat] coordinate order', () => {
    const geojson = JSON.parse(
      buildCoverageGeoJson([reception({ id: 1, packetKey: 'p1', latitude: 40.5, longitude: -80.5 })], baseCtx()),
    );
    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.features).toHaveLength(1);
    const feature = geojson.features[0];
    expect(feature.type).toBe('Feature');
    expect(feature.geometry.type).toBe('Point');
    expect(feature.geometry.coordinates).toEqual([-80.5, 40.5]);
  });

  it('includes altitude as a third coordinate only when known', () => {
    const withAlt = JSON.parse(
      buildCoverageGeoJson([reception({ id: 1, packetKey: 'p1', altitude: 123 })], baseCtx()),
    );
    expect(withAlt.features[0].geometry.coordinates).toHaveLength(3);
    expect(withAlt.features[0].geometry.coordinates[2]).toBe(123);

    const withoutAlt = JSON.parse(
      buildCoverageGeoJson([reception({ id: 1, packetKey: 'p1', altitude: null })], baseCtx()),
    );
    expect(withoutAlt.features[0].geometry.coordinates).toHaveLength(2);
  });

  it('adds gaps as LineString features tagged kind=likely_gap', () => {
    const gap: CoverageGap = {
      from: { packetKey: 'p1', firstReceivedAt: 1, latitude: 40, longitude: -80 },
      to: { packetKey: 'p2', firstReceivedAt: 2, latitude: 41, longitude: -81 },
      durationSec: 150,
      distanceM: 5000,
      missedEstimate: 4,
    };
    const geojson = JSON.parse(buildCoverageGeoJson([], { ...baseCtx(), gaps: [gap] }));
    expect(geojson.features).toHaveLength(1);
    const feature = geojson.features[0];
    expect(feature.geometry.type).toBe('LineString');
    expect(feature.geometry.coordinates).toEqual([
      [-80, 40],
      [-81, 41],
    ]);
    expect(feature.properties).toEqual({
      kind: 'likely_gap',
      durationSec: 150,
      distanceM: 5000,
      missedEstimate: 4,
    });
  });

  it('carries the meshmonitor foreign member (generatedAt/truncated/filters)', () => {
    const geojson = JSON.parse(
      buildCoverageGeoJson([], baseCtx({ truncated: true, generatedAt: 42, filters: { sender: '!aaaaaaaa' } })),
    );
    expect(geojson.meshmonitor).toEqual({ generatedAt: 42, truncated: true, filters: { sender: '!aaaaaaaa' } });
  });
});

describe('coverageExportFilename', () => {
  it('builds a filesystem-safe csv filename with sender, since and until', () => {
    const name = coverageExportFilename('csv', '!aaaaaaaa', 1_700_000_000_000, 1_700_003_600_000);
    expect(name).toMatch(/^coverage_aaaaaaaa_\d{8}T\d{6}Z_\d{8}T\d{6}Z\.csv$/);
  });

  it('uses "all" when senderId is null', () => {
    const name = coverageExportFilename('geojson', null, 0, 1000);
    expect(name).toMatch(/^coverage_all_.*\.geojson$/);
  });
});
