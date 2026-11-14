/**
 * Direct RF Contacts report helpers (#6210): window presets, sorting, CSV.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDailySlots,
  buildDirectRfCsv,
  contactLabel,
  directRfCsvFilename,
  isDirectRfSourceType,
  resolveWindow,
  sortContacts,
  type DirectRfContact,
} from './directRfContacts';

const row = (o: Partial<DirectRfContact> = {}): DirectRfContact => ({
  nodeKey: '!aaaaaaaa', nodeNum: 0xaaaaaaaa, protocol: 'meshtastic', name: 'Alpha', shortName: 'AL',
  firstHeardAt: Date.UTC(2026, 0, 1), lastHeardAt: Date.UTC(2026, 0, 2), receptionCount: 4, daysHeard: 2,
  bestSnr: 6, avgSnr: 4.5, bestRssi: -80, avgRssi: -88.2, distanceKm: 3.21,
  ...o,
});

describe('resolveWindow', () => {
  it('maps presets to a window ending now', () => {
    expect(resolveWindow('24h', 100_000_000)).toEqual({ from: 100_000_000 - 86_400_000, to: 100_000_000 });
    expect(resolveWindow('30d', 10 * 86_400_000 * 10)).toEqual({ from: 70 * 86_400_000, to: 100 * 86_400_000 });
  });
  it('spans whole local days for a custom range and rejects an empty one', () => {
    const w = resolveWindow('custom', 0, '2026-03-01', '2026-03-02');
    expect(w!.from).toBe(new Date('2026-03-01T00:00:00').getTime());
    expect(w!.to).toBe(new Date('2026-03-02T23:59:59.999').getTime());
    expect(resolveWindow('custom', 0, '2026-03-02', '2026-03-01')).toBeNull();
    expect(resolveWindow('custom', 0, '', '2026-03-01')).toBeNull();
  });
});

describe('sortContacts', () => {
  const rows = [
    row({ nodeKey: '!1', name: 'bravo', receptionCount: 2, bestSnr: null }),
    row({ nodeKey: '!2', name: 'Alpha', receptionCount: 9, bestSnr: 3 }),
    row({ nodeKey: '!3', name: 'charlie', receptionCount: 5, bestSnr: 8 }),
  ];
  it('sorts numbers both ways and keeps nulls last', () => {
    expect(sortContacts(rows, 'receptionCount', 'desc').map((r) => r.nodeKey)).toEqual(['!2', '!3', '!1']);
    expect(sortContacts(rows, 'bestSnr', 'asc').map((r) => r.nodeKey)).toEqual(['!2', '!3', '!1']);
    expect(sortContacts(rows, 'bestSnr', 'desc').map((r) => r.nodeKey)).toEqual(['!3', '!2', '!1']);
  });
  it('sorts names case-insensitively and does not mutate the input', () => {
    expect(sortContacts(rows, 'name', 'asc').map((r) => r.nodeKey)).toEqual(['!2', '!1', '!3']);
    expect(rows[0].nodeKey).toBe('!1');
  });
});

describe('contactLabel', () => {
  it('falls back from name to short name to the id', () => {
    expect(contactLabel(row())).toBe('Alpha');
    expect(contactLabel(row({ name: null }))).toBe('AL');
    expect(contactLabel(row({ name: null, shortName: null }))).toBe('!aaaaaaaa');
    expect(contactLabel(row({ name: null, shortName: null, protocol: 'meshcore', nodeKey: 'ab'.repeat(32) }))).toBe('abababababab…');
  });
});

describe('buildDirectRfCsv', () => {
  it('writes a header and one CRLF row per contact, with ISO times and blanks for nulls', () => {
    const csv = buildDirectRfCsv([row({ avgSnr: null, distanceKm: null })]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('node_id,name,short_name,protocol,first_heard_direct,last_heard_direct,direct_receptions,days_heard,best_snr_db,avg_snr_db,best_rssi_dbm,avg_rssi_dbm,distance_km');
    expect(lines[1]).toBe('!aaaaaaaa,Alpha,AL,meshtastic,2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z,4,2,6,,-80,-88.2,');
    expect(lines[2]).toBe('');
  });
  it('guards mesh-supplied names against spreadsheet formulas and escapes commas', () => {
    const csv = buildDirectRfCsv([row({ name: '=HYPERLINK("x")', shortName: 'a,b' })]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"a,b"');
  });
});

describe('misc', () => {
  it('builds a safe file name', () => {
    expect(directRfCsvFilename('Home Base #1', Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 8)))
      .toBe('direct-rf-contacts_Home_Base_1_2026-01-01_2026-01-08.csv');
  });
  it('offers only sources with their own radio', () => {
    expect(isDirectRfSourceType('meshtastic_tcp')).toBe(true);
    expect(isDirectRfSourceType('meshcore')).toBe(true);
    expect(isDirectRfSourceType('mqtt_broker')).toBe(false);
    expect(isDirectRfSourceType('meshcore_mqtt')).toBe(false);
  });
  it('builds one slot per UTC day ending today, zero-filling gaps', () => {
    const day = 86_400_000;
    const now = 100 * day + 5;
    const slots = buildDailySlots([
      { dayBucket: 100 * day, receptionCount: 4, firstHeardAt: 0, lastHeardAt: 0, bestSnr: null, bestRssi: null },
      { dayBucket: 98 * day, receptionCount: 2, firstHeardAt: 0, lastHeardAt: 0, bestSnr: null, bestRssi: null },
    ], now, 4);
    expect(slots).toEqual([0, 2, 0, 4]);
  });
});
