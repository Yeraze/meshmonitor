import { describe, it, expect } from 'vitest';
import { buildExport, parseImport } from './meshcoreRepeaterSettingsExport.js';
import { getRepeaterGates } from './meshcoreRepeaterSettings.js';

const gates = getRepeaterGates('v1.18.0');
const values = {
  name: 'Hill', lat: 1.5, lon: 2.5, radio: '869.618,62.5,8,8', txPower: 20,
  advertInterval: 120, floodAdvertInterval: 24, floodMax: 10, repeat: true, allowReadOnly: false,
  guestPassword: 'secret1', adminPassword: 'secret2',
};

describe('buildExport', () => {
  it('never exports secrets and omits identity by default', () => {
    const e = buildExport(values as never, { deviceType: 'repeater', firmware: 'v1.18.0', now: new Date(0) });
    expect(e.values).toEqual({ txPower: 20, advertInterval: 120, floodAdvertInterval: 24, floodMax: 10, repeat: true, allowReadOnly: false });
    expect(JSON.stringify(e)).not.toContain('secret');
    expect(e).toMatchObject({ schema: 'meshmonitor.meshcore.repeater-settings', v: 1, deviceType: 'repeater', exportedAt: '1970-01-01T00:00:00.000Z' });
  });
  it('includes name / lat / lon / radio on opt-in, still no secrets', () => {
    const e = buildExport(values as never, { deviceType: 'repeater', includeIdentity: true });
    expect(e.values).toMatchObject({ name: 'Hill', lat: 1.5, lon: 2.5, radio: '869.618,62.5,8,8' });
    expect(JSON.stringify(e)).not.toContain('secret');
  });
  it('drops keys the device type does not have', () => {
    expect(buildExport(values as never, { deviceType: 'room' }).values.repeat).toBeUndefined();
  });
});

describe('parseImport', () => {
  const file = (v: Record<string, unknown>) => ({ schema: 'meshmonitor.meshcore.repeater-settings', v: 1, values: v });
  it('rejects non-exports', () => {
    expect(parseImport('nope', { deviceType: 'repeater', gates }).ok).toBe(false);
    expect(parseImport({ schema: 'x', v: 1, values: {} }, { deviceType: 'repeater', gates }).ok).toBe(false);
  });
  it('drops identity keys by default and keeps them on opt-in', () => {
    const f = file({ name: 'N', lat: 1, floodMax: 5 });
    const a = parseImport(f, { deviceType: 'repeater', gates });
    expect(a.draft).toEqual({ floodMax: 5 });
    expect(a.notes.map((n) => n.key).sort()).toEqual(['lat', 'name']);
    expect(parseImport(f, { deviceType: 'repeater', gates, includeIdentity: true }).draft).toEqual({ name: 'N', lat: 1, floodMax: 5 });
  });
  it('drops secrets, unknown keys, room forwarding keys, and remote radio, each with a note', () => {
    const r = parseImport(file({ guestPassword: 'x', adminPassword: 'y', foo: 1, repeat: true, txPower: 10 }), { deviceType: 'room', gates, mode: 'remote' });
    expect(r.draft).toEqual({ txPower: 10 });
    expect(r.notes.map((n) => n.key).sort()).toEqual(['adminPassword', 'foo', 'guestPassword', 'repeat']);
    const radio = parseImport(file({ radio: '869.618,62.5,8,8' }), { deviceType: 'repeater', gates, mode: 'remote', includeIdentity: true });
    expect(radio.draft).toEqual({});
    expect(radio.notes[0].key).toBe('radio');
  });
  it('validates values via the schema; a bad one drops only itself', () => {
    const r = parseImport(file({ floodMax: 99, advertInterval: 121, repeat: false }), { deviceType: 'repeater', gates });
    expect(r.draft).toEqual({ advertInterval: 120, repeat: false });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0].key).toBe('floodMax');
  });
  it('round-trips an export', () => {
    const e = buildExport(values as never, { deviceType: 'repeater', includeIdentity: true });
    const r = parseImport(JSON.stringify(e), { deviceType: 'repeater', gates, includeIdentity: true });
    expect(r.draft).toEqual(e.values);
    expect(r.notes).toEqual([]);
  });
});
