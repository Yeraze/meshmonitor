/**
 * MeshCore Companion adapter (P16 #6285).
 *
 * File: plaintext YAML (mode 0600, kept out of system backups) holding the
 * name, radio, TX power, coordinates, other params, auto-add, path hash size,
 * BLE PIN, channels (with secrets) and a fixed whitelist of MeshMonitor
 * per-source settings. NEVER the private key, NEVER contacts.
 *
 * Restore is local serial only (no RF) and best effort per section, like the
 * Meshtastic restore. The radio is written LAST: it applies at once and a
 * backup taken on another frequency takes the node off its mesh.
 *
 * Nothing here logs YAML, secrets or the PIN.
 */
import YAML from 'yamljs';
import type {
  MeshCoreManager,
  MeshCoreBackupSnapshot,
  MeshCoreRestoreChannelSlot,
} from '../../meshcoreManager.js';
import {
  BackupProtocolMismatchError,
  type BackupSummary,
  type DeviceConfigBackupAdapter,
  type RestoreResult,
} from './types.js';

export const MESHCORE_BACKUP_HEADER = 'meshcore_companion';
export const MESHCORE_BACKUP_FORMAT_VERSION = 1;

/** The firmware code (DeviceInfo `fw ver`) from which the multi_acks byte exists. */
const MULTI_ACKS_MIN_FIRMWARE = 7;

export interface MeshCoreBackupDoc {
  createdAt: string;
  device: { publicKey: string; model?: string; firmwareVer?: number; firmwareBuild?: string; maxChannels?: number };
  config: {
    name?: string;
    radio?: { freq: number; bw: number; sf: number; cr: number };
    txPower?: number;
    location?: { lat: number; lon: number };
    otherParams?: {
      manualAddContactsRaw?: number;
      telemetryModeBase?: number;
      telemetryModeLoc?: number;
      telemetryModeEnv?: number;
      advLocPolicy?: number;
      multiAcks?: number;
    };
    autoAdd?: {
      overwriteOldest: boolean;
      types: { chat: boolean; repeater: boolean; room: boolean; sensor: boolean };
      maxHops: number;
    };
    pathHashSize?: 1 | 2 | 3;
    blePin?: number;
  };
  channels: Array<{ idx: number; name: string; secretHex: string; scope?: string }>;
  meshmonitor: { defaultScope?: string; defaultPathHashSize?: 1 | 2 | 3; respondToDiscovery?: boolean };
}

// ---------- generate ----------

const q = (s: string): string => JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar
const num = (n: number): string => (Number.isFinite(n) ? String(n) : 'null');

/** Render the YAML. Every string is double-quoted so a hex key never parses as a number. */
export function renderMeshCoreBackup(snap: MeshCoreBackupSnapshot, createdAt: string): string {
  const L: string[] = [];
  L.push('# MeshMonitor MeshCore Companion backup. Holds channel secrets and the BLE PIN: store it safely.');
  L.push(`meshmonitor_backup: ${MESHCORE_BACKUP_HEADER}`);
  L.push(`format_version: ${MESHCORE_BACKUP_FORMAT_VERSION}`);
  L.push(`created_at: ${q(createdAt)}`);
  L.push('device:');
  L.push(`  public_key: ${q(snap.publicKey.toLowerCase())}`);
  if (snap.model) L.push(`  model: ${q(snap.model)}`);
  if (snap.firmwareVer !== undefined) L.push(`  firmware_ver: ${num(snap.firmwareVer)}`);
  if (snap.firmwareBuild) L.push(`  firmware_build: ${q(snap.firmwareBuild)}`);
  if (snap.maxChannels !== undefined) L.push(`  max_channels: ${num(snap.maxChannels)}`);

  L.push('config:');
  L.push(`  name: ${q(snap.name ?? '')}`);
  if (snap.radio) {
    L.push('  radio:');
    L.push(`    freq: ${num(snap.radio.freq)}`);
    L.push(`    bw: ${num(snap.radio.bw)}`);
    L.push(`    sf: ${num(snap.radio.sf)}`);
    L.push(`    cr: ${num(snap.radio.cr)}`);
  }
  if (snap.txPower !== undefined) L.push(`  tx_power: ${num(snap.txPower)}`);
  if (snap.latitude !== undefined && snap.longitude !== undefined) {
    L.push('  location:');
    L.push(`    lat: ${num(snap.latitude)}`);
    L.push(`    lon: ${num(snap.longitude)}`);
  }
  const o = snap.otherParams;
  if (o.manualAddContactsRaw !== undefined) {
    L.push('  other_params:');
    L.push(`    manual_add_contacts_raw: ${num(o.manualAddContactsRaw)}`);
    if (o.telemetryModeBase !== undefined) L.push(`    telemetry_mode_base: ${num(o.telemetryModeBase)}`);
    if (o.telemetryModeLoc !== undefined) L.push(`    telemetry_mode_loc: ${num(o.telemetryModeLoc)}`);
    if (o.telemetryModeEnv !== undefined) L.push(`    telemetry_mode_env: ${num(o.telemetryModeEnv)}`);
    if (o.advLocPolicy !== undefined) L.push(`    adv_loc_policy: ${num(o.advLocPolicy)}`);
    if (o.multiAcks !== undefined) L.push(`    multi_acks: ${num(o.multiAcks)}`);
  }
  if (snap.autoAdd) {
    L.push('  auto_add:');
    L.push(`    overwrite_oldest: ${snap.autoAdd.overwriteOldest}`);
    L.push('    types:');
    L.push(`      chat: ${snap.autoAdd.types.chat}`);
    L.push(`      repeater: ${snap.autoAdd.types.repeater}`);
    L.push(`      room: ${snap.autoAdd.types.room}`);
    L.push(`      sensor: ${snap.autoAdd.types.sensor}`);
    L.push(`    max_hops: ${num(snap.autoAdd.maxHops)}`);
  }
  L.push(`  path_hash_size: ${snap.settings.defaultPathHashSize}`);
  if (snap.blePin !== null) L.push(`  ble_pin: ${num(snap.blePin)}`);

  if (snap.channels.length === 0) {
    L.push('channels: []');
  } else {
    L.push('channels:');
    for (const ch of snap.channels) {
      L.push(`  - idx: ${num(ch.idx)}`);
      L.push(`    name: ${q(ch.name)}`);
      L.push(`    secret_hex: ${q(ch.secretHex.toLowerCase())}`);
      if (ch.scope) L.push(`    scope: ${q(ch.scope)}`);
    }
  }

  L.push('meshmonitor:');
  L.push(`  default_scope: ${q(snap.settings.defaultScope)}`);
  L.push(`  default_path_hash_size: ${snap.settings.defaultPathHashSize}`);
  L.push(`  respond_to_discovery: ${snap.settings.respondToDiscovery}`);
  return L.join('\n') + '\n';
}

// ---------- parse ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const numOr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strOr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const boolOr = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const size = (v: unknown): 1 | 2 | 3 | undefined => (v === 1 || v === 2 || v === 3 ? v : undefined);

export function parseMeshCoreBackup(yaml: string): MeshCoreBackupDoc {
  let raw: unknown;
  try {
    raw = YAML.parse(yaml);
  } catch {
    throw new BackupProtocolMismatchError('Backup file is not valid YAML');
  }
  if (!isObj(raw)) throw new BackupProtocolMismatchError('Backup file is empty or not valid YAML');
  if (raw.meshmonitor_backup !== MESHCORE_BACKUP_HEADER) throw new BackupProtocolMismatchError();
  if (raw.format_version !== MESHCORE_BACKUP_FORMAT_VERSION) {
    throw new BackupProtocolMismatchError('This backup was made by a newer MeshMonitor format');
  }
  const device = isObj(raw.device) ? raw.device : {};
  const config = isObj(raw.config) ? raw.config : {};
  const radio = isObj(config.radio) ? config.radio : undefined;
  const loc = isObj(config.location) ? config.location : undefined;
  const op = isObj(config.other_params) ? config.other_params : undefined;
  const aa = isObj(config.auto_add) ? config.auto_add : undefined;
  const aaTypes = aa && isObj(aa.types) ? aa.types : {};
  const mm = isObj(raw.meshmonitor) ? raw.meshmonitor : {};

  const channels: MeshCoreBackupDoc['channels'] = [];
  if (Array.isArray(raw.channels)) {
    for (const c of raw.channels) {
      if (!isObj(c)) continue;
      const idx = numOr(c.idx);
      const secret = strOr(c.secret_hex);
      if (idx === undefined || !Number.isInteger(idx) || secret === undefined) continue;
      channels.push({
        idx,
        name: strOr(c.name) ?? '',
        secretHex: secret,
        ...(strOr(c.scope) ? { scope: strOr(c.scope) } : {}),
      });
    }
  }

  const doc: MeshCoreBackupDoc = {
    createdAt: strOr(raw.created_at) ?? '',
    device: {
      publicKey: (strOr(device.public_key) ?? '').toLowerCase(),
      model: strOr(device.model),
      firmwareVer: numOr(device.firmware_ver),
      firmwareBuild: strOr(device.firmware_build),
      maxChannels: numOr(device.max_channels),
    },
    config: {
      name: strOr(config.name),
      radio:
        radio && [radio.freq, radio.bw, radio.sf, radio.cr].every((v) => numOr(v) !== undefined)
          ? { freq: radio.freq as number, bw: radio.bw as number, sf: radio.sf as number, cr: radio.cr as number }
          : undefined,
      txPower: numOr(config.tx_power),
      location:
        loc && numOr(loc.lat) !== undefined && numOr(loc.lon) !== undefined
          ? { lat: loc.lat as number, lon: loc.lon as number }
          : undefined,
      otherParams: op
        ? {
            manualAddContactsRaw: numOr(op.manual_add_contacts_raw),
            telemetryModeBase: numOr(op.telemetry_mode_base),
            telemetryModeLoc: numOr(op.telemetry_mode_loc),
            telemetryModeEnv: numOr(op.telemetry_mode_env),
            advLocPolicy: numOr(op.adv_loc_policy),
            multiAcks: numOr(op.multi_acks),
          }
        : undefined,
      autoAdd: aa
        ? {
            overwriteOldest: boolOr(aa.overwrite_oldest) ?? false,
            types: {
              chat: boolOr(aaTypes.chat) ?? false,
              repeater: boolOr(aaTypes.repeater) ?? false,
              room: boolOr(aaTypes.room) ?? false,
              sensor: boolOr(aaTypes.sensor) ?? false,
            },
            maxHops: numOr(aa.max_hops) ?? 0,
          }
        : undefined,
      pathHashSize: size(config.path_hash_size),
      blePin: numOr(config.ble_pin),
    },
    channels,
    meshmonitor: {
      defaultScope: strOr(mm.default_scope),
      defaultPathHashSize: size(mm.default_path_hash_size),
      respondToDiscovery: boolOr(mm.respond_to_discovery),
    },
  };
  return doc;
}

// ---------- summarize ----------

function radioLabel(r: { freq: number; bw: number; sf: number; cr: number }): Record<string, string | number> {
  return { freq: r.freq, bw: r.bw, sf: r.sf, cr: r.cr };
}

export function summarizeMeshCoreBackup(doc: MeshCoreBackupDoc, manager?: MeshCoreManager): BackupSummary {
  const sections: string[] = [];
  const c = doc.config;
  if (c.name !== undefined) sections.push('name');
  if (c.location) sections.push('location');
  if (c.otherParams) sections.push('other_params');
  if (c.autoAdd) sections.push('auto_add');
  if (c.pathHashSize) sections.push('path_hash_size');
  if (c.blePin !== undefined) sections.push('ble_pin');
  if (doc.channels.length) sections.push('channels');
  if (doc.meshmonitor.defaultScope !== undefined || doc.meshmonitor.respondToDiscovery !== undefined) {
    sections.push('meshmonitor');
  }
  if (c.txPower !== undefined) sections.push('tx_power');
  if (c.radio) sections.push('radio');

  const live = manager?.getLocalNode?.() ?? null;
  const summary: BackupSummary = {
    protocol: 'meshcore',
    name: c.name,
    // Only a short prefix of the PUBLIC key: enough to tell radios apart.
    identity: doc.device.publicKey ? doc.device.publicKey.slice(0, 8) : undefined,
    createdAt: doc.createdAt || undefined,
    radio: c.radio ? radioLabel(c.radio) : undefined,
    channels: doc.channels.filter((ch) => ch.idx !== 0).map((ch) => ({ idx: ch.idx, name: ch.name })),
    sections,
    requiresReboot: c.blePin !== undefined,
  };
  if (live) {
    summary.identityMismatch = !!doc.device.publicKey && live.publicKey.toLowerCase() !== doc.device.publicKey;
    if (
      [live.radioFreq, live.radioBw, live.radioSf, live.radioCr].every((v) => typeof v === 'number')
    ) {
      summary.currentRadio = radioLabel({ freq: live.radioFreq!, bw: live.radioBw!, sf: live.radioSf!, cr: live.radioCr! });
      if (c.radio) {
        summary.radioDiffers =
          live.radioFreq !== c.radio.freq || live.radioBw !== c.radio.bw ||
          live.radioSf !== c.radio.sf || live.radioCr !== c.radio.cr;
      }
    }
  }
  return summary;
}

// ---------- restore ----------

export async function restoreMeshCoreBackup(manager: MeshCoreManager, doc: MeshCoreBackupDoc): Promise<RestoreResult> {
  const applied: string[] = [];
  const failed: RestoreResult['failed'] = [];
  const skipped: NonNullable<RestoreResult['skipped']> = [];
  let channelsWritten = 0;
  let requiresReboot = false;
  const c = doc.config;

  const live = manager.getLocalNode();
  const identityMismatch = !!doc.device.publicKey && !!live && live.publicKey.toLowerCase() !== doc.device.publicKey;

  const run = async (section: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      applied.push(section);
    } catch (error) {
      // Error text only; never the values being written.
      failed.push({ section, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const need = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`The radio did not accept ${what}`);
  };

  // 1. name, coordinates
  if (c.name !== undefined) await run('name', async () => need(await manager.setName(c.name!), 'the name'));
  if (c.location) {
    await run('location', async () => need(await manager.setCoords(c.location!.lat, c.location!.lon), 'the coordinates'));
  }

  // 2. other params (raw byte 1; multi_acks only when it is 0 or 1 and the firmware has it)
  const op = c.otherParams;
  if (op) {
    if (
      op.manualAddContactsRaw === undefined || op.telemetryModeBase === undefined ||
      op.telemetryModeLoc === undefined || op.telemetryModeEnv === undefined || op.advLocPolicy === undefined
    ) {
      skipped.push({ section: 'other_params', reason: 'the backup is missing fields' });
    } else {
      let multiAcks: number | undefined;
      if (op.multiAcks !== undefined) {
        if (op.multiAcks !== 0 && op.multiAcks !== 1) {
          skipped.push({ section: 'multi_acks', reason: 'only 0 or 1 is restored (airtime cost)' });
        } else if ((live?.firmwareVer ?? 0) < MULTI_ACKS_MIN_FIRMWARE) {
          skipped.push({ section: 'multi_acks', reason: 'this radio firmware has no multi-ACKs setting' });
        } else {
          multiAcks = op.multiAcks;
        }
      }
      await run('other_params', async () => {
        const r = await manager.setOtherParamsRaw({
          manualAddContactsRaw: op.manualAddContactsRaw!,
          telemetryModeBase: op.telemetryModeBase!,
          telemetryModeLoc: op.telemetryModeLoc!,
          telemetryModeEnv: op.telemetryModeEnv!,
          advLocPolicy: op.advLocPolicy!,
          ...(multiAcks !== undefined ? { multiAcks } : {}),
        });
        if (multiAcks !== undefined && r.multiAcks !== multiAcks) {
          skipped.push({ section: 'multi_acks', reason: 'the radio did not keep the value' });
        }
      });
    }
  }

  // 3. auto-add
  if (c.autoAdd) {
    await run('auto_add', async () => {
      const r = await manager.setAutoAddConfig({
        overwriteOldest: c.autoAdd!.overwriteOldest,
        types: c.autoAdd!.types,
        maxHops: c.autoAdd!.maxHops,
      });
      if (!r.ok) throw new Error(r.error);
      if (!r.config.supported) {
        skipped.push({ section: 'auto_add', reason: 'this radio firmware has no auto-add options' });
      }
    });
  }

  // 4. path hash size (per-source setting, pushed to the radio)
  if (c.pathHashSize) {
    await run('path_hash_size', async () => { await manager.setDefaultPathHashSize(c.pathHashSize!); });
  }

  // 5. BLE PIN (applies at the next boot)
  if (c.blePin !== undefined) {
    await run('ble_pin', async () => {
      const current = await manager.getBlePin();
      if (current === null) {
        skipped.push({ section: 'ble_pin', reason: 'this radio does not report a BLE PIN' });
        return;
      }
      if (current !== c.blePin) {
        await manager.setBlePin(c.blePin!);
        requiresReboot = true;
      }
    });
  }

  // 6. channels: only the slots in the backup; slot 0 and slots past capacity are skipped
  if (doc.channels.length > 0) {
    await run('channels', async () => {
      const slots: MeshCoreRestoreChannelSlot[] = doc.channels.map((ch) => ({
        idx: ch.idx, name: ch.name, secretHex: ch.secretHex, scope: ch.scope ?? null,
      }));
      const r = await manager.restoreChannels(slots);
      channelsWritten = r.written.length;
      for (const s of r.skipped) skipped.push({ section: `channel ${s.idx}`, reason: s.reason });
      for (const f of r.failed) failed.push({ section: `channel ${f.idx}`, error: f.error });
    });
  }

  // 7. MeshMonitor per-source settings (fixed whitelist)
  const mm = doc.meshmonitor;
  if (mm.defaultScope !== undefined || mm.respondToDiscovery !== undefined) {
    await run('meshmonitor', async () => {
      if (mm.defaultScope !== undefined) await manager.setDefaultScope(mm.defaultScope);
      if (mm.respondToDiscovery !== undefined) await manager.setRespondToDiscovery(mm.respondToDiscovery);
    });
  }

  // 8. TX power, clamped to this radio's maximum; refused when the maximum is unknown
  if (c.txPower !== undefined) {
    const max = live?.maxTxPower;
    if (typeof max !== 'number') {
      skipped.push({ section: 'tx_power', reason: "this radio's maximum power is unknown" });
    } else {
      const value = Math.max(1, Math.min(Math.round(c.txPower), max));
      if (value !== c.txPower) {
        skipped.push({ section: 'tx_power', reason: `clamped to ${value} (this radio's maximum is ${max})` });
      }
      await run('tx_power', async () => need(await manager.setTxPower(value), 'the TX power'));
    }
  }

  // 9. radio, LAST: it applies at once
  if (c.radio) {
    await run('radio', async () => need(await manager.setRadio(c.radio!.freq, c.radio!.bw, c.radio!.sf, c.radio!.cr), 'the radio settings'));
  }

  return { applied, failed, skipped, channels: channelsWritten, requiresReboot, identityMismatch };
}

// ---------- adapter ----------

export const meshcoreBackupAdapter: DeviceConfigBackupAdapter<MeshCoreManager, MeshCoreBackupDoc> = {
  protocol: 'meshcore',
  fileTag: 'mc',
  restoreTimeoutMs: 120_000,

  identify(manager) {
    const key = manager.getLocalNode()?.publicKey ?? '';
    return { nodeId: key ? key.slice(0, 12).toLowerCase() : 'unknown', nodeNum: null };
  },

  async generate(manager) {
    const snap = await manager.readBackupSnapshot();
    return renderMeshCoreBackup(snap, new Date().toISOString());
  },

  parse: parseMeshCoreBackup,
  summarize: summarizeMeshCoreBackup,
  restore: (manager, doc) => restoreMeshCoreBackup(manager, doc),
};
