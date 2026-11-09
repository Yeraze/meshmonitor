/**
 * P9 #6255 WP2 — manager Repeater branches: setCoords, reboot, power-off,
 * key export / restore, sync clock, and the Error-reply fix for name / radio /
 * TX power. The serial CLI is a stub; nothing touches a radio.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { meshcoreOwnIdentityTracker } from './services/meshcoreOwnIdentityTracker.js';
import { derivePublicKeyFromPrivateHex } from './utils/meshcoreKeyDerive.js';
import databaseService from '../services/database.js';

const KEY = 'ab'.repeat(64);
const NEW_PUB = 'cd'.repeat(32);

type Reply = string | Error | ((cmd: string) => string);

function make(opts: {
  ver?: string; type?: MeshCoreDeviceType; connected?: boolean; replies?: Record<string, Reply>; fw?: number;
} = {}) {
  const m = new MeshCoreManager('src-p9');
  (m as any).deviceType = opts.type ?? MeshCoreDeviceType.REPEATER;
  (m as any).connected = opts.connected ?? true;
  (m as any).localNode = { publicKey: 'ee'.repeat(32), name: 'n', advType: 2, ver: opts.ver ?? '1.18.0', firmwareVer: opts.fw };
  const sent: Array<{ cmd: string; timeout?: number; secret?: boolean }> = [];
  (m as any).sendRepeaterCommand = async (cmd: string, timeout?: number, o?: { secret?: boolean }) => {
    sent.push({ cmd, timeout, secret: o?.secret });
    const hit = Object.entries(opts.replies ?? {}).find(([k]) => cmd === k || cmd.startsWith(k + ' '));
    const r = hit?.[1];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(cmd);
    return r ?? '';
  };
  const bridge: Array<{ cmd: string; params: any }> = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: any) => {
    bridge.push({ cmd, params });
    return { id: '1', success: true, data: { reply: '' } };
  };
  return { m, sent, bridge };
}

describe('MeshCoreManager Repeater danger-zone branches (P9 #6255)', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('setCoords', () => {
    it('sets lat/lon and reads both back', async () => {
      const { m, sent } = make({ replies: { 'set lat': '  -> OK', 'set lon': '  -> OK', 'get lat': '  -> > 10.5', 'get lon': '  -> > -20.25' } });
      expect(await m.setCoords(10.5, -20.25)).toBe(true);
      expect(sent.map((s) => s.cmd)).toEqual(['set lat 10.5', 'set lon -20.25', 'get lat', 'get lon']);
      expect(m.getLocalNode()?.latitude).toBe(10.5);
    });
    it('a rejected set or a readback mismatch is false', async () => {
      expect(await make({ replies: { 'set lat': '  -> Error, bad' } }).m.setCoords(1, 2)).toBe(false);
      const mismatch = make({ replies: { 'set lat': '  -> OK', 'set lon': '  -> OK', 'get lat': '  -> > 9', 'get lon': '  -> > 2' } });
      expect(await mismatch.m.setCoords(1, 2)).toBe(false);
    });
  });

  describe('syncDeviceTime', () => {
    it('sends time <epoch>', async () => {
      const { m, sent } = make({ replies: { time: '  -> OK' } });
      expect(await m.syncDeviceTime()).toEqual({ ok: true });
      expect(sent[0].cmd).toMatch(/^time \d{10}$/);
    });
    it('a clock that cannot go backwards is clock-ahead', async () => {
      const { m } = make({ replies: { time: '  -> (ERR: clock cannot go backwards)' } });
      const r = await m.syncDeviceTime();
      expect(r).toMatchObject({ ok: false, reason: 'clock-ahead' });
    });
    it('disconnected', async () => {
      expect(await make({ connected: false }).m.syncDeviceTime()).toEqual({ ok: false, reason: 'disconnected' });
    });
  });

  describe('reboot / power-off', () => {
    it('reboot uses a 1.5 s timeout and an empty reply reads as sent', async () => {
      const { m, sent } = make();
      expect(await m.rebootDevice()).toBe(true);
      expect(sent).toEqual([{ cmd: 'reboot', timeout: 1500, secret: undefined }]);
    });
    it('a link drop during reboot reads as sent', async () => {
      expect(await make({ replies: { reboot: new Error('Serial port not open') } }).m.rebootDevice()).toBe(true);
    });
    it('powerOff on Repeater fw 1.18 sends poweroff', async () => {
      const { m, sent } = make();
      await m.powerOff();
      expect(sent[0]).toMatchObject({ cmd: 'poweroff', timeout: 1500 });
    });
    it('powerOff on fw 1.14 is FIRMWARE_UNSUPPORTED and sends nothing', async () => {
      const { m, sent } = make({ ver: '1.14.0' });
      await expect(m.powerOff()).rejects.toMatchObject({ code: 'FIRMWARE_UNSUPPORTED' });
      expect(sent).toEqual([]);
    });
    it('powerOff while disconnected is SOURCE_NOT_CONNECTED', async () => {
      await expect(make({ connected: false }).m.powerOff()).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED' });
    });
    it('Companion powerOff: protocol 14 runs run_cli poweroff', async () => {
      const { m, bridge } = make({ type: MeshCoreDeviceType.COMPANION, fw: 14 });
      await m.powerOff();
      expect(bridge[0]).toMatchObject({ cmd: 'run_cli', params: { command: 'poweroff' } });
    });
    it('Companion powerOff: protocol 13 is FIRMWARE_UNSUPPORTED', async () => {
      const { m, bridge } = make({ type: MeshCoreDeviceType.COMPANION, fw: 13 });
      await expect(m.powerOff()).rejects.toMatchObject({ code: 'FIRMWARE_UNSUPPORTED' });
      expect(bridge.filter((b) => b.cmd === 'run_cli')).toEqual([]);
    });
  });

  describe('private key', () => {
    it('export reads get prv.key as a secret and returns 128 hex', async () => {
      const { m, sent } = make({ replies: { 'get prv.key': `  -> > ${KEY}` } });
      expect(await m.exportPrivateKey()).toBe(KEY);
      expect(sent[0]).toMatchObject({ cmd: 'get prv.key', secret: true });
    });
    it('export below fw 1.8 is FIRMWARE_UNSUPPORTED', async () => {
      await expect(make({ ver: '1.7.0' }).m.exportPrivateKey()).rejects.toMatchObject({ code: 'FIRMWARE_UNSUPPORTED' });
    });
    it('restore: set prv.key (secret) -> expectChange pinned to the reported pubkey -> reboot', async () => {
      const expect_ = vi.spyOn(meshcoreOwnIdentityTracker, 'expectChange');
      const { m, sent } = make({ replies: { 'set prv.key': `  -> OK, reboot to apply! New pubkey: ${NEW_PUB}` } });
      expect(await m.importPrivateKey(KEY)).toBe(true);
      expect(sent.map((s) => s.cmd)).toEqual([`set prv.key ${KEY}`, 'reboot']);
      expect(sent[0].secret).toBe(true);
      expect(expect_).toHaveBeenCalledWith('src-p9', { expectedKey: NEW_PUB, reason: 'key_restore' });
    });
    it('restore on fw < 1.12 pins the key derived from the private key', async () => {
      const expect_ = vi.spyOn(meshcoreOwnIdentityTracker, 'expectChange');
      const { m } = make({ ver: '1.10.0', replies: { 'set prv.key': '  -> OK' } });
      expect(await m.importPrivateKey(KEY)).toBe(true);
      const call = expect_.mock.calls[0];
      expect(call[1]).toMatchObject({ reason: 'key_restore', expectedKey: derivePublicKeyFromPrivateHex(KEY) ?? undefined });
    });
    it('a rejected key is false: no expectChange, no reboot', async () => {
      const expect_ = vi.spyOn(meshcoreOwnIdentityTracker, 'expectChange');
      const { m, sent } = make({ replies: { 'set prv.key': '  -> Error, bad key' } });
      expect(await m.importPrivateKey(KEY)).toBe(false);
      expect(expect_).not.toHaveBeenCalled();
      expect(sent.map((s) => s.cmd)).toEqual([`set prv.key ${KEY}`]);
    });
    it('restore below fw 1.9 is FIRMWARE_UNSUPPORTED', async () => {
      await expect(make({ ver: '1.8.0' }).m.importPrivateKey(KEY)).rejects.toMatchObject({ code: 'FIRMWARE_UNSUPPORTED' });
    });
    it('Companion import now calls expectChange with key_restore', async () => {
      const expect_ = vi.spyOn(meshcoreOwnIdentityTracker, 'expectChange');
      const { m, bridge } = make({ type: MeshCoreDeviceType.COMPANION });
      expect(await m.importPrivateKey(KEY)).toBe(true);
      expect(bridge[0].cmd).toBe('import_private_key');
      expect(expect_).toHaveBeenCalledWith('src-p9', expect.objectContaining({ reason: 'key_restore' }));
    });
    it('pinned restore: the expected key is silent, another key still alerts', async () => {
      const store = new Map<string, string>();
      const t = new (await import('./services/meshcoreOwnIdentityTracker.js')).MeshCoreOwnIdentityTracker(
        () => ({
          getSettingForSource: async (s: string, k: string) => store.get(`${s}:${k}`) ?? null,
          setSourceSetting: async (s: string, k: string, v: string) => { store.set(`${s}:${k}`, v); },
        }),
      );
      await t.observe('s', 'a'.repeat(64));
      t.expectChange('s', { expectedKey: NEW_PUB, reason: 'key_restore' });
      expect(await t.observe('s', 'f'.repeat(64))).toBe('changed');
    });
  });

  describe('Error replies now fail name / radio / TX power', () => {
    it('setName', async () => {
      expect(await make({ replies: { 'set name': '  -> Error, too long' } }).m.setName('x')).toBe(false);
      expect(await make({ replies: { 'set name': '  -> OK' } }).m.setName('x')).toBe(true);
    });
    it('setRadio', async () => {
      expect(await make({ replies: { 'set radio': '  -> Error, bad radio' } }).m.setRadio(915, 250, 10, 5)).toBe(false);
      expect(await make({ replies: { 'set radio': '  -> OK' } }).m.setRadio(915, 250, 10, 5)).toBe(true);
    });
    it('setTxPower', async () => {
      expect(await make({ replies: { 'set tx': '  -> ERROR: bad' } }).m.setTxPower(10)).toBe(false);
      expect(await make({ replies: { 'set tx': '  -> OK' } }).m.setTxPower(10)).toBe(true);
    });
  });

  it('the identity audit row carries the reason', async () => {
    const audit = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as any);
    vi.spyOn(meshcoreOwnIdentityTracker, 'observe').mockResolvedValue('expected');
    vi.spyOn(meshcoreOwnIdentityTracker, 'takeExpectedReason').mockReturnValue('key_restore');
    await (make().m as any).observeOwnIdentity(NEW_PUB);
    expect(audit.mock.calls[0][1]).toBe('meshcore_identity_changed_expected');
    expect(JSON.parse(audit.mock.calls[0][3] as string)).toMatchObject({ reason: 'key_restore' });
  });
});
