import { describe, it, expect } from 'vitest';
import {
  REPEATER_SETTINGS,
  parseRadioValue,
  settingsFor,
  formatSet,
  getRepeaterGates,
  isRepeaterReplyTerminator,
  parseCliReply,
  validateRepeaterPatch,
  validateRepeaterValue,
} from './meshcoreRepeaterSettings.js';
import { estimateLoraAirtimeMs } from './loraAirtime.js';
import { REPEATER_REPLY_FIXTURES } from '../server/utils/__fixtures__/repeaterCliReplies.js';

describe('parseCliReply fixtures', () => {
  for (const fx of REPEATER_REPLY_FIXTURES) {
    for (const form of ['local', 'remote'] as const) {
      it(`${fx.name} (${form}) -> ${fx.kind}`, () => {
        const r = parseCliReply(fx[form]);
        expect(r.kind).toBe(fx.kind);
        if (fx.kind === 'value') expect(r.value).toBe(fx.value);
        expect(r.text).not.toContain('hunter2');
      });
    }
  }

  it('empty and unclassified', () => {
    expect(parseCliReply('').kind).toBe('empty');
    expect(parseCliReply('  -> 14:05 - 2/10/2026 UTC').kind).toBe('other');
  });
});

describe('reply terminators', () => {
  it('ends on every fixture reply', () => {
    for (const fx of REPEATER_REPLY_FIXTURES.filter((x) => x.name !== 'get empty guest password' && x.kind !== 'empty')) {
      expect(isRepeaterReplyTerminator(fx.local), fx.local).toBe(true);
    }
  });
  it('does not end on plain text', () => {
    expect(isRepeaterReplyTerminator('  -> 14:05 - 2/10/2026 UTC')).toBe(false);
  });
});

describe('version gates', () => {
  it('1.11 caps flood advert at 48 h, 1.12 does not', () => {
    expect(getRepeaterGates('v1.11.0').floodAdvertMaxHours).toBe(48);
    expect(getRepeaterGates('v1.12.0').floodAdvertMaxHours).toBe(168);
  });
  it('1.14 has no poweroff, 1.15 does', () => {
    expect(getRepeaterGates('1.14.2 (Build: x)').powerOff).toBe(false);
    expect(getRepeaterGates('v1.15.0').powerOff).toBe(true);
  });
  it('1.8 exports the key but cannot import it', () => {
    const g = getRepeaterGates('v1.8.1');
    expect(g.keyExport).toBe(true);
    expect(g.keyImport).toBe(false);
    expect(getRepeaterGates('v1.9.0').keyImport).toBe(true);
  });
  it('unparseable version opens every gate', () => {
    const g = getRepeaterGates(undefined);
    expect(g).toMatchObject({ floodAdvertMaxHours: 168, powerOff: true, keyExport: true, keyImport: true });
  });
});

describe('validation', () => {
  const gates = getRepeaterGates(null);
  it('advert interval: Off, 60-240, odd floored', () => {
    expect(validateRepeaterValue('advertInterval', 0, gates)).toEqual({ ok: true, value: 0 });
    expect(validateRepeaterValue('advertInterval', 60, gates)).toEqual({ ok: true, value: 60 });
    expect(validateRepeaterValue('advertInterval', 61, gates)).toEqual({ ok: true, value: 60 });
    expect(validateRepeaterValue('advertInterval', 241, gates).ok).toBe(false);
    expect(validateRepeaterValue('advertInterval', 240, gates)).toEqual({ ok: true, value: 240 });
    expect(validateRepeaterValue('advertInterval', 59, gates).ok).toBe(false);
  });
  it('flood advert: Off, 6-168, 48 cap below 1.12', () => {
    expect(validateRepeaterValue('floodAdvertInterval', 0, gates).ok).toBe(true);
    expect(validateRepeaterValue('floodAdvertInterval', 5, gates).ok).toBe(false);
    expect(validateRepeaterValue('floodAdvertInterval', 169, gates).ok).toBe(false);
    expect(validateRepeaterValue('floodAdvertInterval', 49, getRepeaterGates('v1.11.0')).ok).toBe(false);
    expect(validateRepeaterValue('floodAdvertInterval', 48, getRepeaterGates('v1.11.0')).ok).toBe(true);
  });
  it('knobs use firmware ranges', () => {
    expect(validateRepeaterValue('floodMax', 65, gates).ok).toBe(false);
    expect(validateRepeaterValue('floodMax', 0, gates).ok).toBe(true);
    expect(validateRepeaterValue('af', 9.1, gates).ok).toBe(false);
    expect(validateRepeaterValue('af', 9, gates).ok).toBe(true);
    expect(validateRepeaterValue('rxDelay', 21, gates).ok).toBe(false);
    expect(validateRepeaterValue('txDelay', 2.1, gates).ok).toBe(false);
    expect(validateRepeaterValue('directTxDelay', 2, gates).ok).toBe(true);
  });
  it('passwords: bytes and control chars', () => {
    expect(validateRepeaterValue('adminPassword', '', gates).ok).toBe(false);
    expect(validateRepeaterValue('adminPassword', 'a'.repeat(16), gates).ok).toBe(false);
    expect(validateRepeaterValue('adminPassword', 'a'.repeat(15), gates).ok).toBe(true);
    expect(validateRepeaterValue('guestPassword', '', gates).ok).toBe(true);
    expect(validateRepeaterValue('guestPassword', 'a\r\nset prv.key x', gates).ok).toBe(false);
    expect(validateRepeaterValue('guestPassword', 'é'.repeat(8), gates).ok).toBe(false); // 16 bytes
  });
  it('patch reports unknown keys and bad types', () => {
    const r = validateRepeaterPatch({ nope: 1, repeat: 'on', af: 1 }, gates);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field).sort()).toEqual(['nope', 'repeat']);
    expect(r.values).toEqual({ af: 1 });
  });
});

describe('formatSet', () => {
  it('formats each type', () => {
    expect(formatSet('repeat', false)).toBe('set repeat off');
    expect(formatSet('allowReadOnly', true)).toBe('set allow.read.only on');
    expect(formatSet('advertInterval', 120)).toBe('set advert.interval 120');
    expect(formatSet('af', 0.5)).toBe('set af 0.5');
    expect(formatSet('lat', 40.123456789)).toBe('set lat 40.123457');
    expect(formatSet('adminPassword', 'pw')).toBe('password pw');
    expect(formatSet('guestPassword', '')).toBe('set guest.password ');
  });
  it('refuses control characters', () => {
    expect(() => formatSet('guestPassword', 'a\nb')).toThrow();
  });
  it('schema has one entry per key with secret flags', () => {
    expect(new Set(REPEATER_SETTINGS.map((d) => d.key)).size).toBe(REPEATER_SETTINGS.length);
    expect(REPEATER_SETTINGS.filter((d) => d.secret).map((d) => d.key)).toEqual(['adminPassword', 'guestPassword']);
    expect(REPEATER_SETTINGS.find((d) => d.key === 'adminPassword')?.localOnly).toBe(true);
  });
});

describe('estimateLoraAirtimeMs', () => {
  const near = (a: number, b: number) => Math.abs(a - b) / b <= 0.02;
  it('matches the spec reference values at 125 B', () => {
    expect(near(estimateLoraAirtimeMs(125, { sf: 7, bw: 62.5, cr: 5 }), 470)).toBe(true);
    expect(near(estimateLoraAirtimeMs(125, { sf: 10, bw: 250, cr: 5 }), 650)).toBe(true);
    expect(near(estimateLoraAirtimeMs(125, { sf: 11, bw: 250, cr: 5 }), 1170)).toBe(true);
    expect(near(estimateLoraAirtimeMs(125, { sf: 8, bw: 62.5, cr: 8 }), 1230)).toBe(true);
  });
  it('rejects nonsense', () => {
    expect(estimateLoraAirtimeMs(10, { sf: 3, bw: 125, cr: 5 })).toBeNaN();
  });
});

describe('P10 schema: settingsFor / remote capability', () => {
  const keys = (o: Parameters<typeof settingsFor>[0]) => settingsFor(o).map((d) => d.key);
  const FORWARDING = ['repeat', 'floodMax', 'rxDelay', 'txDelay', 'directTxDelay'];

  it('derives localOnly from remote: none', () => {
    for (const d of REPEATER_SETTINGS) expect(d.localOnly).toBe(d.remote === 'none');
  });
  it('remote repeater: no admin password, radio listed but read-only', () => {
    const k = keys({ mode: 'remote', deviceType: 'repeater' });
    expect(k).not.toContain('adminPassword');
    expect(k).toContain('radio');
    expect(k).toContain('guestPassword');
    for (const f of FORWARDING) expect(k).toContain(f);
  });
  it('local repeater offers the admin password', () => {
    expect(keys({ mode: 'local', deviceType: 'repeater' })).toContain('adminPassword');
  });
  it('room hides forwarding keys in both modes', () => {
    for (const mode of ['local', 'remote'] as const) {
      const k = keys({ mode, deviceType: 'room' });
      for (const f of FORWARDING) expect(k).not.toContain(f);
      expect(k).toContain('advertInterval');
      expect(k).toContain('name');
    }
  });
  it('groups: identity 5, adverts 8, access 2 (remote repeater)', () => {
    const n = (g: 'identity' | 'adverts' | 'access') =>
      keys({ mode: 'remote', deviceType: 'repeater', groups: [g] }).length;
    expect([n('identity'), n('adverts'), n('access')]).toEqual([5, 8, 2]);
  });
  it('parseRadioValue', () => {
    expect(parseRadioValue('869.618,62.5,8,8')).toEqual({ freq: 869.618, bw: 62.5, sf: 8, cr: 8 });
    expect(parseRadioValue('869.618,62.5,8')).toBeNull();
    expect(parseRadioValue('a,b,c,d')).toBeNull();
    expect(parseRadioValue(null)).toBeNull();
  });
  it('formats and validates the new keys', () => {
    expect(formatSet('txPower', 14)).toBe('set tx 14');
    expect(formatSet('name', 'Hill 1')).toBe('set name Hill 1');
    expect(validateRepeaterValue('name', 'x'.repeat(32)).ok).toBe(false);
    expect(validateRepeaterValue('name', '').ok).toBe(false);
    expect(validateRepeaterValue('name', 'a\nb').ok).toBe(false);
    expect(validateRepeaterValue('txPower', 31).ok).toBe(false);
    expect(validateRepeaterValue('radio', '869.618,62.5,8,8').ok).toBe(true);
    expect(validateRepeaterValue('radio', '869.618,62.5,99,8').ok).toBe(false);
  });
  it('a write context rejects keys that are not writable, with the field', () => {
    const remote = { mode: 'remote', deviceType: 'repeater' } as const;
    const r = validateRepeaterPatch({ adminPassword: 'x', radio: '869.618,62.5,8,8', name: 'ok' }, undefined, remote);
    expect(r.errors.map((e) => e.field).sort()).toEqual(['adminPassword', 'radio']);
    expect(r.values).toEqual({ name: 'ok' });
    const room = validateRepeaterPatch({ repeat: true }, undefined, { mode: 'remote', deviceType: 'room' });
    expect(room.errors[0]).toMatchObject({ field: 'repeat', code: 'VALIDATION' });
  });
  it('without a context the P9 behaviour is unchanged (admin password allowed)', () => {
    expect(validateRepeaterPatch({ adminPassword: 'x' }).ok).toBe(true);
  });
});
