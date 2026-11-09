/**
 * Route tests (P9 #6255 WP2) — /config/repeater-settings, /config/power-off,
 * Repeater branches of reboot / private-key / sync-time / coords. Real-middleware
 * harness; the manager is a stateful fake of the Repeater serial CLI. No radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { DANGER_COMMAND_PATTERN } from './meshcoreRouteShared.js';
import { MeshCoreDeviceCommandError } from '../errors/meshcoreDeviceCommandError.js';

const h = vi.hoisted(() => ({ stubs: new Map<string, Record<string, any>>() }));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => h.stubs.get(id),
    getAllManagers: () => Array.from(h.stubs.values()),
  },
}));

const VERBS: Record<string, string> = {
  lat: 'lat', lon: 'lon', 'advert.interval': 'advert.interval', 'flood.advert.interval': 'flood.advert.interval',
  'flood.max': 'flood.max', repeat: 'repeat', af: 'af', rxdelay: 'rxdelay', txdelay: 'txdelay',
  'direct.txdelay': 'direct.txdelay', 'guest.password': 'guest.password', 'allow.read.only': 'allow.read.only',
};

function stub(sourceId: string, opts: { ver?: string; connected?: boolean; deviceType?: number } = {}) {
  const state: Record<string, string> = {
    lat: '1.5', lon: '2.5', 'advert.interval': '120', 'flood.advert.interval': '47', 'flood.max': '64',
    repeat: 'on', af: '1', rxdelay: '0', txdelay: '0.5', 'direct.txdelay': '0.3', 'guest.password': 'guestpw', 'allow.read.only': 'off',
  };
  const cli: string[] = [];
  const m: Record<string, any> = {
    sourceId,
    sourceType: 'meshcore' as const,
    isReceiveOnly: () => false,
    canTransmit: () => true,
    getConnectionStatus: () => ({ connected: opts.connected ?? true, deviceType: opts.deviceType ?? 2, config: null }),
    getLocalNode: () => ({ ver: opts.ver ?? '1.18.0' }),
    runRepeaterCli: vi.fn(async (cmd: string) => {
      cli.push(cmd);
      let r = /^get (\S+)$/.exec(cmd);
      if (r && VERBS[r[1]]) return `  -> > ${state[r[1]]}`;
      r = /^set (\S+) ?(.*)$/.exec(cmd);
      if (r && VERBS[r[1]]) {
        state[r[1]] = r[2] === 'on' || r[2] === 'off' ? r[2] : r[2];
        return '  -> OK';
      }
      if (cmd.startsWith('password ')) return `  -> password now: ${cmd.slice(9)}`;
      return '  -> Unknown command';
    }),
    powerOff: vi.fn().mockResolvedValue(undefined),
    rebootDevice: vi.fn().mockResolvedValue(true),
    exportPrivateKey: vi.fn().mockResolvedValue('b'.repeat(128)),
    importPrivateKey: vi.fn().mockResolvedValue(true),
    syncDeviceTime: vi.fn().mockResolvedValue({ ok: true }),
    setCoords: vi.fn().mockResolvedValue(true),
  };
  return { m, state, cli };
}

describe('MeshCore repeater settings routes (P9 #6255)', () => {
  let harness: RouteTestHarness;
  let audit: ReturnType<typeof vi.spyOn>;
  const url = (p: string, sid?: string) => `/sources/${sid ?? harness.sourceA}/meshcore/config/${p}`;
  const set = (sid: string, s: ReturnType<typeof stub>) => h.stubs.set(sid, s.m);
  let A: ReturnType<typeof stub>;

  beforeEach(async () => {
    h.stubs.clear();
    A = stub('rt-source-a');
    set('rt-source-a', A);
    set('rt-source-b', stub('rt-source-b'));
    granted = false;
    harness = await createRouteTestApp({ mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes) });
    audit = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as any);
  });
  afterEach(async () => {
    audit.mockRestore();
    await harness.cleanup();
  });

  let granted = false;
  const writer = async () => {
    if (!granted) {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      granted = true;
    }
    return harness.loginAs(harness.limited);
  };
  const admin = () => harness.loginAs(harness.admin);

  describe('GET', () => {
    it('returns values, guestPasswordSet (never the password) and capabilities', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).get(url('repeater-settings'));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.values.advertInterval).toBe(120);
      expect(res.body.data.values.repeat).toBe(true);
      expect(res.body.data.guestPasswordSet).toBe(true);
      expect(res.body.data.capabilities).toEqual({ powerOff: true, keyExport: true, keyImport: true });
      expect(res.body.data.firmware).toBe('1.18.0');
      expect(JSON.stringify(res.body)).not.toContain('guestpw');
    });
    it('403 without configuration:read on the source', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceB);
      const res = await (await harness.loginAs(harness.limited)).get(url('repeater-settings'));
      expect(res.status).toBe(403);
      expect(A.m.runRepeaterCli).not.toHaveBeenCalled();
    });
    it('409 SOURCE_NOT_CONNECTED / NOT_REPEATER', async () => {
      set('rt-source-a', stub('rt-source-a', { connected: false }));
      let res = await (await admin()).get(url('repeater-settings'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      set('rt-source-a', stub('rt-source-a', { deviceType: 1 }));
      res = await (await admin()).get(url('repeater-settings'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_REPEATER');
    });
    it('capabilities follow the firmware gates (1.14: no power-off)', async () => {
      set('rt-source-a', stub('rt-source-a', { ver: '1.14.0' }));
      const res = await (await admin()).get(url('repeater-settings'));
      expect(res.body.data.capabilities.powerOff).toBe(false);
    });
  });

  describe('PATCH', () => {
    const patch = async (agent: any, body: unknown) => agent.patch(url('repeater-settings')).send(body);

    it('403 for a read-only user and the wrong source; nothing is sent', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
      const res = await patch(await harness.loginAs(harness.limited), { floodMax: 10 });
      expect(res.status).toBe(403);
      expect(A.m.runRepeaterCli).not.toHaveBeenCalled();
    });

    it.each([
      ['advert 59', { advertInterval: 59 }, 'advertInterval'],
      ['advert 241', { advertInterval: 241 }, 'advertInterval'],
      ['flood 5', { floodAdvertInterval: 5 }, 'floodAdvertInterval'],
      ['flood 169', { floodAdvertInterval: 169 }, 'floodAdvertInterval'],
      ['floodMax 65', { floodMax: 65 }, 'floodMax'],
      ['af 9.1', { af: 9.1 }, 'af'],
      ['rxdelay 21', { rxDelay: 21 }, 'rxDelay'],
      ['txdelay 2.1', { txDelay: 2.1 }, 'txDelay'],
      ['direct 2.1', { directTxDelay: 2.1 }, 'directTxDelay'],
      ['16-byte password', { adminPassword: 'a'.repeat(16) }, 'adminPassword'],
      ['16-byte guest', { guestPassword: 'a'.repeat(16) }, 'guestPassword'],
      ['CR/LF admin', { adminPassword: 'ab\r\ncd' }, 'adminPassword'],
      ['CR/LF guest', { guestPassword: 'ab\ncd' }, 'guestPassword'],
      ['unknown key', { nope: 1 }, 'nope'],
    ])('400 VALIDATION with field: %s', async (_n, body, field) => {
      const res = await patch(await writer(), body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION');
      expect(res.body.field).toBe(field);
      expect(A.m.runRepeaterCli).not.toHaveBeenCalled();
    });

    it('400 on an empty body', async () => {
      const res = await patch(await writer(), {});
      expect(res.status).toBe(400);
    });

    it('flood 49 is refused on fw 1.11 but accepted on 1.18', async () => {
      set('rt-source-a', stub('rt-source-a', { ver: '1.11.0' }));
      expect((await patch(await writer(), { floodAdvertInterval: 49 })).status).toBe(400);
      set('rt-source-a', stub('rt-source-a', { ver: '1.18.0' }));
      expect((await patch(await admin(), { floodAdvertInterval: 49 })).status).toBe(200);
    });

    it('validates BEFORE the connection check (400 even when disconnected)', async () => {
      set('rt-source-a', stub('rt-source-a', { connected: false }));
      expect((await patch(await writer(), { advertInterval: 59 })).status).toBe(400);
      const res = await patch(await writer(), { advertInterval: 60 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
    });

    it('409 NOT_REPEATER on a Companion source', async () => {
      set('rt-source-a', stub('rt-source-a', { deviceType: 1 }));
      const res = await patch(await writer(), { floodMax: 10 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_REPEATER');
    });

    it('Off (0) is accepted for both intervals', async () => {
      const res = await patch(await writer(), { advertInterval: 0, floodAdvertInterval: 0 });
      expect(res.status).toBe(200);
      expect(A.state['advert.interval']).toBe('0');
      expect(A.state['flood.advert.interval']).toBe('0');
      expect(res.body.data.ok).toBe(true);
    });

    it('odd advert minutes floor to even', async () => {
      const res = await patch(await writer(), { advertInterval: 61 });
      expect(res.status).toBe(200);
      expect(A.cli).toContain('set advert.interval 60');
    });

    it('sends only changed keys and returns per-key results', async () => {
      const res = await patch(await writer(), { floodMax: 10, repeat: true });
      expect(res.status).toBe(200);
      const sets = A.cli.filter((c) => c.startsWith('set '));
      expect(sets).toEqual(['set flood.max 10']);
      expect(res.body.data.results.floodMax).toMatchObject({ ok: true, changed: true });
      expect(res.body.data.results.repeat).toMatchObject({ ok: true, changed: false });
      expect(res.body.data.values.floodMax).toBe(10);
    });

    it('audit carries changed keys with secrets as "[changed]", never the secret', async () => {
      const res = await patch(await writer(), { adminPassword: 'topsecret1', guestPassword: 'guestnew', floodMax: 12 });
      expect(res.status).toBe(200);
      const calls = audit.mock.calls.filter((c) => c[1] === 'meshcore_repeater_settings_update');
      expect(calls).toHaveLength(1);
      const details = String(calls[0][3]);
      expect(JSON.parse(details).changed).toEqual({ adminPassword: '[changed]', guestPassword: '[changed]', floodMax: 12 });
      expect(details).not.toContain('topsecret1');
      expect(details).not.toContain('guestnew');
      expect(JSON.stringify(res.body)).not.toContain('topsecret1');
      expect(JSON.stringify(res.body)).not.toContain('guestnew');
    });

    it('409 WRITE_IN_PROGRESS while another save runs', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const orig = A.m.runRepeaterCli.getMockImplementation()!;
      A.m.runRepeaterCli.mockImplementation(async (cmd: string) => {
        if (cmd === 'set flood.max 5') {
          A.cli.push(cmd);
          await gate;
        }
        return orig(cmd);
      });
      const agent = await writer();
      const first = patch(agent, { floodMax: 5 });
      await vi.waitFor(() => expect(A.cli).toContain('set flood.max 5'));
      const second = await patch(agent, { floodMax: 6 });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('WRITE_IN_PROGRESS');
      release();
      expect((await first).status).toBe(200);
    });

    it('a device rejection shows up as a per-key failure', async () => {
      const orig = A.m.runRepeaterCli.getMockImplementation()!;
      A.m.runRepeaterCli.mockImplementation(async (cmd: string) => (cmd === 'set flood.max 7' ? '  -> Error, max 64' : orig(cmd)));
      const res = await patch(await writer(), { floodMax: 7 });
      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(false);
      expect(res.body.data.results.floodMax).toMatchObject({ ok: false, code: 'REJECTED' });
    });
  });

  describe('POST /config/power-off', () => {
    it('403 for a non-admin (even with configuration:write)', async () => {
      const res = await (await writer()).post(url('power-off')).send({ confirm: true });
      expect(res.status).toBe(403);
      expect(A.m.powerOff).not.toHaveBeenCalled();
    });
    it('400 DANGER_CONFIRM_REQUIRED without confirm', async () => {
      const res = await (await admin()).post(url('power-off')).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DANGER_CONFIRM_REQUIRED');
      expect(A.m.powerOff).not.toHaveBeenCalled();
    });
    it('audits BEFORE sending, then 200', async () => {
      const order: string[] = [];
      audit.mockImplementation((async (_u: unknown, action: string) => { order.push(`audit:${action}`); }) as any);
      A.m.powerOff.mockImplementation(async () => { order.push('send'); });
      const res = await (await admin()).post(url('power-off')).send({ confirm: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { powerOffSent: true } });
      expect(order).toEqual(['audit:meshcore_power_off', 'send']);
    });
    it('409 FIRMWARE_UNSUPPORTED (fw 1.14 / old Companion)', async () => {
      A.m.powerOff.mockRejectedValue(new MeshCoreDeviceCommandError('FIRMWARE_UNSUPPORTED', 'needs 1.15'));
      const res = await (await admin()).post(url('power-off')).send({ confirm: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FIRMWARE_UNSUPPORTED');
    });
    it('409 SOURCE_NOT_CONNECTED', async () => {
      A.m.powerOff.mockRejectedValue(new MeshCoreDeviceCommandError('SOURCE_NOT_CONNECTED', 'no'));
      const res = await (await admin()).post(url('power-off')).send({ confirm: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
    });
  });

  describe('private key', () => {
    const KEY = 'a'.repeat(128);
    it('restore: 403 for a non-admin with configuration:write', async () => {
      const res = await (await writer()).post(url('private-key')).send({ privateKey: KEY, confirm: true });
      expect(res.status).toBe(403);
      expect(A.m.importPrivateKey).not.toHaveBeenCalled();
    });
    it('restore: admin with confirm reaches the manager', async () => {
      const res = await (await admin()).post(url('private-key')).send({ privateKey: KEY, confirm: true });
      expect(res.status).toBe(200);
      expect(A.m.importPrivateKey).toHaveBeenCalledWith(KEY);
    });
    it('restore: 400 without confirm, 409 FIRMWARE_UNSUPPORTED', async () => {
      expect((await (await admin()).post(url('private-key')).send({ privateKey: KEY })).status).toBe(400);
      A.m.importPrivateKey.mockRejectedValue(new MeshCoreDeviceCommandError('FIRMWARE_UNSUPPORTED', 'needs 1.9'));
      const res = await (await admin()).post(url('private-key')).send({ privateKey: KEY, confirm: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FIRMWARE_UNSUPPORTED');
    });
    it('export stays configuration:write and works on a Repeater', async () => {
      const res = await (await writer()).get(url('private-key'));
      expect(res.status).toBe(200);
      expect(res.body.data.privateKey).toBe('b'.repeat(128));
    });
    it('export: 409 FIRMWARE_UNSUPPORTED on old firmware', async () => {
      A.m.exportPrivateKey.mockRejectedValue(new MeshCoreDeviceCommandError('FIRMWARE_UNSUPPORTED', 'needs 1.8'));
      const res = await (await writer()).get(url('private-key'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FIRMWARE_UNSUPPORTED');
    });
  });

  describe('reboot / sync-time / coords on a Repeater', () => {
    it('reboot works with confirm', async () => {
      const res = await (await writer()).post(url('reboot')).send({ confirm: true });
      expect(res.status).toBe(200);
      expect(A.m.rebootDevice).toHaveBeenCalled();
    });
    it('sync-time ok; clock ahead -> 409 CLOCK_AHEAD', async () => {
      expect((await (await writer()).post(url('sync-time'))).status).toBe(200);
      A.m.syncDeviceTime.mockResolvedValue({ ok: false, reason: 'clock-ahead', error: 'ahead' });
      const res = await (await writer()).post(url('sync-time'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLOCK_AHEAD');
    });
    it('coords reach the manager', async () => {
      const res = await (await writer()).post(url('coords')).send({ lat: 10.5, lon: -20.25 });
      expect(res.status).toBe(200);
      expect(A.m.setCoords).toHaveBeenCalledWith(10.5, -20.25);
    });
  });

  describe('danger guard (#6255)', () => {
    it('flags set prv.key, not get prv.key', () => {
      expect(DANGER_COMMAND_PATTERN.test(`set prv.key ${'ab'.repeat(64)}`)).toBe(true);
      expect(DANGER_COMMAND_PATTERN.test('get prv.key')).toBe(false);
      expect(DANGER_COMMAND_PATTERN.test('password abc')).toBe(false);
    });
  });
});
