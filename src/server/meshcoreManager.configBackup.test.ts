/**
 * MeshCoreManager backup helpers (P16 #6285): readBackupSnapshot,
 * setOtherParamsRaw and restoreChannels against a simulated companion.
 * No real radio: sendBridgeCommand is a double that records every command, so
 * the tests can prove which commands (never export_private_key / get_contacts)
 * a backup sends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

type Slot = { name: string; secret: string };
const EMPTY: Slot = { name: '', secret: '0'.repeat(32) };
const sec = (c: string) => c.repeat(32);

interface Fake {
  slots: Slot[];
  commands: string[];
  writes: Array<{ idx: number; name: string; secret: string }>;
  failIdx: Set<number>;
  otherParamsRaw?: Record<string, unknown>;
  multiAcksReadback: number | null;
}

function build(size = 8) {
  const dev: Fake = {
    slots: Array.from({ length: size }, () => ({ ...EMPTY })),
    commands: [], writes: [], failIdx: new Set(), multiAcksReadback: null,
  };
  dev.slots[1] = { name: 'Alpha', secret: sec('a') };
  dev.slots[3] = { name: 'Gamma', secret: sec('c') };

  const m = new MeshCoreManager('src-backup');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).nativeBackend = {};
  (m as any).localNode = {
    publicKey: 'ab'.repeat(32), name: 'Node One', advType: MeshCoreDeviceType.COMPANION,
    radioFreq: 910.525, radioBw: 62.5, radioSf: 7, radioCr: 5, txPower: 20, maxTxPower: 22,
    latitude: 12.5, longitude: -45.25, manualAddContacts: 0b0001_0110,
    telemetryModeBase: 'device', telemetryModeLoc: 'always', telemetryModeEnv: 'never',
    advLocPolicy: 1, multiAcks: 0, firmwareVer: 9, maxChannels: size,
  };
  (m as any).refreshLocalNode = async () => (m as any).localNode;
  (m as any).refreshKnownScopes = async () => {};
  const sync = vi.fn(async () => {});
  (m as any).syncChannelsFromDevice = sync;
  (m as any).sendBridgeCommand = async (cmd: string, params: any) => {
    dev.commands.push(cmd);
    switch (cmd) {
      case 'device_query':
        return { id: 'q', success: true, data: { 'fw ver': 9, fw_build: '1 Jan 2026', model: 'T-Echo', ver: 'v1.9', max_channels: size, ble_pin: 123456 } };
      case 'get_channels':
        return { id: 'g', success: true, data: dev.slots.map((s, i) => ({ channel_idx: i, name: s.name, secret_hex: s.secret })) };
      case 'get_autoadd_config':
        return { id: 'a', success: true, data: { supported: true, overwrite_oldest: true, types: { chat: true, repeater: false, room: false, sensor: true }, max_hops: 3 } };
      case 'set_channel_verified':
        if (dev.failIdx.has(params.idx)) return { id: 'w', success: false, error: 'timeout' };
        dev.slots[params.idx] = { name: params.name, secret: params.secret_hex };
        dev.writes.push({ idx: params.idx, name: params.name, secret: params.secret_hex });
        return { id: 'w', success: true, data: { verified: true, channel_idx: params.idx } };
      case 'set_other_params_raw':
        dev.otherParamsRaw = params;
        return { id: 'o', success: true, data: { ok: true, multi_acks: dev.multiAcksReadback } };
      default:
        return { id: 'x', success: false, error: `unexpected ${cmd}` };
    }
  };
  return { m, dev, sync };
}

beforeEach(() => {
  vi.spyOn(databaseService.channels, 'getAllChannels').mockResolvedValue([
    { id: 1, name: 'Alpha', scope: 'eu' }, { id: 3, name: 'Gamma', scope: null },
  ] as never);
  vi.spyOn(databaseService.channels, 'updateChannelScope').mockResolvedValue(undefined as never);
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(async (_s: string, key: string) =>
    ({ meshcoreDefaultScope: 'de-bw', meshcoreDefaultPathHashSize: '2', meshcoreRespondToDiscovery: 'true' } as Record<string, string>)[key] ?? null);
});
afterEach(() => vi.restoreAllMocks());

describe('readBackupSnapshot', () => {
  it('gathers the whitelist, non-empty slots with scopes, and sends only local reads', async () => {
    const { m, dev } = build();
    const snap = await m.readBackupSnapshot();
    expect(snap).toMatchObject({
      name: 'Node One', txPower: 20, maxTxPower: 22, latitude: 12.5, longitude: -45.25, blePin: 123456,
      radio: { freq: 910.525, bw: 62.5, sf: 7, cr: 5 },
      otherParams: { manualAddContactsRaw: 0b0001_0110, telemetryModeBase: 1, telemetryModeLoc: 2, telemetryModeEnv: 0, advLocPolicy: 1 },
      autoAdd: { overwriteOldest: true, maxHops: 3 },
      settings: { defaultScope: 'de-bw', defaultPathHashSize: 2, respondToDiscovery: true },
    });
    expect(snap.channels).toEqual([
      { idx: 1, name: 'Alpha', secretHex: sec('a'), scope: 'eu' },
      { idx: 3, name: 'Gamma', secretHex: sec('c'), scope: null },
    ]);
    // Negative: no private key export, no contact reads, no RF command.
    expect(dev.commands).not.toContain('export_private_key');
    expect(dev.commands).not.toContain('get_contacts');
    expect(new Set(dev.commands)).toEqual(new Set(['device_query', 'get_channels', 'get_autoadd_config']));
    expect(JSON.stringify(snap)).not.toMatch(/private|prv/i);
  });

  it('reports no BLE PIN and no auto-add on an old radio', async () => {
    const { m } = build();
    const orig = (m as any).sendBridgeCommand;
    (m as any).sendBridgeCommand = async (cmd: string, p: any) => {
      if (cmd === 'device_query') return { id: 'q', success: true, data: { 'fw ver': 2, max_channels: 8 } };
      if (cmd === 'get_autoadd_config') return { id: 'a', success: true, data: { supported: false } };
      return orig(cmd, p);
    };
    const snap = await m.readBackupSnapshot();
    expect(snap.blePin).toBeNull();
    expect(snap.autoAdd).toBeNull();
  });

  it('refuses a disconnected radio', async () => {
    const { m } = build();
    (m as any).connected = false;
    await expect(m.readBackupSnapshot()).rejects.toThrow(/connected Companion/);
  });
});

describe('setOtherParamsRaw', () => {
  it('sends the raw fields and omits multi_acks unless given', async () => {
    const { m, dev } = build();
    const r = await m.setOtherParamsRaw({ manualAddContactsRaw: 0b0001_1110, telemetryModeBase: 1, telemetryModeLoc: 2, telemetryModeEnv: 0, advLocPolicy: 1 });
    expect(r.multiAcks).toBeNull();
    expect(dev.otherParamsRaw).toEqual({ manualAddContactsRaw: 0b0001_1110, telemetryModeBase: 1, telemetryModeLoc: 2, telemetryModeEnv: 0, advLocPolicy: 1 });
    expect('multiAcks' in (dev.otherParamsRaw ?? {})).toBe(false);
  });

  it('needs firmware code 7 for multi_acks and returns the readback', async () => {
    const { m, dev } = build();
    dev.multiAcksReadback = 1;
    const r = await m.setOtherParamsRaw({ manualAddContactsRaw: 6, telemetryModeBase: 0, telemetryModeLoc: 0, telemetryModeEnv: 0, advLocPolicy: 0, multiAcks: 1 });
    expect(r.multiAcks).toBe(1);
    (m as any).localNode.firmwareVer = 6;
    await expect(
      m.setOtherParamsRaw({ manualAddContactsRaw: 6, telemetryModeBase: 0, telemetryModeLoc: 0, telemetryModeEnv: 0, advLocPolicy: 0, multiAcks: 1 }),
    ).rejects.toThrow(/firmware/);
  });
});

describe('restoreChannels', () => {
  const slot = (idx: number, name: string, c: string, scope?: string | null) => ({ idx, name, secretHex: sec(c), scope });

  it('writes only the given slots, skips 0 and out-of-range, leaves other slots, syncs once, persists scope', async () => {
    const { m, dev, sync } = build(8);
    const r = await m.restoreChannels([slot(2, 'New2', 'b', 'fr'), slot(0, 'Pub', 'f'), slot(9, 'Far', 'e'), slot(3, 'Gamma2', 'd', null)]);
    expect(r.written).toEqual([2, 3]);
    expect(r.skipped.map((s) => s.idx).sort()).toEqual([0, 9]);
    expect(r.failed).toEqual([]);
    expect(dev.writes.map((w) => w.idx)).toEqual([2, 3]);
    expect(dev.slots[1]).toEqual({ name: 'Alpha', secret: sec('a') }); // untouched
    expect(sync).toHaveBeenCalledTimes(1);
    expect(databaseService.channels.updateChannelScope).toHaveBeenCalledWith(2, 'fr', 'src-backup');
    expect(databaseService.channels.updateChannelScope).toHaveBeenCalledWith(3, null, 'src-backup');
    expect(dev.commands.filter((c) => c === 'set_channel_verified')).toHaveLength(2);
  });

  it('holds the reorder lock while writing and releases it after', async () => {
    const { m } = build();
    let during: boolean | undefined;
    const orig = (m as any).sendBridgeCommand;
    (m as any).sendBridgeCommand = async (cmd: string, p: any) => {
      if (cmd === 'set_channel_verified') during = m.isChannelReorderInProgress();
      return orig(cmd, p);
    };
    await m.restoreChannels([slot(2, 'X', 'b')]);
    expect(during).toBe(true);
    expect(m.isChannelReorderInProgress()).toBe(false);
  });

  it('refuses to start while a reorder runs', async () => {
    const { m } = build();
    (m as any).channelReorder = { original: [], believed: [], done: Promise.resolve({ status: 'unchanged' }) };
    await expect(m.restoreChannels([slot(2, 'X', 'b')])).rejects.toThrow(/reorder/);
  });

  it('reports a failed slot, keeps going, and does not persist scope for it', async () => {
    const { m, dev } = build();
    dev.failIdx.add(2);
    const r = await m.restoreChannels([slot(2, 'Bad', 'b', 'x'), slot(4, 'Good', 'd', 'y')]);
    expect(r.written).toEqual([4]);
    expect(r.failed).toEqual([{ idx: 2, error: 'timeout' }]);
    expect(databaseService.channels.updateChannelScope).toHaveBeenCalledTimes(1);
    expect(databaseService.channels.updateChannelScope).toHaveBeenCalledWith(4, 'y', 'src-backup');
  });

  it('rejects a bad key without sending, and does not sync when nothing was written', async () => {
    const { m, dev, sync } = build();
    const r = await m.restoreChannels([{ idx: 2, name: 'X', secretHex: 'nothex' }]);
    expect(r.failed).toHaveLength(1);
    expect(dev.writes).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });
});
