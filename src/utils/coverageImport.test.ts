import { describe, it, expect } from 'vitest';
import {
  COVERAGE_IMPORT_COLUMNS,
  COVERAGE_IMPORT_MAX_ROWS,
  detectCoverageImportFormat,
  unguardFormulaInjection,
  validateCoverageImportRow,
  parseCoverageImport,
  coverageImportProtocolFor,
  sanitizeImportFilename,
} from './coverageImport.js';
import { COVERAGE_EXPORT_COLUMNS, buildCoverageCsv, buildCoverageGeoJson, guardFormulaInjection } from './coverageExport.js';
import type { CoverageReceptionDto } from '../types/coverage.js';
import type { CoverageExportContext, CoverageGap } from '../types/coverageAnalysis.js';

const NOW = 1_800_000_000_000;
const T0 = 1_700_000_000_000;

function dto(over: Partial<CoverageReceptionDto> = {}): CoverageReceptionDto {
  return {
    id: 1,
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aabbccdd',
    receiverNodeNum: 0xaabbccdd,
    receiverLatitude: 40,
    receiverLongitude: -80,
    senderId: '!11223344',
    senderNodeNum: 0x11223344,
    packetKey: '12345',
    packetId: 12345,
    pathKey: 'r0:h0',
    latitude: 40.001,
    longitude: -80.001,
    altitude: 100.5,
    precisionBits: 16,
    snr: -7.5,
    rssi: 0,
    hopStart: 3,
    hopLimit: 3,
    hopsAway: 0,
    relayNode: 17,
    transportMechanism: null,
    channel: 2,
    rxTime: T0 / 1000,
    receivedAt: T0,
    ...over,
  } as CoverageReceptionDto;
}

const MC_KEY = 'ab'.repeat(32);
const MC_KEY2 = 'cd'.repeat(32);

function ctx(over: Partial<CoverageExportContext> = {}): CoverageExportContext {
  return {
    senderNames: new Map(),
    receiverNames: new Map(),
    sourceNames: new Map(),
    truncated: false,
    generatedAt: T0 + 1000,
    filters: {},
    ...over,
  };
}

/** What the importer should produce for a DTO. */
function project(d: CoverageReceptionDto) {
  const mt = d.protocol === 'meshtastic';
  return {
    protocol: d.protocol,
    receiverKind: d.receiverKind,
    receiverId: d.receiverId.toLowerCase(),
    receiverNodeNum: mt ? parseInt(d.receiverId.slice(1), 16) : null,
    receiverLatitude: d.receiverLatitude,
    receiverLongitude: d.receiverLongitude,
    senderId: d.senderId.toLowerCase(),
    senderNodeNum: mt ? parseInt(d.senderId.slice(1), 16) : null,
    packetKey: mt ? d.packetKey : d.packetKey.toUpperCase(),
    packetId: mt ? Number(d.packetKey) : null,
    pathKey: d.pathKey,
    latitude: d.latitude,
    longitude: d.longitude,
    altitude: d.altitude,
    precisionBits: d.precisionBits,
    snr: d.snr,
    rssi: d.rssi,
    hopStart: d.hopStart,
    hopLimit: d.hopLimit,
    hopsAway: d.hopsAway,
    relayNode: d.relayNode,
    channel: d.channel,
    receivedAt: d.receivedAt,
  };
}

const fixtures = (): CoverageReceptionDto[] => [
  dto({ id: 1 }),
  dto({
    id: 2,
    packetKey: '4294967295',
    receiverLatitude: null,
    receiverLongitude: null,
    altitude: null,
    precisionBits: null,
    snr: null,
    rssi: null,
    hopStart: null,
    hopLimit: null,
    hopsAway: null,
    relayNode: null,
    channel: null,
    receivedAt: T0 + 5000,
    senderId: '!ABCDEF01',
  }),
  dto({
    id: 3,
    protocol: 'meshcore',
    receiverKind: 'mqtt_gateway',
    receiverId: MC_KEY,
    senderId: MC_KEY2,
    packetKey: 'a1b2c3d4e5f60718',
    pathKey: 'h2:ab12',
    snr: 3.25,
    rssi: -90,
    receivedAt: T0 + 9000,
  }),
];

const names = () =>
  ctx({
    senderNames: new Map([
      ['!11223344', '=HYPERLINK("x")'],
      ['!ABCDEF01', '-cmd, "q"\nline2'],
      [MC_KEY2, '@name'],
    ]),
    receiverNames: new Map([['src-a:!aabbccdd', "+x"]]),
    sourceNames: new Map([['src-a', 'Source, A']]),
  });

describe('drift', () => {
  it('importer columns equal the exporter columns', () => {
    expect(COVERAGE_IMPORT_COLUMNS.map((c) => c.key)).toEqual(COVERAGE_EXPORT_COLUMNS.map((c) => c.label));
    expect(COVERAGE_IMPORT_COLUMNS).toEqual(COVERAGE_EXPORT_COLUMNS.map((c) => ({ key: c.key, kind: c.kind })));
  });
});

describe('round trip', () => {
  const expected = fixtures().map(project);
  const gaps: CoverageGap[] = [
    {
      from: { latitude: 40, longitude: -80, receivedAt: T0 } as never,
      to: { latitude: 41, longitude: -81, receivedAt: T0 + 1 } as never,
      durationSec: 60,
      distanceM: 1000,
      missedEstimate: 2,
    },
  ];

  it('CSV', () => {
    const r = parseCoverageImport('x.csv', buildCoverageCsv(fixtures(), names()), NOW);
    expect(r).toMatchObject({ ok: true, format: 'csv', gapFeatures: 0 });
    if (r.ok) expect(r.rows).toEqual(expected);
  });
  it('CSV with BOM and LF endings', () => {
    const text = '\uFEFF' + buildCoverageCsv(fixtures(), ctx()).replace(/\r\n/g, '\n');
    const r = parseCoverageImport('x.csv', text, NOW);
    expect(r.ok).toBe(true);
  });
  it('GeoJSON with gaps', () => {
    const r = parseCoverageImport('x.geojson', buildCoverageGeoJson(fixtures(), { ...names(), gaps }), NOW);
    expect(r).toMatchObject({ ok: true, format: 'geojson', gapFeatures: 1, sourceTruncated: false });
    if (r.ok) expect(r.rows).toEqual(expected);
  });
  it('GeoJSON truncated flag is surfaced', () => {
    const r = parseCoverageImport('x.json', buildCoverageGeoJson(fixtures(), ctx({ truncated: true })), NOW);
    expect(r).toMatchObject({ ok: true, sourceTruncated: true });
  });
  it('accepts a pre-change export without format/version', () => {
    const doc = JSON.parse(buildCoverageGeoJson(fixtures(), ctx()));
    delete doc.meshmonitor.format;
    delete doc.meshmonitor.version;
    expect(parseCoverageImport('old.geojson', JSON.stringify(doc), NOW)).toMatchObject({ ok: true });
  });
});

function geo(mut?: (doc: any) => void, items = fixtures()): string {
  const doc = JSON.parse(buildCoverageGeoJson(items, ctx()));
  mut?.(doc);
  return JSON.stringify(doc);
}

describe('GeoJSON structural rejections', () => {
  it('missing meshmonitor marker', () => {
    const r = parseCoverageImport('a.geojson', geo((d) => delete d.meshmonitor), NOW);
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_NOT_MESHMONITOR' });
  });
  it('not a FeatureCollection', () => {
    expect(parseCoverageImport('a.geojson', '{"type":"Feature"}', NOW)).toMatchObject({ code: 'IMPORT_NOT_MESHMONITOR' });
  });
  it('unknown format', () => {
    const r = parseCoverageImport('a.geojson', geo((d) => (d.meshmonitor.format = 'other')), NOW);
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_SCHEMA_MISMATCH' });
  });
  it('newer version', () => {
    const r = parseCoverageImport('a.geojson', geo((d) => (d.meshmonitor.version = 2)), NOW);
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_SCHEMA_MISMATCH' });
  });
  it('coordinate mismatch', () => {
    const r = parseCoverageImport('a.geojson', geo((d) => (d.features[0].geometry.coordinates[0] = -79)), NOW);
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_INVALID_ROWS', errors: [{ row: 1, field: 'geometry' }] });
  });
  it('missing property names the key', () => {
    const r = parseCoverageImport('a.geojson', geo((d) => delete d.features[1].properties.snr), NOW);
    expect(r).toMatchObject({ ok: false, errors: [{ row: 2, field: 'snr' }] });
  });
  it('non-point feature', () => {
    const r = parseCoverageImport(
      'a.geojson',
      geo((d) => d.features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: {} })),
      NOW,
    );
    expect(r).toMatchObject({ ok: false, errors: [{ row: 4, field: 'geometry' }] });
  });
  it('invalid JSON', () => {
    expect(parseCoverageImport('a.geojson', '{nope', NOW)).toMatchObject({ code: 'IMPORT_UNSUPPORTED_FILE' });
  });
  it('empty', () => {
    expect(parseCoverageImport('a.geojson', geo((d) => (d.features = [])), NOW)).toMatchObject({ code: 'IMPORT_EMPTY' });
  });
  it('too many rows', () => {
    const r = parseCoverageImport(
      'a.geojson',
      geo((d) => {
        const f = d.features[0];
        d.features = Array.from({ length: COVERAGE_IMPORT_MAX_ROWS + 1 }, () => f);
      }),
      NOW,
    );
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_TOO_MANY_ROWS' });
  });
});

describe('CSV structural rejections', () => {
  const csv = () => buildCoverageCsv(fixtures(), ctx());
  it('header mismatch names the column', () => {
    const r = parseCoverageImport('a.csv', csv().replace('senderId', 'sender'), NOW);
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_SCHEMA_MISMATCH' });
    if (!r.ok) expect(r.message).toContain('"senderId"');
  });
  it('extra column', () => {
    const t = csv().replace('channel', 'channel,extra');
    expect(parseCoverageImport('a.csv', t, NOW)).toMatchObject({ code: 'IMPORT_SCHEMA_MISMATCH' });
  });
  it('header only is empty', () => {
    const header = csv().split('\r\n')[0];
    expect(parseCoverageImport('a.csv', header + '\r\n', NOW)).toMatchObject({ code: 'IMPORT_EMPTY' });
  });
  it('ragged row reports its line', () => {
    const lines = csv().split('\r\n');
    lines[2] = 'a,b';
    const r = parseCoverageImport('a.csv', lines.join('\r\n'), NOW);
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_INVALID_ROWS', errors: [{ row: 3, field: null }] });
  });
  it('too many rows', () => {
    const lines = csv().split('\r\n');
    const body = Array.from({ length: COVERAGE_IMPORT_MAX_ROWS + 1 }, () => lines[1]);
    expect(parseCoverageImport('a.csv', [lines[0], ...body].join('\n'), NOW)).toMatchObject({ code: 'IMPORT_TOO_MANY_ROWS' });
  });
  it('non-numeric number cell', () => {
    const lines = csv().split('\r\n');
    const idx = COVERAGE_EXPORT_COLUMNS.findIndex((c) => c.key === 'snr');
    const cells = lines[1].split(',');
    cells[idx] = 'abc';
    lines[1] = cells.join(',');
    const r = parseCoverageImport('a.csv', lines.join('\r\n'), NOW);
    expect(r).toMatchObject({ ok: false, errors: [{ row: 2, field: 'snr' }] });
  });
  it('error cap at 20 with true count in message', () => {
    const lines = csv().split('\r\n');
    const body = Array.from({ length: 30 }, () => 'bad');
    const r = parseCoverageImport('a.csv', [lines[0], ...body].join('\n'), NOW);
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_INVALID_ROWS' });
    if (!r.ok) {
      expect(r.errors).toHaveLength(20);
      expect(r.message).toContain('30 invalid rows');
    }
  });
});

describe('hostile input bounds', () => {
  it('a 1M-line CSV is rejected as too many rows quickly', () => {
    const header = COVERAGE_EXPORT_COLUMNS.map((c) => c.label).join(',');
    const t0 = Date.now();
    const r = parseCoverageImport('a.csv', header + '\n' + 'a\n'.repeat(100_000), NOW);
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_TOO_MANY_ROWS' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('a bad header on a huge file fails on the header', () => {
    expect(parseCoverageImport('a.csv', 'x\n' + 'a\n'.repeat(100_000), NOW)).toMatchObject({ code: 'IMPORT_SCHEMA_MISMATCH' });
  });
  it('gap features count toward a feature cap', () => {
    const r = parseCoverageImport(
      'a.geojson',
      geo((d) => {
        const gap = { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { kind: 'likely_gap' } };
        d.features = Array.from({ length: COVERAGE_IMPORT_MAX_ROWS * 2 + 1 }, () => gap);
      }),
      NOW,
    );
    expect(r).toMatchObject({ ok: false, code: 'IMPORT_TOO_MANY_ROWS' });
  });
  it('bounds MeshCore path keys', () => {
    const mc = { protocol: 'meshcore', senderId: MC_KEY, receiverId: MC_KEY2, packetKey: 'A'.repeat(16) };
    const base = { receivedAt: new Date(T0).toISOString(), receivedAtMs: T0, receiverKind: 'local', latitude: 40, longitude: -80 };
    const f = (pathKey: string) => {
      const r = validateCoverageImportRow({ ...base, ...mc, pathKey }, NOW);
      return 'errors' in r ? r.errors.map((e) => e.field) : [];
    };
    expect(f('h63:ab')).toEqual([]);
    expect(f('h64:ab')).toContain('pathKey');
    expect(f('h' + '1'.repeat(100) + ':ab')).toContain('pathKey');
  });
});

describe('detectCoverageImportFormat', () => {
  it('uses extension and first byte', () => {
    expect(detectCoverageImportFormat('a.csv', 'a,b')).toBe('csv');
    expect(detectCoverageImportFormat('A.CSV', '\uFEFFa,b')).toBe('csv');
    expect(detectCoverageImportFormat('a.geojson', '  \n{"a":1}')).toBe('geojson');
    expect(detectCoverageImportFormat('a.json', '\uFEFF{}')).toBe('geojson');
    expect(detectCoverageImportFormat('a.csv', '{}')).toBeNull();
    expect(detectCoverageImportFormat('a.geojson', 'a,b')).toBeNull();
    expect(detectCoverageImportFormat('a.txt', '{}')).toBeNull();
    expect(parseCoverageImport('a.txt', '{}', NOW)).toMatchObject({ code: 'IMPORT_UNSUPPORTED_FILE' });
  });
});

describe('unguardFormulaInjection', () => {
  it('inverts guardFormulaInjection for every trigger', () => {
    for (const t of ['=a', '+a', '-a', '@a', '\ta', '\ra', 'plain', "'quoted", '']) {
      expect(unguardFormulaInjection(guardFormulaInjection(t))).toBe(t);
    }
  });
});

describe('validateCoverageImportRow', () => {
  const good = (): Record<string, unknown> => ({
    receivedAt: new Date(T0).toISOString(),
    receivedAtMs: T0,
    protocol: 'meshtastic',
    senderId: '!11223344',
    senderName: '',
    latitude: 40,
    longitude: -80,
    altitude: null,
    precisionBits: null,
    sourceId: 'x',
    sourceName: '',
    receiverKind: 'local',
    receiverId: '!aabbccdd',
    receiverName: '',
    receiverLatitude: null,
    receiverLongitude: null,
    distanceKm: null,
    snr: null,
    rssi: null,
    hopsAway: null,
    hopStart: null,
    hopLimit: null,
    relayNode: null,
    pathKey: 'r0:h0',
    packetKey: '1',
    channel: null,
  });
  const fieldOf = (over: Record<string, unknown>) => {
    const r = validateCoverageImportRow({ ...good(), ...over }, NOW);
    return 'errors' in r ? r.errors.map((e) => e.field) : [];
  };

  it('accepts a good row', () => {
    expect(validateCoverageImportRow(good(), NOW)).toHaveProperty('row');
  });
  it.each([
    ['protocol', { protocol: 'lora' }],
    ['receiverKind', { receiverKind: 'x' }],
    ['senderId', { senderId: '11223344' }],
    ['senderId', { senderId: MC_KEY }],
    ['receiverId', { receiverId: '!zz' }],
    ['packetKey', { packetKey: '4294967296' }],
    ['packetKey', { packetKey: '-1' }],
    ['packetKey', { protocol: 'meshcore', senderId: MC_KEY, receiverId: MC_KEY2, pathKey: 'h1:ab', packetKey: '123' }],
    ['pathKey', { pathKey: 'r1234:h0' }],
    ['pathKey', { protocol: 'meshcore', senderId: MC_KEY, receiverId: MC_KEY2, packetKey: 'A'.repeat(16), pathKey: 'r0:h0' }],
    ['latitude', { latitude: 91 }],
    ['longitude', { longitude: -181 }],
    ['latitude', { latitude: NaN }],
    ['latitude', { latitude: '40' }],
    ['receiverLongitude', { receiverLatitude: 40 }],
    ['receiverLatitude', { receiverLongitude: 40 }],
    ['receiverLatitude', { receiverLatitude: 95, receiverLongitude: 0 }],
    ['altitude', { altitude: 100_001 }],
    ['precisionBits', { precisionBits: 33 }],
    ['precisionBits', { precisionBits: 1.5 }],
    ['snr', { snr: 51 }],
    ['rssi', { rssi: 21 }],
    ['rssi', { rssi: -80.5 }],
    ['hopsAway', { hopsAway: 64 }],
    ['hopStart', { hopStart: 8 }],
    ['hopLimit', { hopLimit: -1 }],
    ['relayNode', { relayNode: 256 }],
    ['channel', { channel: -1 }],
    ['channel', { channel: 2 ** 31 }],
    ['receivedAtMs', { receivedAtMs: Date.UTC(2019, 11, 31), receivedAt: new Date(Date.UTC(2019, 11, 31)).toISOString() }],
    ['receivedAtMs', { receivedAtMs: NOW + 6 * 60_000, receivedAt: new Date(NOW + 6 * 60_000).toISOString() }],
    ['receivedAtMs', { receivedAtMs: T0 + 0.5 }],
    ['receivedAt', { receivedAt: new Date(T0 + 1).toISOString() }],
    ['receivedAt', { receivedAt: 'garbage' }],
  ])('rejects bad %s', (field, over) => {
    expect(fieldOf(over)).toContain(field);
  });
  it('accepts boundary values and rssi 0, lowercases/uppercases keys', () => {
    const r = validateCoverageImportRow(
      { ...good(), senderId: '!ABCDEF01', rssi: 0, snr: -50, hopStart: 7, relayNode: 255, hopsAway: 63, channel: 2 ** 31 - 1 },
      NOW,
    );
    expect(r).toMatchObject({ row: { senderId: '!abcdef01', senderNodeNum: 0xabcdef01, rssi: 0 } });
    const mc = validateCoverageImportRow(
      { ...good(), protocol: 'meshcore', senderId: MC_KEY.toUpperCase(), receiverId: MC_KEY2, packetKey: 'abcdef0123456789', pathKey: 'h-:-' },
      NOW,
    );
    expect(mc).toMatchObject({ row: { senderId: MC_KEY, packetKey: 'ABCDEF0123456789', packetId: null, senderNodeNum: null } });
  });
  it('skips Null Island fixes and receivers instead of erroring', () => {
    expect(validateCoverageImportRow({ ...good(), latitude: 0, longitude: 0 }, NOW)).toEqual({ skipped: 'bogus_position' });
    expect(
      validateCoverageImportRow({ ...good(), receiverLatitude: 0, receiverLongitude: 0 }, NOW),
    ).toEqual({ skipped: 'bogus_position' });
    // a real range error still wins
    expect(fieldOf({ latitude: 91, longitude: 0 })).toContain('latitude');
  });
  it('counts skipped rows in a CSV and GeoJSON import', () => {
    const items = [...fixtures(), dto({ id: 9, packetKey: '777', latitude: 0, longitude: 0, precisionBits: null, receivedAt: T0 + 20 })];
    const c = parseCoverageImport('a.csv', buildCoverageCsv(items, ctx()), NOW);
    expect(c).toMatchObject({ ok: true, skippedBogusPositions: 1 });
    if (c.ok) expect(c.rows).toHaveLength(3);
    const g = parseCoverageImport('a.geojson', buildCoverageGeoJson(items, ctx()), NOW);
    expect(g).toMatchObject({ ok: true, skippedBogusPositions: 1 });
  });
  it('reports multiple fields at once', () => {
    expect(fieldOf({ snr: 99, rssi: 99 })).toEqual(['snr', 'rssi']);
  });
  it('requires required fields', () => {
    expect(fieldOf({ senderId: null, packetKey: '', latitude: null })).toEqual(expect.arrayContaining(['senderId', 'packetKey', 'latitude']));
  });
});

describe('coverageImportProtocolFor', () => {
  it('maps source types', () => {
    expect(coverageImportProtocolFor('meshtastic_tcp')).toBe('meshtastic');
    expect(coverageImportProtocolFor('mqtt')).toBe('meshtastic');
    expect(coverageImportProtocolFor('meshcore')).toBe('meshcore');
    expect(coverageImportProtocolFor('meshcore_mqtt')).toBe('meshcore');
    expect(coverageImportProtocolFor('reticulum')).toBeNull();
  });
});

describe('sanitizeImportFilename', () => {
  it('keeps basename, strips control chars, checks extension and length', () => {
    expect(sanitizeImportFilename('C:\\a\\b\\cov.CSV')).toBe('cov.CSV');
    expect(sanitizeImportFilename('../../etc/x.geojson')).toBe('x.geojson');
    expect(sanitizeImportFilename('  a\u0000b\n.json ')).toBe('ab.json');
    expect(sanitizeImportFilename('a\u202eb\u2066c\u2028d\u2029e.csv')).toBe('abcde.csv');
    expect(sanitizeImportFilename('x.txt')).toBeNull();
    expect(sanitizeImportFilename('dir/')).toBeNull();
    expect(sanitizeImportFilename('')).toBeNull();
    expect(sanitizeImportFilename('a'.repeat(196) + '.csv')).toBe('a'.repeat(196) + '.csv');
    expect(sanitizeImportFilename('a'.repeat(197) + '.csv')).toBeNull();
  });
});
