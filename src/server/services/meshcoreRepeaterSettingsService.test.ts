import { describe, it, expect } from 'vitest';
import {
  readRepeaterSettings,
  writeRepeaterSettings,
  type RepeaterCliTransport,
} from './meshcoreRepeaterSettingsService.js';
import { getRepeaterGates } from '../../utils/meshcoreRepeaterSettings.js';

/** A fake repeater: get/set over an in-memory store, with optional per-command overrides. */
function fakeDevice(over: Record<string, string> = {}, ignoreSet: string[] = []) {
  const store: Record<string, string> = {
    lat: '40.5', lon: '-74.25', 'advert.interval': '120', 'flood.advert.interval': '47',
    'flood.max': '64', repeat: 'on', af: '1', rxdelay: '0', txdelay: '0.5', 'direct.txdelay': '0.2',
    'guest.password': 'guest1', 'allow.read.only': 'off',
  };
  const sent: string[] = [];
  const t: RepeaterCliTransport = {
    mode: 'local',
    async run(cmd) {
      sent.push(cmd);
      if (cmd in over) return over[cmd];
      let m = /^get (\S+)$/.exec(cmd);
      if (m) return m[1] in store ? `  -> > ${store[m[1]]}` : '  -> unknown config: x';
      m = /^set (\S+) (.*)$/.exec(cmd);
      if (m) {
        if (!ignoreSet.includes(m[1])) store[m[1]] = m[2];
        return '  -> OK';
      }
      if (cmd.startsWith('password ')) return `  -> password now: ${cmd.slice(9)}`;
      return '  -> Unknown command';
    },
  };
  return { t, sent, store };
}

const gates = getRepeaterGates('v1.17.0');

describe('readRepeaterSettings', () => {
  it('reads typed values and never returns the guest password', async () => {
    const { t } = fakeDevice();
    const r = await readRepeaterSettings(t, gates);
    expect(r.values).toMatchObject({
      lat: 40.5, advertInterval: 120, floodAdvertInterval: 47, repeat: true, allowReadOnly: false, af: 1, txDelay: 0.5,
    });
    expect(r.guestPasswordSet).toBe(true);
    expect(JSON.stringify(r)).not.toContain('guest1');
    expect('guestPassword' in r.values).toBe(false);
  });
  it('records per-key errors for unsupported verbs', async () => {
    const { t } = fakeDevice({ 'get af': '  -> unknown config: af' });
    const r = await readRepeaterSettings(t, gates);
    expect(r.errors.af).toMatch(/not supported/);
    expect(r.values.af).toBeUndefined();
  });
});

describe('writeRepeaterSettings', () => {
  it('sends only changed keys, then re-reads everything', async () => {
    const { t, sent } = fakeDevice();
    const current = (await readRepeaterSettings(t, gates)).values;
    sent.length = 0;
    const r = await writeRepeaterSettings(t, gates, current, { advertInterval: 120, floodMax: 10, repeat: true });
    const sets = sent.filter((c) => c.startsWith('set '));
    expect(sets).toEqual(['set flood.max 10']);
    expect(sent.filter((c) => c.startsWith('get ')).length).toBeGreaterThanOrEqual(11);
    expect(r.ok).toBe(true);
    expect(r.results.floodMax).toMatchObject({ ok: true, changed: true, value: 10 });
    expect(r.results.advertInterval).toMatchObject({ ok: true, changed: false });
    expect(r.read.values.floodMax).toBe(10);
  });

  it('floors odd advert minutes before sending', async () => {
    const { t, sent } = fakeDevice();
    const current = (await readRepeaterSettings(t, gates)).values;
    const r = await writeRepeaterSettings(t, gates, current, { advertInterval: 181 });
    expect(sent).toContain('set advert.interval 180');
    expect(r.results.advertInterval).toMatchObject({ ok: true, value: 180 });
  });

  it('Off (0) is sent for both intervals', async () => {
    const { t, sent } = fakeDevice();
    const current = (await readRepeaterSettings(t, gates)).values;
    await writeRepeaterSettings(t, gates, current, { advertInterval: 0, floodAdvertInterval: 0 });
    expect(sent).toContain('set advert.interval 0');
    expect(sent).toContain('set flood.advert.interval 0');
  });

  it('a validation error sends nothing', async () => {
    const { t, sent } = fakeDevice();
    const r = await writeRepeaterSettings(t, gates, {}, { floodMax: 65, repeat: false });
    expect(r.validationFailed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.results.floodMax?.code).toBe('VALIDATION');
    expect(sent).toEqual([]);
  });

  it('a readback mismatch is a key error', async () => {
    const { t } = fakeDevice({}, ['flood.max']);
    const current = (await readRepeaterSettings(t, gates)).values;
    const r = await writeRepeaterSettings(t, gates, current, { floodMax: 10, repeat: false });
    expect(r.ok).toBe(false);
    expect(r.results.floodMax).toMatchObject({ ok: false, code: 'READBACK_MISMATCH', value: 64 });
    expect(r.results.repeat).toMatchObject({ ok: true });
  });

  it('a firmware rejection is a key error and other keys still go', async () => {
    const { t } = fakeDevice({ 'set af 2': '  -> ERROR: af must be 0-9' });
    const current = (await readRepeaterSettings(t, gates)).values;
    const r = await writeRepeaterSettings(t, gates, current, { af: 2, floodMax: 5 });
    expect(r.results.af).toMatchObject({ ok: false, code: 'REJECTED', error: 'ERROR: af must be 0-9' });
    expect(r.results.floodMax?.ok).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('no reply is NO_REPLY', async () => {
    const { t } = fakeDevice({ 'set repeat off': '' });
    const current = (await readRepeaterSettings(t, gates)).values;
    const r = await writeRepeaterSettings(t, gates, current, { repeat: false });
    expect(r.results.repeat?.code).toBe('NO_REPLY');
  });

  it('secrets: sent with the secret flag, never echoed in results', async () => {
    const calls: { cmd: string; secret?: boolean }[] = [];
    const { t: base } = fakeDevice();
    const t: RepeaterCliTransport = {
      mode: 'local',
      run: (cmd, o) => (calls.push({ cmd, secret: o?.secret }), base.run(cmd, o)),
    };
    const current = (await readRepeaterSettings(t, gates)).values;
    const r = await writeRepeaterSettings(t, gates, current, { adminPassword: 'hunter2', guestPassword: 'newguest' });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.cmd === 'password hunter2')?.secret).toBe(true);
    expect(calls.find((c) => c.cmd === 'set guest.password newguest')?.secret).toBe(true);
    expect(calls.filter((c) => c.cmd === 'get guest.password').every((c) => c.secret)).toBe(true);
    const json = JSON.stringify(r);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('newguest');
    expect(json).not.toContain('guest1');
    expect(r.read.guestPasswordSet).toBe(true);
  });

  it('an unchanged guest password is not re-sent; a rejected secret shows no text', async () => {
    const { t, sent } = fakeDevice({ 'password bad': '  -> Error, whatever bad' });
    const current = (await readRepeaterSettings(t, gates)).values;
    const r = await writeRepeaterSettings(t, gates, current, { guestPassword: 'guest1', adminPassword: 'bad' });
    expect(sent.filter((c) => c.startsWith('set guest.password'))).toEqual([]);
    expect(r.results.adminPassword?.error).toBe('rejected by the device');
  });

  it('reports drift on keys not in the patch', async () => {
    // First save zeroes advert.interval (CommonCLI.cpp:160-168).
    const { t, store } = fakeDevice();
    const base = t.run.bind(t);
    t.run = async (cmd, o) => {
      const rep = await base(cmd, o);
      if (cmd.startsWith('set ')) store['advert.interval'] = '0';
      return rep;
    };
    const current = (await readRepeaterSettings(t, gates)).values;
    const r = await writeRepeaterSettings(t, gates, current, { floodMax: 5 });
    expect(r.drifted).toEqual(['advertInterval']);
  });
});

/** Remote fake: bare replies, counts every transport call, optional timeout on a command. */
function remoteDevice(opts: { timeoutOn?: string; noReplyOn?: string } = {}) {
  const store: Record<string, string> = {
    'advert.interval': '30', 'flood.advert.interval': '47', 'guest.password': 'g', 'allow.read.only': 'off',
    tx: '22', name: 'Hill', repeat: 'on',
  };
  const sent: string[] = [];
  const t: RepeaterCliTransport = {
    mode: 'remote',
    async run(cmd) {
      sent.push(cmd);
      if (cmd === opts.timeoutOn) throw new Error('CLI timeout');
      if (cmd === opts.noReplyOn) return '';
      let m = /^get (\S+)$/.exec(cmd);
      if (m) return m[1] in store ? `> ${store[m[1]]}` : 'unknown config: x';
      m = /^set (\S+) (.*)$/.exec(cmd);
      if (m) {
        store[m[1]] = m[2];
        return 'OK';
      }
      return 'Unknown command';
    },
  };
  return { t, sent, store };
}

describe('remote settings (P10)', () => {
  it('reads only the requested keys', async () => {
    const { t, sent } = remoteDevice();
    const r = await readRepeaterSettings(t, gates, { keys: ['name', 'txPower'] });
    expect(sent).toEqual(['get name', 'get tx']);
    expect(r.values).toEqual({ name: 'Hill', txPower: 22 });
  });
  it('default remote read skips the admin password and honours the room device type', async () => {
    const { t, sent } = remoteDevice();
    await readRepeaterSettings(t, gates, { deviceType: 'room' });
    expect(sent).not.toContain('get repeat');
    expect(sent).not.toContain('get flood.max');
    expect(sent).toContain('get radio');
  });
  it('a read stops at the first timeout and marks the rest not read', async () => {
    const { t, sent } = remoteDevice({ timeoutOn: 'get tx' });
    const r = await readRepeaterSettings(t, gates, { keys: ['name', 'txPower', 'lat'] });
    expect(sent).toEqual(['get lat', 'get name', 'get tx']);
    expect(r.stoppedAt).toBe('txPower');
    expect(r.errors.txPower).toMatch(/timeout/);
  });
  it("'sent' sends changed keys only, no pre-read, reads back only those", async () => {
    const { t, sent } = remoteDevice();
    const r = await writeRepeaterSettings(t, gates, {}, { txPower: 20, allowReadOnly: true });
    expect(sent).toEqual(['set allow.read.only on', 'set tx 20', 'get allow.read.only', 'get tx']);
    expect(r.ok).toBe(true);
    expect(r.results.txPower).toMatchObject({ ok: true, value: 20 });
    expect(r.read.values).toEqual({ allowReadOnly: true, txPower: 20 });
  });
  it('a supplied guest password is always sent, with no pre-read', async () => {
    const { t, sent } = remoteDevice();
    const r = await writeRepeaterSettings(t, gates, {}, { guestPassword: 'g' });
    expect(sent).toEqual(['set guest.password g', 'get guest.password']);
    expect(JSON.stringify(r)).not.toContain('"g"');
    expect(r.read.guestPasswordSet).toBe(true);
  });
  it('re-reads advertInterval when it was cached at 1-59 and reports the drift', async () => {
    const { t, sent, store } = remoteDevice();
    store['advert.interval'] = '0'; // firmware zeroed it
    const r = await writeRepeaterSettings(t, gates, { advertInterval: 30 }, { txPower: 20 });
    expect(sent).toEqual(['set tx 20', 'get advert.interval', 'get tx']);
    expect(r.drifted).toEqual(['advertInterval']);
  });
  it('does not re-read advertInterval when cached outside 1-59', async () => {
    const { t, sent } = remoteDevice();
    await writeRepeaterSettings(t, gates, { advertInterval: 120 }, { txPower: 20 });
    expect(sent).toEqual(['set tx 20', 'get tx']);
  });
  it('stops at the first timeout: rest NOT_SENT, exactly N calls, no readback', async () => {
    const { t, sent } = remoteDevice({ timeoutOn: 'set tx 20' });
    const r = await writeRepeaterSettings(t, gates, {}, { floodAdvertInterval: 24, txPower: 20, allowReadOnly: true });
    // schema order: floodAdvertInterval, allowReadOnly, txPower
    expect(sent).toEqual(['set flood.advert.interval 24', 'set allow.read.only on', 'set tx 20']);
    expect(r.ok).toBe(false);
    expect(r.results.txPower).toMatchObject({ ok: false, code: 'TRANSPORT' });
    expect(r.results.floodAdvertInterval).toMatchObject({ ok: true, verified: false });
  });
  it('NOT_SENT marks keys after the failure', async () => {
    const { t, sent } = remoteDevice({ timeoutOn: 'set flood.advert.interval 24' });
    const r = await writeRepeaterSettings(t, gates, {}, { floodAdvertInterval: 24, txPower: 20, name: 'New' });
    expect(sent).toEqual(['set flood.advert.interval 24']);
    expect(r.results.txPower).toMatchObject({ ok: false, code: 'NOT_SENT' });
    expect(r.results.name).toMatchObject({ ok: false, code: 'NOT_SENT' });
  });
  it('an empty reply also stops the run', async () => {
    const { t, sent } = remoteDevice({ noReplyOn: 'set flood.advert.interval 24' });
    const r = await writeRepeaterSettings(t, gates, {}, { floodAdvertInterval: 24, txPower: 20 });
    expect(sent).toEqual(['set flood.advert.interval 24']);
    expect(r.results.floodAdvertInterval?.code).toBe('NO_REPLY');
    expect(r.results.txPower?.code).toBe('NOT_SENT');
  });
  it('rejects remote admin password, remote radio and room repeat before sending', async () => {
    const { t, sent } = remoteDevice();
    for (const [patch, deviceType, field] of [
      [{ adminPassword: 'x' }, 'repeater', 'adminPassword'],
      [{ radio: '869.618,62.5,8,8' }, 'repeater', 'radio'],
      [{ repeat: true }, 'room', 'repeat'],
    ] as const) {
      const r = await writeRepeaterSettings(t, gates, {}, patch, { deviceType });
      expect(r.validationFailed).toBe(true);
      expect(r.validationErrors[0].field).toBe(field);
    }
    expect(sent).toEqual([]);
  });
  it('a rejected set (bad chars) is a key error and the run continues', async () => {
    const { t } = remoteDevice();
    const orig = t.run.bind(t);
    t.run = async (cmd, o) => (cmd === 'set name Bad' ? 'Error, bad chars' : orig(cmd, o));
    const r = await writeRepeaterSettings(t, gates, {}, { name: 'Bad', txPower: 20 });
    expect(r.results.name).toMatchObject({ ok: false, code: 'REJECTED' });
    expect(r.results.txPower).toMatchObject({ ok: true });
  });
});
