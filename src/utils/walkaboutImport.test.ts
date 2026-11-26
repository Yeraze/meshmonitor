/**
 * Walkabout import parser (#6573): JSON round trip through the real builder,
 * bounded parse, caps, field rules.
 */
import { describe, it, expect } from 'vitest';
import {
  WALKABOUT_IMPORT_MAX_JSON_VALUES,
  countJsonValues,
  isWalkaboutExportText,
  parseWalkaboutImport,
} from './walkaboutImport.js';
import { buildWalkaboutJson } from './walkaboutExport.js';
import { COVERAGE_IMPORT_MAX_ROWS } from './coverageImport.js';
import { WALKABOUT_IMPORT_MAX_SESSIONS, WALKABOUT_MAX_DURATION_MS } from './walkabout.js';
import type { WalkaboutExportDoc } from '../types/walkabout.js';

const NOW = Date.UTC(2026, 10, 26, 12);
const T0 = NOW - 3_600_000;
const MC_KEY = 'AB'.repeat(32);

function doc(): WalkaboutExportDoc {
  return {
    meshmonitor: { format: 'meshmonitor-walkabout', version: 1, exportedAt: NOW, hiddenReceptionCount: 1, truncated: false },
    sessions: [
      {
        name: '  Park loop  ',
        startedAt: T0,
        endedAt: T0 + 600_000,
        endReason: 'user',
        samples: [
          { id: 7, latitude: 40.1, longitude: -105.1, accuracyM: 5, deviceFixAt: T0, fixAt: T0 + 500, receivedAt: T0 + 600 },
          { id: 9, latitude: 40.2, longitude: -105.2, accuracyM: 12.5, deviceFixAt: T0 + 5000, fixAt: T0 + 5500, receivedAt: T0 + 5600 },
        ],
        receptions: [
          {
            protocol: 'meshtastic', creditedKey: '!AABBCCDD', creditedNodeNum: 0xaabbccdd, creditKind: 'direct', hopsAway: 0,
            packetKey: 'aabbccdd:42', snr: -7.5, rssi: 0, heardAt: T0 + 1000, sampleId: 7, latitude: 40.1, longitude: -105.1,
            accuracyM: 5, sampleAgeMs: 500, longName: '=cmd', shortName: null,
          },
          {
            protocol: 'meshcore', creditedKey: MC_KEY, creditedNodeNum: null, creditKind: 'relay', hopsAway: 3,
            packetKey: '0123456789ABCDEF', snr: null, rssi: null, heardAt: T0 + 6000, sampleId: null, latitude: 40.2,
            longitude: -105.2, accuracyM: 12.5, sampleAgeMs: 500,
          },
        ],
      },
    ],
  };
}

const parse = (d: unknown) => parseWalkaboutImport(JSON.stringify(d), NOW);

describe('parseWalkaboutImport', () => {
  it('round-trips the exporter output; keys lowercased, node num re-derived, names ignored', () => {
    const text = buildWalkaboutJson(doc());
    expect(isWalkaboutExportText(text)).toBe(true);
    const res = parseWalkaboutImport(text, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rowCount).toBe(4);
    const s = res.sessions[0];
    expect(s).toMatchObject({ name: 'Park loop', startedAt: T0, endedAt: T0 + 600_000, endReason: 'user' });
    expect(s.samples.map((x) => x.fileId)).toEqual([7, 9]);
    expect(s.receptions[0]).toMatchObject({ creditedKey: '!aabbccdd', creditedNodeNum: 0xaabbccdd, rssi: 0, snr: -7.5, fileSampleId: 7 });
    expect(s.receptions[0]).not.toHaveProperty('longName');
    expect(s.receptions[1]).toMatchObject({ creditedKey: MC_KEY.toLowerCase(), creditedNodeNum: null, fileSampleId: null });
  });

  it('an open session in the file is closed at its cap (an import is never live)', () => {
    const d = doc();
    d.sessions[0].endedAt = null;
    d.sessions[0].endReason = null;
    const res = parse(d);
    expect(res.ok && res.sessions[0]).toMatchObject({ endedAt: T0 + WALKABOUT_MAX_DURATION_MS, endReason: 'cap' });
  });

  it('surfaces truncated', () => {
    const d = doc();
    d.meshmonitor.truncated = true;
    const res = parse(d);
    expect(res.ok && res.sourceTruncated).toBe(true);
  });

  it.each([
    ['not JSON', '{nope', 'IMPORT_UNSUPPORTED_FILE'],
    ['an array', '[1,2]', 'IMPORT_UNSUPPORTED_FILE'],
    ['a coverage GeoJSON', JSON.stringify({ type: 'FeatureCollection', meshmonitor: {}, features: [] }), 'IMPORT_NOT_MESHMONITOR'],
  ])('rejects %s', (_n, text, code) => {
    const res = parseWalkaboutImport(text, NOW);
    expect(res.ok === false && res.code).toBe(code);
  });

  it('rejects a newer version and a missing sessions array', () => {
    const d = doc();
    (d.meshmonitor as { version: number }).version = 2;
    expect(parse(d)).toMatchObject({ ok: false, code: 'IMPORT_SCHEMA_MISMATCH' });
    expect(parse({ meshmonitor: doc().meshmonitor })).toMatchObject({ ok: false, code: 'IMPORT_SCHEMA_MISMATCH' });
  });

  it('caps rows per file and sessions per file; empty files are refused', () => {
    const d = doc();
    const s0 = d.sessions[0].samples[0];
    d.sessions[0].samples = Array.from({ length: COVERAGE_IMPORT_MAX_ROWS }, (_, i) => ({ ...s0, id: i }));
    expect(parse(d)).toMatchObject({ ok: false, code: 'IMPORT_TOO_MANY_ROWS' }); // + 2 receptions
    const many = doc();
    many.sessions = Array.from({ length: WALKABOUT_IMPORT_MAX_SESSIONS + 1 }, () => ({ ...doc().sessions[0], samples: [], receptions: [] }));
    expect(parse(many)).toMatchObject({ ok: false, code: 'IMPORT_TOO_MANY_ROWS' });
    const empty = doc();
    empty.sessions[0].samples = [];
    empty.sessions[0].receptions = [];
    expect(parse(empty)).toMatchObject({ ok: false, code: 'IMPORT_EMPTY' });
  });

  it('refuses a file of many tiny values before JSON.parse builds them', () => {
    const tiny = `{"meshmonitor":{"format":"meshmonitor-walkabout","version":1},"sessions":[{"samples":[${'0,'.repeat(WALKABOUT_IMPORT_MAX_JSON_VALUES)}0],"receptions":[]}]}`;
    expect(countJsonValues(tiny, WALKABOUT_IMPORT_MAX_JSON_VALUES)).toBe(WALKABOUT_IMPORT_MAX_JSON_VALUES + 1);
    expect(parseWalkaboutImport(tiny, NOW)).toMatchObject({ ok: false, code: 'IMPORT_TOO_MANY_ROWS' });
  });

  it('countJsonValues ignores commas and brackets inside strings', () => {
    expect(countJsonValues('{"a":"x,[{y","b":[1,2]}', 100)).toBe(4);
    expect(countJsonValues('{"a":"q\\",z"}', 100)).toBe(1);
  });

  it('reports every bad field with its path, capped at 20, with the true count', () => {
    const d = doc();
    const smp = d.sessions[0].samples[0] as unknown as Record<string, unknown>;
    smp.latitude = 0;
    smp.longitude = 0;
    const r0 = d.sessions[0].receptions[0] as unknown as Record<string, unknown>;
    r0.creditedNodeNum = 1;
    r0.packetKey = 'nope';
    r0.snr = 99;
    r0.heardAt = 1;
    const r1 = d.sessions[0].receptions[1] as unknown as Record<string, unknown>;
    r1.sampleId = 12345;
    d.sessions[0].endedAt = T0 + WALKABOUT_MAX_DURATION_MS + 1;
    const res = parse(d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('IMPORT_INVALID_ROWS');
    expect(res.errors.every((e) => e.row === 1)).toBe(true);
    expect(res.errors.map((e) => e.field)).toEqual(
      expect.arrayContaining([
        'samples[0].latitude',
        'receptions[0].creditedNodeNum',
        'receptions[0].packetKey',
        'receptions[0].snr',
        'receptions[0].heardAt',
        'receptions[1].sampleId',
        'endedAt',
      ]),
    );

    const lots = doc();
    lots.sessions[0].samples = Array.from({ length: 30 }, (_, i) => ({ ...lots.sessions[0].samples[0], id: i, accuracyM: 500 }));
    lots.sessions[0].receptions = [];
    const capped = parse(lots);
    expect(capped.ok === false && capped.errors).toHaveLength(20);
    expect(capped.ok === false && capped.errorCount).toBe(30);
  });

  it('rejects duplicate sample ids and a future timestamp', () => {
    const d = doc();
    d.sessions[0].samples[1].id = 7;
    const dup = parse(d);
    expect(dup.ok === false && dup.errors.map((e) => e.field)).toEqual(['samples[1].id']);
    const f = doc();
    f.sessions[0].samples[0].fixAt = NOW + 3_600_000;
    const future = parse(f);
    expect(future.ok === false && future.errors.map((e) => e.field)).toContain('samples[0].fixAt');
  });

  it('isWalkaboutExportText only sniffs the top of the file', () => {
    expect(isWalkaboutExportText('{"type":"FeatureCollection","meshmonitor":{"format":"meshmonitor-coverage-report"}}')).toBe(false);
    expect(isWalkaboutExportText(`{"pad":"${'x'.repeat(5000)}","meshmonitor":{"format":"meshmonitor-walkabout"}}`)).toBe(false);
    expect(isWalkaboutExportText('\ufeff{ "meshmonitor": { "format": "meshmonitor-walkabout" } }')).toBe(true);
  });
});
