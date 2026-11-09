/**
 * Device-config backup pipeline (#6285): create / list / get / summarize /
 * restore, shared by Meshtastic and MeshCore through protocol adapters.
 *
 * Source scoping lives here and in `backupFileService`: a filename is only
 * ever resolved inside the target source; unowned (legacy / orphaned) rows are
 * visible to admins alone. Nothing here logs file content, secrets or YAML.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { backupFileService, BackupNotFoundError, type BackupFile } from './backupFileService.js';
import {
  getBackupAdapter,
  BackupProtocolMismatchError,
  type BackupProtocol,
  type BackupSummary,
  type RestoreResult,
} from './backupAdapters/index.js';

export { BackupNotFoundError, BackupProtocolMismatchError };

/** A restore for this source is already running (HTTP 409 RESTORE_IN_PROGRESS). */
export class RestoreInProgressError extends Error {
  constructor() {
    super('A restore is already in progress for this source');
    this.name = 'RestoreInProgressError';
  }
}

/** Restoring an unowned file needs an explicit second confirmation (HTTP 409). */
export class LegacyConfirmRequiredError extends Error {
  constructor() {
    super('This backup has no owning source; confirm restoring it onto this device');
    this.name = 'LegacyConfirmRequiredError';
  }
}

export interface BackupTarget {
  sourceId: string;
  protocol: BackupProtocol;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- protocol-specific manager, typed by its adapter
  manager: any;
}

export interface CallerInfo {
  isAdmin: boolean;
  userId: number | null;
  ip: string | null;
}

const restoring = new Set<string>();
const creating = new Set<string>();

/** True while a restore or an in-flight create holds this source (scheduler respects it). */
export function isBackupBusy(sourceId: string): boolean {
  return restoring.has(sourceId) || creating.has(sourceId);
}

function audit(caller: Pick<CallerInfo, 'userId' | 'ip'>, action: string, details: Record<string, unknown>): void {
  void Promise.resolve()
    .then(() => databaseService.auditLogAsync(caller.userId, action, 'device_backup', JSON.stringify(details), caller.ip))
    .catch((err: unknown) => logger.warn(`Audit write failed for ${action}:`, err instanceof Error ? err.message : String(err)));
}

class DeviceConfigBackupService {
  /**
   * Read the device, write the file, purge old files. Returns the filename
   * and the YAML (for the download response; callers must not log it).
   */
  async create(
    target: BackupTarget,
    type: 'manual' | 'automatic',
    caller?: Pick<CallerInfo, 'userId' | 'ip'>,
  ): Promise<{ filename: string; content: string }> {
    const adapter = getBackupAdapter(target.protocol);
    if (restoring.has(target.sourceId) || creating.has(target.sourceId)) {
      throw new RestoreInProgressError();
    }
    creating.add(target.sourceId);
    try {
      const content = await adapter.generate(target.manager, target.sourceId);
      const { nodeId, nodeNum } = adapter.identify(target.manager);
      const filename = await backupFileService.saveBackup({
        content, type, sourceId: target.sourceId, protocol: target.protocol, nodeId, nodeNum,
      });
      audit(caller ?? { userId: null, ip: null }, 'device_backup_created', {
        sourceId: target.sourceId, protocol: target.protocol, filename, type,
      });
      return { filename, content };
    } finally {
      creating.delete(target.sourceId);
    }
  }

  /** Generate without saving (the `save=false` download). */
  async generateOnly(target: BackupTarget): Promise<{ filename: string; content: string }> {
    const adapter = getBackupAdapter(target.protocol);
    const content = await adapter.generate(target.manager, target.sourceId);
    const { nodeId } = adapter.identify(target.manager);
    const iso = new Date().toISOString();
    const clean = nodeId.replace(/^!/, '').replace(/[^a-zA-Z0-9]/g, '') || 'unknown';
    const filename = `${adapter.fileTag}-${clean}-${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '-')}.yaml`;
    return { filename, content };
  }

  /** The source's files; admins also see unowned rows of the same protocol (`legacy: true`). */
  list(sourceId: string, protocol: BackupProtocol, caller: Pick<CallerInfo, 'isAdmin'>): Promise<BackupFile[]> {
    return backupFileService.listBackups(sourceId, { includeUnowned: caller.isAdmin, protocol });
  }

  /** File content for download. 404 for another source's file. */
  async get(
    sourceId: string,
    filename: string,
    caller: CallerInfo,
  ): Promise<string> {
    const content = await backupFileService.getBackup(sourceId, filename, { includeUnowned: caller.isAdmin });
    audit(caller, 'device_backup_downloaded', { sourceId, filename });
    return content;
  }

  async delete(sourceId: string, filename: string, caller: CallerInfo): Promise<void> {
    await backupFileService.deleteBackup(sourceId, filename, { includeUnowned: caller.isAdmin });
    audit(caller, 'device_backup_deleted', { sourceId, filename });
  }

  /** No-secret summary for the restore confirm dialog. */
  async summarize(
    sourceId: string,
    protocol: BackupProtocol,
    filename: string,
    caller: Pick<CallerInfo, 'isAdmin'>,
    manager?: unknown,
  ): Promise<BackupSummary & { legacy: boolean; fileProtocol: BackupProtocol }> {
    const found = await backupFileService.findBackup(sourceId, filename, { includeUnowned: caller.isAdmin });
    if (!found) throw new BackupNotFoundError();
    const fileProtocol = (found.row.protocol as BackupProtocol) ?? 'meshtastic';
    if (fileProtocol !== protocol) throw new BackupProtocolMismatchError();
    const adapter = getBackupAdapter(protocol);
    const doc = adapter.parse(backupFileService.readRow(found.row));
    return { ...adapter.summarize(doc, manager), legacy: found.legacy, fileProtocol };
  }

  /**
   * Restore a stored file onto the target's device. Order of checks: row
   * lookup (404), protocol (409), legacy confirmation (409), header parse
   * (409), per-source lock (409).
   */
  async restore(
    target: BackupTarget,
    filename: string,
    caller: CallerInfo,
    opts: { confirmLegacy?: boolean } = {},
  ): Promise<RestoreResult> {
    const adapter = getBackupAdapter(target.protocol);
    const found = await backupFileService.findBackup(target.sourceId, filename, { includeUnowned: caller.isAdmin });
    if (!found) throw new BackupNotFoundError();
    if (((found.row.protocol as BackupProtocol) ?? 'meshtastic') !== target.protocol) {
      throw new BackupProtocolMismatchError();
    }
    if (found.legacy && !opts.confirmLegacy) throw new LegacyConfirmRequiredError();
    const doc = adapter.parse(backupFileService.readRow(found.row));

    if (restoring.has(target.sourceId) || creating.has(target.sourceId)) throw new RestoreInProgressError();
    restoring.add(target.sourceId);
    try {
      const result = await adapter.restore(target.manager, doc, target.sourceId);
      audit(caller, 'device_backup_restored', {
        sourceId: target.sourceId,
        protocol: target.protocol,
        filename,
        legacy: found.legacy,
        applied: result.applied.length,
        failed: result.failed.length,
        skipped: result.skipped?.length ?? 0,
      });
      return result;
    } finally {
      restoring.delete(target.sourceId);
    }
  }
}

export const deviceConfigBackupService = new DeviceConfigBackupService();
