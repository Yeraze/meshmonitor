import { describe, it, expect } from 'vitest';
import { redactPublicPayload, PUBLIC_INSTANCE_FIELD_CATALOGUE } from './publicInstanceRedactor.js';
import { parsePublicInstanceConfig, PUBLIC_INSTANCE_HIDDEN_TEXT, type RedactionConfig } from '../../utils/publicInstanceMode.js';
import './jsonBigIntReplacer.js'; // installs the global BigInt-safe JSON.stringify, as server.ts does
import { precisionCellSizeDegrees, snapToPrecisionCell } from '../../utils/precisionOffset.js';

const ON: RedactionConfig = { ...parsePublicInstanceConfig({ publicInstanceModeEnabled: '1' }) };
const only = (o: Partial<RedactionConfig>): RedactionConfig => ({
  enabled: true, hideLongNames: false, hidePublicKeys: false, roundTimestamps: false, hideMessageText: false, ...o,
});
const run = (b: unknown, cfg: RedactionConfig = ON) => redactPublicPayload(b, cfg) as Record<string, any>;
const HEX = 'ab'.repeat(32);
const CELL = precisionCellSizeDegrees(14);

describe('class A positions', () => {
  it('snaps exact and suffix lat/lon keys within half a cell', () => {
    const o = run({
      latitude: 40.1234567, longitude: -105.7654321, lat: 40.1234567, lon: -105.7654321, lng: -105.7654321,
      receiverLatitude: 40.1234567, fromLat: 40.1234567, toLongitude: -105.7654321, minLat: 40.12, maxLon: -105.76,
      latitudeOverride: 40.1234567, waypoint_lat: 40.1234567, bboxNorth: 40.5, bboxWest: -105.5,
    });
    for (const [k, v] of Object.entries(o)) {
      const orig = { latitude: 40.1234567, lat: 40.1234567, receiverLatitude: 40.1234567, fromLat: 40.1234567, latitudeOverride: 40.1234567, waypoint_lat: 40.1234567, minLat: 40.12, bboxNorth: 40.5 } as Record<string, number>;
      if (k in orig) expect(Math.abs((v as number) - orig[k])).toBeLessThanOrEqual(CELL / 2 + 1e-9);
      expect(typeof v).toBe('number');
    }
    expect(o.latitude).not.toBe(40.1234567);
    expect(o.lat).toBe(o.latitude);
  });
  it('keeps latitudeI an integer on the firmware grid', () => {
    const i = 401_234_567;
    const o = run({ latitudeI: i, latitude_i: i, latI: i });
    const expected = Math.floor(i / 2 ** 18) * 2 ** 18 + 2 ** 17;
    expect(o.latitudeI).toBe(expected);
    expect(o.latitude_i).toBe(expected);
    expect(o.latI).toBe(expected);
  });
  it('leaves Long (Reticulum airtimeLong) alone', () => {
    expect(run({ airtimeLong: 0.1234567, channelLoadLong: 3.3333333 })).toEqual({ airtimeLong: 0.1234567, channelLoadLong: 3.3333333 });
  });
  it('passes exact 0, null and strings unchanged', () => {
    expect(run({ latitude: 0, longitude: 0, lat: null, lon: 'abc' })).toEqual({ latitude: 0, longitude: 0, lat: null, lon: 'abc' });
  });
  it('inherits precision bits from a parent (dbNodeMapper shape)', () => {
    const o = run({ positionPrecisionBits: 13, deviceInfo: { position: { latitude: 40.1234567, longitude: -105.7654321 } } });
    const snapped13 = snapToPrecisionCell(40.1234567, 13, false);
    expect(o.deviceInfo.position.latitude).toBe(snapped13);
    expect(o.positionPrecisionBits).toBe(13);
  });
  it('snaps to the declared 13-bit cell, keeps snapped values, rewrites 32 to 14', () => {
    const a = run({ latitude: 40.1234567, latitudeOverride: 40.1234567, precisionBits: 13 });
    const s13 = snapToPrecisionCell(40.1234567, 13, false);
    expect(a).toEqual({ latitude: s13, latitudeOverride: s13, precisionBits: 13 });
    expect(a.latitude).not.toBe(40.1234567);
    expect(run({ latitude: s13, precisionBits: 13 }).latitude).toBe(s13);
    const b = run({ latitude: 40.1234567, position_precision_bits: 32 });
    expect(b.position_precision_bits).toBe(14);
    expect(b.latitude).not.toBe(40.1234567);
  });
  it('honours precision bits given as numeric strings', () => {
    const s13 = snapToPrecisionCell(40.1234567, 13, false);
    const a = run({ latitude: 40.1234567, precisionBits: '13' });
    expect(a).toEqual({ latitude: s13, precisionBits: '13' });
    const b = run({ latitude: 40.1234567, precisionBits: '32' });
    expect(b.precisionBits).toBe('14');
    expect(b.latitude).toBe(snapToPrecisionCell(40.1234567, 14, false));
  });
  it('snaps with bits 0, null or absent; never adds a precision key', () => {
    expect(run({ latitude: 40.1234567, precision_bits: 0 }).precision_bits).toBe(14);
    expect(run({ latitude: 40.1234567, precisionBits: null }).precisionBits).toBeNull();
    expect(run({ latitude: 40.1234567, precisionBits: null }).latitude).not.toBe(40.1234567);
    expect('precisionBits' in run({ latitude: 40.1234567 })).toBe(false);
  });
  it('snaps coordinate arrays in either order and nested', () => {
    const o = run({
      pos: [40.1234567, -105.7654321], coordinates: [-105.7654321, 40.1234567],
      geometry: { coordinates: [[[-105.7654321, 40.1234567]]] }, bounds: [[40.1, -105.7], [40.2, -105.6]],
      from: [40.1234567, -105.7654321], to: [41.1234567, -104.7654321], path: [3, 7, 9], route: [1234567890, 99],
    });
    expect(o.pos[0]).toBe(o.coordinates[1]);
    expect(o.pos[1]).toBe(o.coordinates[0]);
    expect(o.pos[0]).not.toBe(40.1234567);
    expect(o.geometry.coordinates[0][0][1]).toBe(o.pos[0]);
    expect(o.from[0]).not.toBe(40.1234567);
    expect(o.path).toEqual([3, 7, 9]);
    expect(o.route).toEqual([1234567890, 99]);
  });
  it('leaves from/to alone when not all numbers', () => {
    expect(run({ from: 'abc', to: { nodeNum: 5 } })).toEqual({ from: 'abc', to: { nodeNum: 5 } });
    expect(run({ from: [1, 'x'] })).toEqual({ from: [1, 'x'] });
  });
  it('snaps telemetry position rows honouring their precisionBits', () => {
    const rows = run({ rows: [{ telemetryType: 'latitude', value: 40.1234567 }, { telemetryType: 'longitude', value: -105.7654321, precisionBits: 10 }, { telemetryType: 'voltage', value: 40.1234567 }] }).rows;
    expect(rows[0].value).not.toBe(40.1234567);
    expect(rows[1].value).toBe(snapToPrecisionCell(-105.7654321, 10, false));
    expect(rows[2].value).toBe(40.1234567);
  });
  it('applies even when every toggle is off', () => {
    expect(run({ latitude: 40.1234567 }, only({})).latitude).not.toBe(40.1234567);
  });
});

describe('class B long names', () => {
  it('nulls exact and suffix keys, keeps shortName', () => {
    const o = run({ longName: 'A', long_name: 'B', nodeLongName: 'C', fromLongName: 'D', newLongName: 'E', advName: 'F', adv_name: 'G', senderName: 'H', fromName: 'I', nodeName: 'J', shortName: 'AB' });
    for (const k of Object.keys(o)) if (k !== 'shortName') expect(o[k]).toBeNull();
    expect(o.shortName).toBe('AB');
  });
  it('gates name and displayName on siblings', () => {
    expect(run({ name: 'Bob', publicKey: HEX }).name).toBeNull();
    expect(run({ name: 'Bob', nodeNum: 5 }).name).toBeNull();
    expect(run({ name: 'Bob', pos: [1, 2] }).name).toBeNull();
    expect(run({ name: 'Channel 1', id: 1 }).name).toBe('Channel 1');
    expect(run({ displayName: 'R', destinationHash: 'ff' }).displayName).toBeNull();
    expect(run({ displayName: 'Admin User', username: 'a' }).displayName).toBe('Admin User');
  });
  it('is untouched when the toggle is off', () => {
    const b = { longName: 'A', name: 'x', nodeNum: 1 };
    expect(run(b, only({}))).toEqual(b);
  });
});

describe('class C public keys', () => {
  it('truncates 64-hex to 12 and nulls base64', () => {
    const o = run({ publicKey: HEX, fromPublicKey: HEX, senderPubKey: HEX, publicKeyHex: HEX, pk: HEX, senderPublicKey: 'qrvM3e7/qrvM3e7/qrvM3e7/qrvM3e7/qrvM3e7/qrvM3e4=', toPublicKey: null });
    expect(o.publicKey).toBe('ab'.repeat(6));
    expect(o.fromPublicKey).toBe('ab'.repeat(6));
    expect(o.senderPubKey).toBe('ab'.repeat(6));
    expect(o.publicKeyHex).toBe('ab'.repeat(6));
    expect(o.pk).toBe('ab'.repeat(6));
    expect(o.senderPublicKey).toBeNull();
    expect(o.toPublicKey).toBeNull();
  });
  it('truncates embedded mc:<pk> strings and object keys', () => {
    const o = run({ nodeId: `mc:${HEX}`, byKey: { [HEX]: 1 }, list: [`x ${HEX} y`], other: 'cd'.repeat(64) });
    expect(o.nodeId).toBe(`mc:${'ab'.repeat(6)}`);
    expect(o.byKey).toEqual({ [`${'ab'.repeat(6)}`]: 1 });
    expect(o.list[0]).toBe(`x ${'ab'.repeat(6)} y`);
    expect(o.other).toBe('cd'.repeat(64));
  });
  it('keeps pubkeyPrefix and destinationHash, is idempotent', () => {
    const b = { pubkeyPrefix: 'ab'.repeat(6), pubkey_prefix: 'cd'.repeat(6), destinationHash: 'ef'.repeat(8) };
    expect(run(b)).toEqual(b);
    const once = run({ publicKey: HEX });
    expect(run(once)).toEqual(once);
  });
  it('is untouched when the toggle is off', () => {
    expect(run({ publicKey: HEX, nodeId: `mc:${HEX}` }, only({}))).toEqual({ publicKey: HEX, nodeId: `mc:${HEX}` });
  });
});

describe('class D timestamps', () => {
  const H = 3_600_000;
  it('rounds ms, seconds, ISO; leaves durations', () => {
    const ms = 1_700_000_123_456;
    const s = 1_700_000_123;
    const o = run({
      timestamp: ms, rxTime: s, lastHeard: s, createdAt: ms, updated_at: s, startTime: s, duration: 5000,
      uptime: 123, lastSeen: 500_000_000, expiresAt: '2024-03-05T10:47:12.345Z', time: 12,
    });
    expect(o.timestamp).toBe(Math.floor(ms / H) * H);
    expect(o.rxTime).toBe(Math.floor(s / 3600) * 3600);
    expect(o.lastHeard).toBe(Math.floor(s / 3600) * 3600);
    expect(o.createdAt).toBe(Math.floor(ms / H) * H);
    expect(o.updated_at).toBe(Math.floor(s / 3600) * 3600);
    expect(o.duration).toBe(5000);
    expect(o.uptime).toBe(123);
    expect(o.lastSeen).toBe(500_000_000);
    expect(o.time).toBe(12);
    expect(o.expiresAt).toBe('2024-03-05T10:00:00.000Z');
  });
  it('preserves array order', () => {
    const o = run({ rows: [{ rxTime: 1_700_003_700 }, { rxTime: 1_700_000_100 }] });
    expect(o.rows.map((r: { rxTime: number }) => r.rxTime)).toEqual([1_700_002_800, 1_699_999_200]);
  });
  it('is untouched when the toggle is off', () => {
    expect(run({ rxTime: 1_700_000_123 }, only({}))).toEqual({ rxTime: 1_700_000_123 });
  });
});

describe('class E message text', () => {
  it('replaces text keys with the placeholder', () => {
    const o = run({ text: 'hi', messageText: 'a', lastMessageText: 'b', translatedText: 'c', decodedText: 'd', reactionRawText: 'e', replyText: 'f', count: 3 });
    for (const k of ['text', 'messageText', 'lastMessageText', 'translatedText', 'decodedText', 'reactionRawText', 'replyText']) expect(o[k]).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    expect(o.count).toBe(3);
  });
  it('gates message/body/content/title on siblings', () => {
    expect(run({ message: 'x', fromNodeNum: 1 }).message).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    expect(run({ message: 'x', channel: 0 }).message).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    expect(run({ message: 'Not found' }).message).toBe('Not found');
    expect(run({ body: 'x', packetId: 4 }).body).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    expect(run({ body: 'x' }).body).toBe('x');
    expect(run({ content: 'x', fromHash: 'ab' }).content).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    expect(run({ title: 'T', threadHash: 'ab' }).title).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    expect(run({ content: 'x' }).content).toBe('x');
    expect(run({ title: 'Map' }).title).toBe('Map');
  });
  it('is untouched when the toggle is off', () => {
    expect(run({ text: 'hi' }, only({}))).toEqual({ text: 'hi' });
  });
});

describe('class F raw payloads', () => {
  it('drops raw keys and string metadata', () => {
    const o = run({ id: 1, rawHex: 'aa', raw_hex: 'aa', raw: 'x', hex: 'x', bytes: [1], payload: 'p', rawPayload: 1, payloadHex: 'a', payloadBase64: 'a', payloadPreview: 'a', encryptedPayload: 'a', envelope: {}, routePositions: [[1, 2]], deviceInfoJson: '{}', fields: {}, metadata: 'str' });
    expect(o).toEqual({ id: 1 });
  });
  it('keeps non-string metadata and walks decoded', () => {
    const o = run({ metadata: { a: 1 }, decoded: { text: 'secret', latitudeI: 401_234_567 } });
    expect(o.metadata).toEqual({ a: 1 });
    expect(o.decoded.text).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    expect(o.decoded.latitudeI).not.toBe(401_234_567);
  });
  it('turns a Buffer into null', () => {
    const o = run({ blob: Buffer.from('abc'), list: [Buffer.from('x')] });
    expect(o.blob).toBeNull();
    expect(o.list).toEqual([null]);
  });
  it('applies with every toggle off', () => {
    expect(run({ rawHex: 'aa', id: 1 }, only({}))).toEqual({ id: 1 });
  });
});

describe('class G derived geometry', () => {
  it('rounds km distances to 1.5 (exact, suffix, snake keys)', () => {
    const o = run({ distance: 4.4, distanceKm: 10.9, distance_km: 1.0, rangeKm: 20001, maxDistanceKm: 7, nodeDistance: 3.1, reachKm: 5 });
    expect(o.distance).toBe(4.5);
    expect(o.distanceKm).toBe(10.5);
    expect(o.distance_km).toBe(1.5);
    expect(o.rangeKm).toBe(Math.round(20001 / 1.5) * 1.5);
    expect(o.maxDistanceKm).toBe(7.5);
    expect(o.nodeDistance).toBe(3);
    expect(o.reachKm).toBe(4.5);
  });
  it('rounds metre distances to 1500', () => {
    const o = run({ distanceMeters: 2300, distanceM: 4600, distance_m: 800, pathDistanceMeters: 3100 });
    expect(o.distanceMeters).toBe(3000);
    expect(o.distanceM).toBe(4500);
    expect(o.distance_m).toBe(1500);
    expect(o.pathDistanceMeters).toBe(3000);
  });
  it('treats a bare distance as km (documented assumption)', () => {
    expect(run({ distance: 1500 }).distance).toBe(1500);
    expect(run({ distance: 100.4 }).distance).toBe(100.5);
  });
  it('rounds bearings to 10 inside [0,360)', () => {
    const o = run({ bearing: 94, heading: 358, azimuth: 4, bearingDeg: 126, initialBearing: 11, groundHeading: 200.4 });
    expect(o.bearing).toBe(90);
    expect(o.heading).toBe(0);
    expect(o.azimuth).toBe(0);
    expect(o.bearingDeg).toBe(130);
    expect(o.initialBearing).toBe(10);
    expect(o.groundHeading).toBe(200);
  });
  it('normalises bearings into [0,360), negatives included', () => {
    const o = run({ a: { bearing: -5 }, b: { bearing: -355 }, c: { bearing: 355 }, d: { bearing: 365 } });
    expect(o.a.bearing).toBe(0);
    expect(o.b.bearing).toBe(10);
    expect(o.c.bearing).toBe(0);
    expect(o.d.bearing).toBe(10);
    expect(run({ bearing: -94 }).bearing).toBe(270);
  });
  it('rounds altitudes to 100 m', () => {
    const o = run({ altitude: 1623, alt: 149, altitudeM: 251, altitude_hae: 98, fixedAltitude: 1650, altitudeOverride: 12, gpsAltitude: 5149 });
    expect(o.altitude).toBe(1600);
    expect(o.alt).toBe(100);
    expect(o.altitudeM).toBe(300);
    expect(o.altitude_hae).toBe(100);
    expect(o.fixedAltitude).toBe(1700);
    expect(o.altitudeOverride).toBe(0);
    expect(o.gpsAltitude).toBe(5100);
  });
  it('rounds telemetry altitude rows', () => {
    expect(run({ telemetryType: 'altitude', value: 1623 }).value).toBe(1600);
  });
  it('passes 0, null, strings and non-finite through', () => {
    expect(run({ distance: 0, bearing: 0, altitude: 0, distanceKm: null, alt: 'n/a', heading: null })).toEqual({ distance: 0, bearing: 0, altitude: 0, distanceKm: null, alt: 'n/a', heading: null });
  });
  it('leaves lookalikes alone', () => {
    const b = { hopDistance: 3.3, distanceUnit: 'km', range: 7, ranges: [1, 2], azimuthCount: 5, altitudeMode: 2, headingCount: 4 };
    expect(run(b)).toEqual(b);
  });
  it('applies with every toggle off', () => {
    expect(run({ distanceKm: 4.4 }, only({})).distanceKm).toBe(4.5);
  });
});

describe('numeric strings (PG/MySQL BIGINT, BigInt JSON)', () => {
  it('rounds 13-digit ms and 10-digit seconds strings, keeping the string form', () => {
    const o = run({ createdAt: '1700000123456', rxTime: '1700000123', lastHeard: '1700000123.9', time: '12', timestamp: '0' });
    expect(o.createdAt).toBe(String(Math.floor(1_700_000_123_456 / 3_600_000) * 3_600_000));
    expect(o.rxTime).toBe(String(Math.floor(1_700_000_123 / 3600) * 3600));
    expect(o.lastHeard).toBe(String(Math.floor(1_700_000_123.9 / 3600) * 3600));
    expect(o.time).toBe('12');
    expect(o.timestamp).toBe('0');
  });
  it('snaps coordinate strings, integer-units strings and zero', () => {
    const o = run({ latitude: '40.1234567', longitudeI: '-1057654321', lat: '0', lon: '0.0', pos: ['40.1234567', '-105.7654321'] });
    expect(typeof o.latitude).toBe('string');
    expect(Number(o.latitude)).not.toBe(40.1234567);
    const i = -1_057_654_321;
    expect(o.longitudeI).toBe(String(Math.floor(i / 2 ** 18) * 2 ** 18 + 2 ** 17));
    expect(o.lat).toBe('0');
    expect(o.lon).toBe('0.0');
    expect(o.pos[0]).toBe(o.latitude);
  });
  it('snaps string coordinates to the declared 1..13 bit cell', () => {
    expect(run({ latitude: '40.1234567', precisionBits: 13 }).latitude).toBe(String(snapToPrecisionCell(40.1234567, 13, false)));
  });
  it('rounds distance, bearing and altitude strings', () => {
    const o = run({ distanceKm: '4.4', distanceMeters: '2300', bearing: '94', altitude: '1623', alt: '0', telemetryType: 'x' });
    expect(o.distanceKm).toBe('4.5');
    expect(o.distanceMeters).toBe('3000');
    expect(o.bearing).toBe('90');
    expect(o.altitude).toBe('1600');
    expect(o.alt).toBe('0');
  });
  it('snaps and rounds telemetry rows given as strings', () => {
    expect(Number(run({ telemetryType: 'latitude', value: '40.1234567' }).value)).not.toBe(40.1234567);
    expect(run({ telemetryType: 'altitude', value: '1623' }).value).toBe('1600');
  });
  it('leaves non-geometry numeric strings alone', () => {
    expect(run({ nodeNum: '1234567890', count: '5' })).toEqual({ nodeNum: '1234567890', count: '5' });
  });
});

describe('walker behaviour', () => {
  it('walks nesting and arrays', () => {
    const o = run({ a: [{ b: { longName: 'x', rxTime: 1_700_000_123 } }] });
    expect(o.a[0].b.longName).toBeNull();
    expect(o.a[0].b.rxTime).toBe(Math.floor(1_700_000_123 / 3600) * 3600);
  });
  it('does not mutate the input', () => {
    const input = { longName: 'x', latitude: 40.1234567, nested: { text: 'hi', publicKey: HEX }, arr: [{ rxTime: 1_700_000_123 }], rawHex: 'a' };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactPublicPayload(input, ON);
    expect(input).toEqual(snapshot);
  });
  it('normalises Date and BigInt', () => {
    const o = run({ at: new Date('2024-03-05T10:47:12Z'), big: 12345678901234567890n, createdAt: new Date('2024-03-05T10:47:12Z') });
    expect(o.createdAt).toBe('2024-03-05T10:00:00.000Z');
    expect(typeof o.big).toBe('string');
  });
  it('throws on a throwing toJSON', () => {
    expect(() => redactPublicPayload({ toJSON() { throw new Error('boom'); } }, ON)).toThrow('boom');
  });
  it('handles primitives, undefined and a disabled master', () => {
    expect(redactPublicPayload(undefined, ON)).toBeUndefined();
    expect(redactPublicPayload(5, ON)).toBe(5);
    expect(redactPublicPayload(`mc:${HEX}`, ON)).toBe(`mc:${'ab'.repeat(6)}`);
    const body = { longName: 'x', rawHex: 'a' };
    expect(redactPublicPayload(body, { ...ON, enabled: false })).toBe(body);
  });
  it('exports the catalogue as data', () => {
    for (const spec of Object.values(PUBLIC_INSTANCE_FIELD_CATALOGUE)) {
      expect(Array.isArray(spec.exact)).toBe(true);
      expect(Array.isArray(spec.patterns)).toBe(true);
    }
  });
});

describe('phase 2 audit fixes (#5156)', () => {
  it('hides snake_case and node-pair name keys', () => {
    const o = run({ from_node_longName: 'A', to_node_longName: 'B', fromNodeName: 'C', toNodeName: 'D', localName: 'E', node_name: 'F', node_num: 1 });
    expect(o).toEqual({ from_node_longName: null, to_node_longName: null, fromNodeName: null, toNodeName: null, localName: null, node_name: null, node_num: 1 });
  });

  it('nulls keySecurityIssueDetails and leaves the boolean flags', () => {
    const o = run({ keyMismatchDetected: true, keySecurityIssueDetails: 'Key mismatch: node broadcast key AbCd1234...' });
    expect(o).toEqual({ keyMismatchDetected: true, keySecurityIssueDetails: null });
  });

  it('keeps keySecurityIssueDetails when hidePublicKeys is off', () => {
    expect(run({ keySecurityIssueDetails: 'x' }, only({ hideLongNames: true }))).toEqual({ keySecurityIssueDetails: 'x' });
  });

  it('rounds uncertainty km, also when it sits in a map keyed by node id', () => {
    expect(run({ uncertaintyKm: 13.37, positionEstimateUncertaintyKm: 13.37 })).toEqual({ uncertaintyKm: 13.5, positionEstimateUncertaintyKm: 13.5 });
    expect(run({ estimatedUncertainty: { '!5e17a1e5': 13.37, '!5e17a1e6': '2.9' }, other: { a: 13.37 } })).toEqual({
      estimatedUncertainty: { '!5e17a1e5': 13.5, '!5e17a1e6': '3' },
      other: { a: 13.37 },
    });
  });

  it('rounds the first-unread timestamp maps only beside their sibling', () => {
    const ms = 1_794_845_262_137;
    const o = run({ channels: { 0: ms }, directMessages: { '!5e17a1e1': ms } });
    expect(o.channels[0]).toBe(Math.floor(ms / 3_600_000) * 3_600_000);
    expect(o.directMessages['!5e17a1e1']).toBe(Math.floor(ms / 3_600_000) * 3_600_000);
    expect(run({ channels: { 0: ms } }).channels[0]).toBe(ms); // `channels` alone is something else
    expect(run({ channels: { 0: ms }, directMessages: {} }, only({ hideLongNames: true })).channels[0]).toBe(ms);
  });

  it('rounds seqCursor like any timestamp', () => {
    expect(run({ seqCursor: 1_794_845_262_137 }).seqCursor).toBe(Math.floor(1_794_845_262_137 / 3_600_000) * 3_600_000);
  });

  it('hides waypoint name and description under hideMessageText, but not operator markers', () => {
    const wp = run({ waypointId: 4, name: 'Camp', description: 'Water here', latitude: 1, longitude: 1 });
    expect(wp.name).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    expect(wp.description).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    const marker = run({ id: 1, label: 'Repeater site', description: 'Roof mount', latitude: 1, longitude: 1 });
    expect(marker.label).toBe('Repeater site');
    expect(marker.description).toBe('Roof mount');
    expect(run({ waypointId: 4, name: 'Camp' }, only({ hideLongNames: true })).name).toBe('Camp');
  });

  describe('MeshCore sender name inside channel text', () => {
    const names = only({ hideLongNames: true });
    it('strips a leading "Name: " when only hideLongNames is on', () => {
      expect(run({ messageType: 'channel', fromName: null, text: 'Alice: hello: world' }, names).text).toBe('hello: world');
      expect(run({ fromPublicKey: 'channel-2', text: 'Bob: hi' }, names).text).toBe('hi');
      expect(run({ fromNodeId: 'channel-0', text: 'Bob: hi' }, names).text).toBe('hi');
    });
    it('leaves text alone when the message has its own name field, is not a channel message, or the prefix is long', () => {
      expect(run({ messageType: 'channel', fromName: 'Alice', text: 'note: x' }, names).text).toBe('note: x');
      expect(run({ messageType: 'channel', senderNameOverride: 'Al', text: 'note: x' }, names).text).toBe('note: x');
      expect(run({ messageType: 'direct', text: 'Alice: hi' }, names).text).toBe('Alice: hi');
      expect(run({ messageType: 'channel', text: `${'x'.repeat(40)}: hi` }, names).text).toBe(`${'x'.repeat(40)}: hi`);
    });
    it('does nothing when hideLongNames is off, and hides the whole text when hideMessageText is on', () => {
      expect(run({ messageType: 'channel', text: 'Alice: hi' }, only({ hidePublicKeys: true })).text).toBe('Alice: hi');
      expect(run({ messageType: 'channel', text: 'Alice: hi' }, ON).text).toBe(PUBLIC_INSTANCE_HIDDEN_TEXT);
    });
  });
});
