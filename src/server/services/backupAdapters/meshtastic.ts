/**
 * Meshtastic adapter: wraps the existing CLI-compatible backup/restore
 * services unchanged. The file needs no header (it stays `meshtastic
 * --export-config` compatible); a MeshMonitor MeshCore file is told apart by
 * its `meshmonitor_backup` key.
 */
import YAML from 'yamljs';
import { deviceBackupService } from '../deviceBackupService.js';
import { deviceRestoreService, type RestoreTargetManager } from '../deviceRestoreService.js';
import {
  BackupProtocolMismatchError,
  type BackupSummary,
  type DeviceConfigBackupAdapter,
} from './types.js';

interface MeshtasticManagerLike extends RestoreTargetManager {
  getLocalNodeInfo(): { nodeId?: string; nodeNum?: number } | null | undefined;
}

export interface MeshtasticBackupDoc {
  yaml: string;
  parsed: Record<string, unknown>;
}

export const meshtasticBackupAdapter: DeviceConfigBackupAdapter<MeshtasticManagerLike, MeshtasticBackupDoc> = {
  protocol: 'meshtastic',
  fileTag: 'mt',
  restoreTimeoutMs: 90_000,

  identify(manager) {
    const info = manager.getLocalNodeInfo();
    return { nodeId: info?.nodeId || '!unknown', nodeNum: info?.nodeNum ?? null };
  },

  generate(manager) {
    return deviceBackupService.generateBackup(manager);
  },

  parse(yaml) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(yaml);
    } catch {
      throw new BackupProtocolMismatchError('Backup file is not valid YAML');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new BackupProtocolMismatchError('Backup file is empty or not valid YAML');
    }
    if ('meshmonitor_backup' in (parsed as object)) {
      throw new BackupProtocolMismatchError();
    }
    return { yaml, parsed: parsed as Record<string, unknown> };
  },

  summarize(doc): BackupSummary {
    const p = doc.parsed as {
      owner?: unknown; owner_short?: unknown; channel_url?: unknown;
      config?: Record<string, unknown>; module_config?: Record<string, unknown>;
    };
    const lora = (p.config?.lora ?? {}) as Record<string, unknown>;
    const radio: Record<string, string | number> = {};
    for (const k of ['region', 'modem_preset', 'hop_limit', 'tx_power', 'channel_num']) {
      const v = lora[k];
      if (typeof v === 'string' || typeof v === 'number') radio[k] = v;
    }
    const sections = [
      ...(p.owner || p.owner_short ? ['owner'] : []),
      ...Object.keys(p.config ?? {}).map(k => `config.${k}`),
      ...Object.keys(p.module_config ?? {}).map(k => `module_config.${k}`),
      ...(p.channel_url ? ['channels'] : []),
    ];
    return {
      protocol: 'meshtastic',
      name: typeof p.owner === 'string' ? p.owner : undefined,
      radio,
      // Channel names live inside the encoded channel_url; slot contents are
      // not shown (they hold PSKs).
      channels: [],
      sections,
      requiresReboot: true,
    };
  },

  async restore(manager, doc) {
    const r = await deviceRestoreService.restoreBackup(manager, doc.yaml);
    return { applied: r.applied, failed: r.failed, warnings: r.warnings, channels: r.channels, requiresReboot: r.requiresReboot };
  },
};
