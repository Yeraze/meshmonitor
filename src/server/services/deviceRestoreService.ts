/**
 * Device Restore Service
 *
 * Restores a device-config YAML backup (produced by deviceBackupService) to the
 * LOCAL connected Meshtastic node via admin messages — the same set*Config
 * mechanism the Remote Admin config panels and channel-URL import use.
 *
 * Scope (issue #4926): LOCAL node only. Sections are written verbatim from the
 * backup, including the LoRa txEnabled value (a true "restore" reproduces the
 * captured config). The one safety net: if a backup's lora section has NO
 * txEnabled key at all (proto3 would then decode it as false and silently kill
 * TX — the #1328/#4294 hazard, since setLoRaConfig replaces the whole struct),
 * we backfill the device's current txEnabled rather than transmit false.
 *
 * The whole restore runs inside a beginEditSettings/commitEditSettings
 * transaction with pacing between admin packets — firmware silently drops admin
 * packets that arrive too soon after BeginEditSettings on the TCP PhoneAPI (see
 * adminRoutes.ts POST /import-config for the same pattern).
 */

import YAML from 'yamljs';
import { EnumMappings } from './deviceBackupService.js';
import { logger } from '../../utils/logger.js';

/**
 * The subset of the Meshtastic manager the restore drives. The real
 * MeshtasticManager (returned by resolveSourceManager) satisfies this
 * structurally, and so does the test double.
 */
export interface RestoreTargetManager {
  beginEditSettings(): Promise<void>;
  commitEditSettings(): Promise<void>;
  setDeviceConfig(config: unknown): Promise<void>;
  setLoRaConfig(config: unknown): Promise<void>;
  setPositionConfig(config: unknown): Promise<void>;
  setNetworkConfig(config: unknown): Promise<void>;
  setPowerConfig(config: unknown): Promise<void>;
  setDisplayConfig(config: unknown): Promise<void>;
  setBluetoothConfig(config: unknown): Promise<void>;
  setMQTTConfig(config: unknown): Promise<void>;
  setTelemetryConfig(config: unknown): Promise<void>;
  setNeighborInfoConfig(config: unknown): Promise<void>;
  setGenericModuleConfig(moduleType: string, config: unknown): Promise<void>;
  setChannelConfig(channelIndex: number, config: unknown): Promise<void>;
  setNodeOwner(longName: string, shortName: string): Promise<void>;
  isTxEnabled(): boolean;
}

type ConfigSection = Record<string, unknown>;

interface BackupDoc {
  owner?: unknown;
  owner_short?: unknown;
  channel_url?: unknown;
  location?: { lat?: number; lon?: number; alt?: number };
  config?: Record<string, ConfigSection>;
  module_config?: Record<string, ConfigSection>;
}

// Pacing (ms). Matches the battle-tested import-config flow.
const PACE_AFTER_BEGIN_MS = 2000;
const PACE_BETWEEN_SECTIONS_MS = 700;
const PACE_PER_CHANNEL_MS = 1000;
const PACE_BEFORE_COMMIT_MS = 1500;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Invert a number->name enum table into a name->number lookup. */
function invert(map: Record<number, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [num, name] of Object.entries(map)) {
    out[name] = Number(num);
  }
  return out;
}

const ROLE_TO_NUM = invert(EnumMappings.Role);
const MODEM_PRESET_TO_NUM = invert(EnumMappings.ModemPreset);
const REGION_TO_NUM = invert(EnumMappings.RegionCode);
const DETECTION_TRIGGER_TO_NUM = invert(EnumMappings.DetectionTriggerType);

/** If value is a known enum string name, convert it back to its number. */
function toEnumNum(lookup: Record<string, number>, value: unknown): unknown {
  if (typeof value === 'string' && lookup[value] !== undefined) {
    return lookup[value];
  }
  return value;
}

/**
 * Map a module_config protobuf field name (camelCase, as written by the backup)
 * to the moduleType string that setGenericModuleConfig expects. `telemetry`,
 * `neighborInfo`, and `mqtt` are handled by dedicated setters and excluded here.
 */
const MODULE_FIELD_TO_TYPE: Record<string, string> = {
  serial: 'serial',
  externalNotification: 'extnotif',
  storeForward: 'storeforward',
  rangeTest: 'rangetest',
  cannedMessage: 'cannedmsg',
  audio: 'audio',
  remoteHardware: 'remotehardware',
  ambientLighting: 'ambientlighting',
  detectionSensor: 'detectionsensor',
  paxcounter: 'paxcounter',
  statusmessage: 'statusmessage',
  trafficManagement: 'trafficmanagement',
  meshBeacon: 'meshbeacon',
};

export interface RestoreResult {
  applied: string[];
  failed: Array<{ section: string; error: string }>;
  channels: number;
  requiresReboot: boolean;
}

class DeviceRestoreService {
  /** Parse a backup YAML string into a plain object. Throws on invalid YAML. */
  parseBackup(yaml: string): BackupDoc {
    const parsed = YAML.parse(yaml);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Backup file is empty or not valid YAML');
    }
    return parsed as BackupDoc;
  }

  /**
   * Restore a backup YAML to the local node behind `manager`.
   * Best-effort per section: a failing section is recorded and the restore
   * continues, so a single unsupported field can't abort the whole restore.
   * Only a failure to open the edit transaction aborts.
   */
  async restoreBackup(manager: RestoreTargetManager, yaml: string): Promise<RestoreResult> {
    const backup = this.parseBackup(yaml);
    const config = backup.config ?? {};
    const moduleConfig = backup.module_config ?? {};

    const applied: string[] = [];
    const failed: Array<{ section: string; error: string }> = [];
    let channels = 0;
    let requiresReboot = false;

    // Open the transaction. Failure here is fatal — nothing else can be sent.
    try {
      await manager.beginEditSettings();
      await delay(PACE_AFTER_BEGIN_MS);
    } catch (error) {
      logger.error('❌ Restore: failed to begin edit settings transaction:', error);
      throw new Error('Failed to start configuration transaction', { cause: error });
    }

    // Helper: run one section, record success/failure, pace afterwards.
    const runSection = async (name: string, fn: () => Promise<void>, paceMs = PACE_BETWEEN_SECTIONS_MS) => {
      try {
        await fn();
        applied.push(name);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Restore: failed to apply ${name}:`, error);
        failed.push({ section: name, error: msg });
      }
      await delay(paceMs);
    };

    // --- Owner ---
    if (backup.owner || backup.owner_short) {
      await runSection('owner', () =>
        manager.setNodeOwner(String(backup.owner ?? ''), String(backup.owner_short ?? '')));
    }

    // --- Device config sections (Config.*) ---
    if (config.device) {
      const device = { ...config.device, role: toEnumNum(ROLE_TO_NUM, config.device.role) };
      await runSection('config.device', () => manager.setDeviceConfig(device));
    }

    // Position: merge the backup's fixed `location` (lat/lon/alt) into the
    // position config, renamed to the latitude/longitude/altitude keys
    // setPositionConfig destructures to send a set_fixed_position message.
    if (config.position || backup.location) {
      const position: ConfigSection = { ...(config.position ?? {}) };
      if (backup.location) {
        if (backup.location.lat !== undefined) position.latitude = backup.location.lat;
        if (backup.location.lon !== undefined) position.longitude = backup.location.lon;
        if (backup.location.alt !== undefined) position.altitude = backup.location.alt;
      }
      await runSection('config.position', () => manager.setPositionConfig(position));
    }

    if (config.network) {
      await runSection('config.network', () => manager.setNetworkConfig(config.network));
    }
    if (config.power) {
      await runSection('config.power', () => manager.setPowerConfig(config.power));
    }
    if (config.display) {
      await runSection('config.display', () => manager.setDisplayConfig(config.display));
    }
    if (config.bluetooth) {
      await runSection('config.bluetooth', () => manager.setBluetoothConfig(config.bluetooth));
    }

    // --- Module config sections (ModuleConfig.*) ---
    if (moduleConfig.mqtt) {
      await runSection('module.mqtt', () => manager.setMQTTConfig(moduleConfig.mqtt));
    }
    if (moduleConfig.telemetry) {
      await runSection('module.telemetry', () => manager.setTelemetryConfig(moduleConfig.telemetry));
    }
    if (moduleConfig.neighborInfo) {
      await runSection('module.neighborInfo', () => manager.setNeighborInfoConfig(moduleConfig.neighborInfo));
    }
    for (const [field, moduleType] of Object.entries(MODULE_FIELD_TO_TYPE)) {
      const section = moduleConfig[field];
      if (!section) continue;
      let payload: ConfigSection = section;
      if (field === 'detectionSensor' && section.detectionTriggerType !== undefined) {
        payload = { ...section, detectionTriggerType: toEnumNum(DETECTION_TRIGGER_TO_NUM, section.detectionTriggerType) };
      }
      await runSection(`module.${field}`, () => manager.setGenericModuleConfig(moduleType, payload));
    }

    // --- Channels (from channel_url) ---
    if (typeof backup.channel_url === 'string' && backup.channel_url.length > 0) {
      try {
        const channelUrlService = (await import('./channelUrlService.js')).default;
        const decoded = channelUrlService.decodeUrl(backup.channel_url);
        if (decoded?.channels?.length) {
          for (let i = 0; i < decoded.channels.length; i++) {
            const channel = decoded.channels[i];
            let role = channel.role;
            if (role === undefined) role = i === 0 ? 1 : 2; // PRIMARY : SECONDARY
            await runSection(`channel.${i}`, () =>
              manager.setChannelConfig(i, {
                name: channel.name || '',
                psk: channel.psk === 'none' ? undefined : channel.psk,
                role,
                uplinkEnabled: channel.uplinkEnabled,
                downlinkEnabled: channel.downlinkEnabled,
                positionPrecision: channel.positionPrecision,
              }), PACE_PER_CHANNEL_MS);
            channels++;
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('❌ Restore: failed to decode/apply channel_url:', error);
        failed.push({ section: 'channels', error: msg });
      }
    }

    // --- LoRa (last: region/preset change requires a reboot) ---
    if (config.lora) {
      const lora: ConfigSection = {
        ...config.lora,
        modemPreset: toEnumNum(MODEM_PRESET_TO_NUM, config.lora.modemPreset),
        region: toEnumNum(REGION_TO_NUM, config.lora.region),
      };
      // Verbatim txEnabled — but never send an *omitted* bool (proto3 -> false
      // silently disables TX). Backfill the device's current value if absent.
      if (lora.txEnabled === undefined) {
        lora.txEnabled = manager.isTxEnabled();
      }
      await runSection('config.lora', () => manager.setLoRaConfig(lora), PACE_BEFORE_COMMIT_MS);
      // Only claim a reboot is needed if the LoRa write actually landed — a
      // failed setLoRaConfig (recorded in `failed`) changed nothing on the
      // device, so reporting requiresReboot would be a misleading UX warning.
      requiresReboot = applied.includes('config.lora');
    }

    // Commit (its own 2s flash-settle delay is built into the manager method).
    try {
      await manager.commitEditSettings();
    } catch (error) {
      logger.error('❌ Restore: failed to commit edit settings:', error);
      throw new Error('Failed to commit configuration transaction', { cause: error });
    }

    logger.info(`✅ Restore complete: ${applied.length} section(s) applied, ${failed.length} failed, ${channels} channel(s)`);
    return { applied, failed, channels, requiresReboot };
  }
}

export const deviceRestoreService = new DeviceRestoreService();
