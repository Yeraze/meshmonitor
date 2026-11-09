/**
 * MeshCore Companion backup adapter (P16 #6285): YAML round trip, header
 * checks, no-secret summary, restore order (radio last), and the security
 * negatives (never the private key, never contacts, never logged).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import YAML from 'yamljs';

const logSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../../utils/logger.js', () => {
  const rec = (...a: unknown[]) => { logSpy.calls.push(a); };
  return { logger: { debug: rec, info: rec, warn: rec, error: rec, trace: rec } };
});

import {
  meshcoreBackupAdapter,
  renderMeshCoreBackup,
  parseMeshCoreBackup,
  summarizeMeshCoreBackup,
  restoreMeshCoreBackup,
} from './meshcore.js';
import { meshtasticBackupAdapter } from './meshtastic.js';
import { BackupProtocolMismatchError } from './types.js';
import type { MeshCoreBackupSnapshot } from '../../meshcoreManager.js';

const PUBKEY = 'ab'.repeat(32);
// A 64-byte (128 hex) private key sentinel: must never reach a file, summary or log.
const PRIVATE_KEY_HEX = 'f0'.repeat(64);
const SECRET_A = '0123456789abcdef0123456789abcdef'; // looks numeric-ish: must stay a string
const SECRET_B = '12345678901234567890123456789012'; // all digits: a YAML number if unquoted
const SECRET_C = '1e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e'; // float-looking

function snapshot(over: Partial<MeshCoreBackupSnapshot> = {}): MeshCoreBackupSnapshot {
  return {
    publicKey: PUBKEY,
    name: 'Node "One": test # é\u{1f4e1}',
    model: 'T-Echo',
    firmwareVer: 9,
    firmwareBuild: '1 Jan 2026',
    maxChannels: 8,
    radio: { freq: 910.525, bw: 62.5, sf: 7, cr: 5 },
    txPower: 20,
    maxTxPower: 22,
    latitude: 12.5,
    longitude: -45.25,
    otherParams: { manualAddContactsRaw: 0b0001_0110, telemetryModeBase: 1, telemetryModeLoc: 2, telemetryModeEnv: 0, advLocPolicy: 1, multiAcks: 1 },
    autoAdd: { supported: true, overwriteOldest: true, types: { chat: true, repeater: false, room: false, sensor: true }, maxHops: 3 },
    blePin: 123456,
    channels: [
      { idx: 1, name: 'Alpha', secretHex: SECRET_A, scope: 'eu' },
      { idx: 2, name: '#hash: "q"', secretHex: SECRET_B, scope: null },
      { idx: 3, name: '', secretHex: SECRET_C, scope: null },
    ],
    settings: { defaultScope: 'de-bw', defaultPathHashSize: 2, respondToDiscovery: true },
    ...over,
  };
}

describe('YAML round trip', () => {
  it('parse(render(snapshot)) returns the same data, with hex keys kept as strings', () => {
    const doc = parseMeshCoreBackup(renderMeshCoreBackup(snapshot(), '2026-11-09T01:02:03.000Z'));
    expect(doc.createdAt).toBe('2026-11-09T01:02:03.000Z');
    expect(doc.device).toMatchObject({ publicKey: PUBKEY, model: 'T-Echo', firmwareVer: 9, maxChannels: 8 });
    expect(doc.config).toMatchObject({
      name: 'Node "One": test # é\u{1f4e1}',
      radio: { freq: 910.525, bw: 62.5, sf: 7, cr: 5 },
      txPower: 20,
      location: { lat: 12.5, lon: -45.25 },
      otherParams: { manualAddContactsRaw: 0b0001_0110, telemetryModeBase: 1, telemetryModeLoc: 2, telemetryModeEnv: 0, advLocPolicy: 1, multiAcks: 1 },
      autoAdd: { overwriteOldest: true, types: { chat: true, repeater: false, room: false, sensor: true }, maxHops: 3 },
      pathHashSize: 2,
      blePin: 123456,
    });
    expect(doc.channels).toEqual([
      { idx: 1, name: 'Alpha', secretHex: SECRET_A, scope: 'eu' },
      { idx: 2, name: '#hash: "q"', secretHex: SECRET_B },
      { idx: 3, name: '', secretHex: SECRET_C },
    ]);
    expect(doc.meshmonitor).toEqual({ defaultScope: 'de-bw', defaultPathHashSize: 2, respondToDiscovery: true });
  });

  it('omits what the radio did not report (no auto-add, no BLE PIN, no radio)', () => {
    const text = renderMeshCoreBackup(snapshot({ autoAdd: null, blePin: null, radio: null, channels: [] }), 'x');
    const parsed = YAML.parse(text);
    expect(parsed.config.auto_add).toBeUndefined();
    expect(parsed.config.ble_pin).toBeUndefined();
    expect(parsed.config.radio).toBeUndefined();
    expect(parsed.channels).toEqual([]);
  });

  it('uses the documented layout', () => {
    const parsed = YAML.parse(renderMeshCoreBackup(snapshot(), 'x'));
    expect(parsed.meshmonitor_backup).toBe('meshcore_companion');
    expect(parsed.format_version).toBe(1);
    expect(Object.keys(parsed)).toEqual(['meshmonitor_backup', 'format_version', 'created_at', 'device', 'config', 'channels', 'meshmonitor']);
  });
});

describe('header checks', () => {
  it('refuses a Meshtastic file, plain text and a newer format version', () => {
    expect(() => parseMeshCoreBackup('owner: x\nconfig:\n  lora:\n    region: US\n')).toThrow(BackupProtocolMismatchError);
    expect(() => parseMeshCoreBackup('just text')).toThrow(BackupProtocolMismatchError);
    expect(() => parseMeshCoreBackup('meshmonitor_backup: meshcore_companion\nformat_version: 2\n')).toThrow(/newer/);
  });

  it('the Meshtastic adapter refuses a MeshCore file', () => {
    const text = renderMeshCoreBackup(snapshot(), 'x');
    expect(() => meshtasticBackupAdapter.parse(text)).toThrow(BackupProtocolMismatchError);
  });

  it('drops malformed channel rows instead of failing', () => {
    const doc = parseMeshCoreBackup(
      'meshmonitor_backup: meshcore_companion\nformat_version: 1\nchannels:\n  - idx: "x"\n    secret_hex: "aa"\n  - idx: 4\n    name: "ok"\n    secret_hex: "' + SECRET_A + '"\n',
    );
    expect(doc.channels.map((c) => c.idx)).toEqual([4]);
  });
});

describe('summary', () => {
  it('carries names and the radio, never a secret, PIN or full key', () => {
    const text = renderMeshCoreBackup(snapshot(), '2026-11-09T01:02:03.000Z');
    const summary = summarizeMeshCoreBackup(parseMeshCoreBackup(text));
    const json = JSON.stringify(summary);
    for (const secret of [SECRET_A, SECRET_B, SECRET_C, '123456', PUBKEY]) expect(json).not.toContain(secret);
    expect(summary).toMatchObject({
      protocol: 'meshcore',
      identity: PUBKEY.slice(0, 8),
      radio: { freq: 910.525, bw: 62.5, sf: 7, cr: 5 },
      channels: [{ idx: 1, name: 'Alpha' }, { idx: 2, name: '#hash: "q"' }, { idx: 3, name: '' }],
      requiresReboot: true,
    });
    expect(summary.sections).toEqual(expect.arrayContaining(['name', 'channels', 'radio', 'ble_pin']));
  });

  it('compares with the live radio and flags a different identity', () => {
    const doc = parseMeshCoreBackup(renderMeshCoreBackup(snapshot(), 'x'));
    const same = summarizeMeshCoreBackup(doc, { getLocalNode: () => ({ publicKey: PUBKEY, radioFreq: 910.525, radioBw: 62.5, radioSf: 7, radioCr: 5 }) } as never);
    expect(same.identityMismatch).toBe(false);
    expect(same.radioDiffers).toBe(false);
    const other = summarizeMeshCoreBackup(doc, { getLocalNode: () => ({ publicKey: 'cd'.repeat(32), radioFreq: 869.525, radioBw: 250, radioSf: 11, radioCr: 5 }) } as never);
    expect(other.identityMismatch).toBe(true);
    expect(other.radioDiffers).toBe(true);
    expect(other.currentRadio).toEqual({ freq: 869.525, bw: 250, sf: 11, cr: 5 });
  });
});

// ---------- restore ----------

function fakeManager(over: Record<string, unknown> = {}, local: Record<string, unknown> = {}) {
  const order: string[] = [];
  const rec = <T,>(name: string, value: T) => vi.fn(async (..._a: unknown[]) => { order.push(name); return value; });
  const m = {
    getLocalNode: () => ({ publicKey: PUBKEY, firmwareVer: 9, maxTxPower: 22, ...local }),
    setName: rec('name', true),
    setCoords: rec('location', true),
    setOtherParamsRaw: rec('other_params', { multiAcks: 1 }),
    setAutoAddConfig: rec('auto_add', { ok: true, config: { supported: true } }),
    setDefaultPathHashSize: rec('path_hash_size', 2),
    getBlePin: vi.fn(async () => 111111),
    setBlePin: rec('ble_pin', undefined),
    restoreChannels: vi.fn(async (slots: Array<{ idx: number }>) => {
      order.push('channels');
      return { written: slots.filter((s) => s.idx !== 0).map((s) => s.idx), skipped: slots.filter((s) => s.idx === 0).map(() => ({ idx: 0, reason: 'slot 0 is reserved' })), failed: [] };
    }),
    setDefaultScope: rec('scope', ''),
    setRespondToDiscovery: rec('discovery', undefined),
    setTxPower: rec('tx_power', true),
    setRadio: rec('radio', true),
    // The private key and contacts are reachable on a real manager: a backup must never call them.
    exportPrivateKey: vi.fn(async () => PRIVATE_KEY_HEX),
    getContacts: vi.fn(async () => []),
    ...over,
  };
  return { m: m as never, raw: m, order };
}

const docOf = (snap: Partial<MeshCoreBackupSnapshot> = {}) =>
  parseMeshCoreBackup(renderMeshCoreBackup(snapshot(snap), 'x'));

describe('restore', () => {
  beforeEach(() => { logSpy.calls.length = 0; });

  it('applies every section in order and writes the radio last', async () => {
    const { m, order } = fakeManager();
    const r = await restoreMeshCoreBackup(m, docOf());
    expect(order).toEqual(['name', 'location', 'other_params', 'auto_add', 'path_hash_size', 'ble_pin', 'channels', 'scope', 'discovery', 'tx_power', 'radio']);
    expect(r.applied).toEqual(['name', 'location', 'other_params', 'auto_add', 'path_hash_size', 'ble_pin', 'channels', 'meshmonitor', 'tx_power', 'radio']);
    expect(r.applied.at(-1)).toBe('radio');
    expect(r.failed).toEqual([]);
    expect(r.channels).toBe(3);
    expect(r.requiresReboot).toBe(true); // the PIN changed
    expect(r.identityMismatch).toBe(false);
  });

  it('a section that throws does not stop the others, and the radio still goes last', async () => {
    const { m, order } = fakeManager({ setName: vi.fn(async () => { throw new Error('serial busy'); }) });
    const r = await restoreMeshCoreBackup(m, docOf());
    expect(r.failed).toEqual([{ section: 'name', error: 'serial busy' }]);
    expect(order.at(-1)).toBe('radio');
    expect(r.applied).toContain('radio');
  });

  it('skips the BLE PIN write (and the reboot note) when the PIN is unchanged', async () => {
    const { m, raw } = fakeManager({ getBlePin: vi.fn(async () => 123456) });
    const r = await restoreMeshCoreBackup(m, docOf());
    expect((raw as { setBlePin: ReturnType<typeof vi.fn> }).setBlePin).not.toHaveBeenCalled();
    expect(r.requiresReboot).toBe(false);
  });

  it('reports a radio without PIN support as skipped', async () => {
    const { m } = fakeManager({ getBlePin: vi.fn(async () => null) });
    const r = await restoreMeshCoreBackup(m, docOf());
    expect(r.skipped).toContainEqual({ section: 'ble_pin', reason: expect.stringContaining('BLE PIN') });
  });

  it('sends multi_acks 0 or 1 on firmware >= 7; above 1 is skipped; old firmware is skipped', async () => {
    const one = fakeManager();
    await restoreMeshCoreBackup(one.m, docOf());
    expect((one.raw as { setOtherParamsRaw: ReturnType<typeof vi.fn> }).setOtherParamsRaw.mock.calls[0][0]).toMatchObject({ multiAcks: 1 });

    const big = fakeManager();
    const r2 = await restoreMeshCoreBackup(big.m, docOf({ otherParams: { ...snapshot().otherParams, multiAcks: 3 } }));
    expect('multiAcks' in (big.raw as { setOtherParamsRaw: ReturnType<typeof vi.fn> }).setOtherParamsRaw.mock.calls[0][0]).toBe(false);
    expect(r2.skipped).toContainEqual({ section: 'multi_acks', reason: expect.stringContaining('0 or 1') });

    const old = fakeManager({}, { firmwareVer: 6 });
    const r3 = await restoreMeshCoreBackup(old.m, docOf());
    expect('multiAcks' in (old.raw as { setOtherParamsRaw: ReturnType<typeof vi.fn> }).setOtherParamsRaw.mock.calls[0][0]).toBe(false);
    expect(r3.skipped.some((s) => s.section === 'multi_acks')).toBe(true);
  });

  it('flags a different identity but still restores', async () => {
    const { m } = fakeManager({}, { publicKey: 'cd'.repeat(32) });
    const r = await restoreMeshCoreBackup(m, docOf());
    expect(r.identityMismatch).toBe(true);
    expect(r.applied).toContain('radio');
  });

  it('clamps TX power above the radio maximum (and says so); refuses it when the maximum is unknown', async () => {
    const hi = fakeManager();
    const r = await restoreMeshCoreBackup(hi.m, docOf({ txPower: 30 }));
    expect((hi.raw as { setTxPower: ReturnType<typeof vi.fn> }).setTxPower).toHaveBeenCalledWith(22);
    expect(r.skipped).toContainEqual({ section: 'tx_power', reason: expect.stringContaining('clamped to 22') });
    expect(r.applied).toContain('tx_power');

    const unknown = fakeManager({}, { maxTxPower: undefined });
    const r2 = await restoreMeshCoreBackup(unknown.m, docOf());
    expect((unknown.raw as { setTxPower: ReturnType<typeof vi.fn> }).setTxPower).not.toHaveBeenCalled();
    expect(r2.skipped).toContainEqual({ section: 'tx_power', reason: expect.stringContaining('unknown') });
  });

  it('passes channels with scope to the manager and reports skipped slots', async () => {
    const { m, raw } = fakeManager();
    const doc = docOf({ channels: [{ idx: 0, name: 'Public', secretHex: SECRET_A, scope: null }, { idx: 5, name: 'Five', secretHex: SECRET_B, scope: 'eu' }] });
    const r = await restoreMeshCoreBackup(m, doc);
    expect((raw as { restoreChannels: ReturnType<typeof vi.fn> }).restoreChannels.mock.calls[0][0]).toEqual([
      { idx: 0, name: 'Public', secretHex: SECRET_A, scope: null },
      { idx: 5, name: 'Five', secretHex: SECRET_B, scope: 'eu' },
    ]);
    expect(r.skipped).toContainEqual({ section: 'channel 0', reason: 'slot 0 is reserved' });
    expect(r.channels).toBe(1);
  });

  it('a partial backup (no channels, no radio) only touches what it holds', async () => {
    const { m, order } = fakeManager();
    await restoreMeshCoreBackup(m, docOf({ channels: [], radio: null, blePin: null, autoAdd: null }));
    expect(order).not.toContain('channels');
    expect(order).not.toContain('radio');
    expect(order).not.toContain('ble_pin');
  });

  it('never exports the private key, reads contacts, or logs secrets', async () => {
    const { m, raw } = fakeManager({ setName: vi.fn(async () => { throw new Error('boom'); }) });
    await restoreMeshCoreBackup(m, docOf());
    expect((raw as { exportPrivateKey: ReturnType<typeof vi.fn> }).exportPrivateKey).not.toHaveBeenCalled();
    expect((raw as { getContacts: ReturnType<typeof vi.fn> }).getContacts).not.toHaveBeenCalled();
    const logged = JSON.stringify(logSpy.calls);
    for (const secret of [SECRET_A, SECRET_B, SECRET_C, '123456', PRIVATE_KEY_HEX]) expect(logged).not.toContain(secret);
  });
});

describe('generate', () => {
  it('uses only the snapshot reader: no private key, no contacts, no secret in logs', async () => {
    logSpy.calls.length = 0;
    const m = {
      readBackupSnapshot: vi.fn(async () => snapshot()),
      exportPrivateKey: vi.fn(async () => PRIVATE_KEY_HEX),
      getContacts: vi.fn(async () => []),
      getContactsList: vi.fn(async () => []),
      getLocalNode: () => ({ publicKey: PUBKEY }),
    };
    const text = await meshcoreBackupAdapter.generate(m as never, 'src');
    expect(m.readBackupSnapshot).toHaveBeenCalledTimes(1);
    expect(m.exportPrivateKey).not.toHaveBeenCalled();
    expect(m.getContacts).not.toHaveBeenCalled();

    // The file: no private-key names, no 64-byte (128 hex) value, no contacts section.
    expect(text).not.toMatch(/private|prv/i);
    expect(text).not.toMatch(/[0-9a-f]{128}/i);
    expect(text).not.toContain(PRIVATE_KEY_HEX);
    expect(text).not.toMatch(/^contacts:/m);
    // 32-hex values appear only as channel secrets; 64-hex only as the device PUBLIC key.
    const hex64 = text.match(/[0-9a-f]{64}/gi) ?? [];
    expect(hex64).toEqual([PUBKEY]);
    expect(JSON.stringify(logSpy.calls)).not.toContain(SECRET_A);
  });

  it('identify uses a short public-key prefix for the filename', () => {
    expect(meshcoreBackupAdapter.identify({ getLocalNode: () => ({ publicKey: PUBKEY.toUpperCase() }) } as never)).toEqual({ nodeId: 'abababababab', nodeNum: null });
    expect(meshcoreBackupAdapter.identify({ getLocalNode: () => null } as never).nodeId).toBe('unknown');
  });
});
