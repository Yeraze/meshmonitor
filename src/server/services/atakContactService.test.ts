/**
 * ATAK Contact Service — mapper tests (ATAK/CoT Phase 2, issue #3691)
 *
 * `buildContactRow` is a pure function (no DB/singleton concerns), so these
 * tests exercise it directly against the edge cases enumerated in
 * docs/internal/dev-notes/ATAK_COT_PHASE2_SPEC.md §3/§4: full PLI, missing
 * group/status, no device_callsign, compressed → nodeNum-keyed uid, 0/0
 * coords → null lat/lon, no-pli → null.
 */
import { describe, it, expect } from 'vitest';
import { buildContactRow, ATAK_CONTACT_STALE_MS, ATAK_CONTACT_RETENTION_MS } from './atakContactService.js';

const makeMeshPacket = (from: number) => ({ from, to: 0xffffffff, id: 1, channel: 0 });

describe('atakContactService.buildContactRow', () => {
  it('maps a full PLI (contact + group + status) to a contact row', () => {
    const meshPacket = makeMeshPacket(0x1111);
    const tak = {
      contact: { callsign: 'ALPHA-1', deviceCallsign: 'EUD-001' },
      group: { role: 2, team: 9 },
      status: { battery: 87 },
      pli: { latitudeI: 371234500, longitudeI: -1225432100, altitude: 120, speed: 3, course: 90 },
    };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      uid: 'EUD-001',
      sourceId: 'source-a',
      nodeNum: 0x1111,
      callsign: 'ALPHA-1',
      deviceCallsign: 'EUD-001',
      team: 9,
      role: 2,
      battery: 87,
      altitude: 120,
      speed: 3,
      course: 90,
    });
    expect(row!.latitude).toBeCloseTo(37.12345, 5);
    expect(row!.longitude).toBeCloseTo(-122.54321, 5);
    expect(row!.lastSeen).toBe(row!.createdAt);
  });

  it('handles snake_case protobuf field fallbacks identically to camelCase', () => {
    const meshPacket = makeMeshPacket(0x1111);
    const tak = {
      contact: { callsign: 'ALPHA-1', device_callsign: 'EUD-001' },
      pli: { latitude_i: 371234500, longitude_i: -1225432100, altitude: 5, speed: 1, course: 10 },
    };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row?.deviceCallsign).toBe('EUD-001');
    expect(row?.uid).toBe('EUD-001');
    expect(row?.latitude).toBeCloseTo(37.12345, 5);
  });

  it('nulls team/role/battery when group/status are absent', () => {
    const meshPacket = makeMeshPacket(0x1111);
    const tak = {
      contact: { callsign: 'ALPHA-1', deviceCallsign: 'EUD-001' },
      pli: { latitudeI: 371234500, longitudeI: -1225432100 },
    };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row?.team).toBeNull();
    expect(row?.role).toBeNull();
    expect(row?.battery).toBeNull();
  });

  it('falls back uid to callsign when device_callsign is absent', () => {
    const meshPacket = makeMeshPacket(0x1111);
    const tak = {
      contact: { callsign: 'ALPHA-1' },
      pli: { latitudeI: 371234500, longitudeI: -1225432100 },
    };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row?.uid).toBe('ALPHA-1');
    expect(row?.deviceCallsign).toBeNull();
  });

  it('falls back uid to !<nodeNum hex> when contact is entirely absent', () => {
    const meshPacket = makeMeshPacket(0x1111);
    const tak = { pli: { latitudeI: 371234500, longitudeI: -1225432100 } };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row?.uid).toBe('!00001111');
    expect(row?.callsign).toBeNull();
    expect(row?.deviceCallsign).toBeNull();
  });

  it('keys uid on the nodeNum fallback when is_compressed=true, even with device_callsign present', () => {
    const meshPacket = makeMeshPacket(0x2222);
    const tak = {
      isCompressed: true,
      contact: { callsign: 'garbled-bytes', deviceCallsign: 'also-garbled' },
      pli: { latitudeI: 371234500, longitudeI: -1225432100 },
    };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row?.uid).toBe('!00002222');
    // The (unreliable) string fields are still persisted as received.
    expect(row?.callsign).toBe('garbled-bytes');
    expect(row?.deviceCallsign).toBe('also-garbled');
  });

  it('respects the snake_case is_compressed flag for the same nodeNum-keying rule', () => {
    const meshPacket = makeMeshPacket(0x2222);
    const tak = {
      is_compressed: true,
      contact: { deviceCallsign: 'EUD-999' },
      pli: { latitudeI: 371234500, longitudeI: -1225432100 },
    };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row?.uid).toBe('!00002222');
  });

  it('nulls latitude/longitude for 0/0 (Null Island) coords but still persists the row', () => {
    const meshPacket = makeMeshPacket(0x1111);
    const tak = {
      contact: { deviceCallsign: 'EUD-001' },
      pli: { latitudeI: 0, longitudeI: 0 },
    };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row).not.toBeNull();
    expect(row?.latitude).toBeNull();
    expect(row?.longitude).toBeNull();
    expect(row?.uid).toBe('EUD-001');
  });

  it('nulls latitude/longitude for out-of-range coords but still persists the row', () => {
    const meshPacket = makeMeshPacket(0x1111);
    const tak = {
      contact: { deviceCallsign: 'EUD-001' },
      // 185345000 * 1e-7 = 18.5345 -- fine; use an out-of-range raw int instead
      pli: { latitudeI: 1853450000, longitudeI: -1225432100 },
    };

    const row = buildContactRow(meshPacket, tak, 'source-a');

    expect(row?.latitude).toBeNull();
    expect(row?.longitude).toBeNull();
  });

  it('returns null when there is no pli variant (chat or detail)', () => {
    const meshPacket = makeMeshPacket(0x1111);

    expect(buildContactRow(meshPacket, { chat: { message: 'hi' } }, 'source-a')).toBeNull();
    expect(buildContactRow(meshPacket, { detail: new Uint8Array([1, 2, 3]) }, 'source-a')).toBeNull();
    expect(buildContactRow(meshPacket, {}, 'source-a')).toBeNull();
  });

  it('returns null for a malformed/undecoded tak shape', () => {
    const meshPacket = makeMeshPacket(0x1111);

    expect(buildContactRow(meshPacket, null, 'source-a')).toBeNull();
    expect(buildContactRow(meshPacket, new Uint8Array([1, 2, 3]), 'source-a')).toBeNull();
  });

  it('exposes the fixed stale/retention window constants', () => {
    expect(ATAK_CONTACT_STALE_MS).toBe(15 * 60 * 1000);
    expect(ATAK_CONTACT_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });
});
