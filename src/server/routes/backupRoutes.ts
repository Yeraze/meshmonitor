import { Router, Request, Response } from 'express';
import { promises as fsp } from 'fs';
import { requireAdmin, requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { BackupNotFoundError } from '../services/backupFileService.js';
import {
  deviceConfigBackupService,
  BackupProtocolMismatchError,
  RestoreInProgressError,
  LegacyConfirmRequiredError,
  type CallerInfo,
} from '../services/deviceConfigBackupService.js';
import { backupSchedulerService } from '../services/backupSchedulerService.js';
import { backupTargetLimiter } from '../middleware/backupTargetLimiter.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { systemBackupService, SystemBackupInProgressError } from '../services/systemBackupService.js';
import { requireDeviceSourcePermission, getStoredBackupTarget, getConfigCapableTarget } from '../utils/deviceSourcePermission.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { extendRequestTimeout } from '../middleware/requestTimeout.js';

/** System backup: streams every table to disk. Minutes on a large database. */
const SYSTEM_BACKUP_TIMEOUT_MS = 15 * 60_000;

/** Device config restore: the slowest adapter bounds it (MeshCore pushes many serial writes). */
const DEVICE_RESTORE_TIMEOUT_MS = 120_000;

/**
 * Config-backup endpoints (device config YAML backups).
 * Mounted at `/backup`.
 */
const backupRouter = Router();

const FILENAME_RE = /^[a-zA-Z0-9\-_]+\.yaml$/;

/** Map pipeline errors to the response. Unknown errors are 500 with no detail. */
function failBackup(res: Response, error: unknown, code: string, message: string): void {
  if (error instanceof BackupNotFoundError) {
    fail(res, 404, 'BACKUP_NOT_FOUND', 'Backup not found');
  } else if (error instanceof BackupProtocolMismatchError) {
    fail(res, 409, 'BACKUP_PROTOCOL_MISMATCH', error.message);
  } else if (error instanceof RestoreInProgressError) {
    fail(res, 409, 'RESTORE_IN_PROGRESS', error.message);
  } else if (error instanceof LegacyConfirmRequiredError) {
    fail(res, 409, 'LEGACY_CONFIRM_REQUIRED', error.message);
  } else {
    logger.error(`${message}:`, error instanceof Error ? error.message : String(error));
    fail(res, 500, code, message);
  }
}

const callerOf = (req: Request): CallerInfo => ({
  isAdmin: Boolean(req.user?.isAdmin),
  userId: req.user?.id ?? null,
  ip: req.ip || null,
});

// Per-source schedule. The day guard and last-result fields are additive.
backupRouter.get('/settings', requireDeviceSourcePermission('configuration', 'read', 'query', 'device backups', { accept: 'stored' }), async (req: Request, res: Response) => {
  try {
    const { sourceId } = getStoredBackupTarget(req);
    const settings = await backupSchedulerService.readSettings(sourceId);
    res.json({
      enabled: settings.enabled,
      maxBackups: settings.maxBackups,
      backupTime: settings.backupTime,
      lastAutomaticBackupDate: settings.lastAutomaticBackupDate,
      lastAutomaticBackupAt: settings.lastAutomaticBackupAt,
      lastAutomaticBackupError: settings.lastAutomaticBackupError,
    });
  } catch (error) {
    failBackup(res, error, 'BACKUP_SETTINGS_FAILED', 'Failed to get backup settings');
  }
});

backupRouter.post('/settings', requireDeviceSourcePermission('configuration', 'write', 'body', 'device backups', { accept: 'stored' }), async (req: Request, res: Response) => {
  try {
    const { sourceId } = getStoredBackupTarget(req);
    const { enabled, maxBackups, backupTime } = req.body ?? {};

    if (typeof enabled !== 'boolean') {
      return fail(res, 400, 'INVALID_ENABLED', 'Invalid enabled value');
    }
    if (typeof maxBackups !== 'number' || maxBackups < 1 || maxBackups > 365) {
      return fail(res, 400, 'INVALID_MAX_BACKUPS', 'Invalid maxBackups value (must be 1-365)');
    }
    if (!backupTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(backupTime)) {
      return fail(res, 400, 'INVALID_BACKUP_TIME', 'Invalid backupTime format (must be HH:MM)');
    }

    await backupSchedulerService.applySettings(sourceId, { enabled, maxBackups, backupTime });
    logger.debug(`Backup settings updated for source ${sourceId}: enabled=${enabled}, maxBackups=${maxBackups}, time=${backupTime}`);
    return ok(res);
  } catch (error) {
    return failBackup(res, error, 'BACKUP_SETTINGS_FAILED', 'Failed to save backup settings');
  }
});

// List a source's backups (metadata only). Admins also see unowned legacy rows
// of the same protocol, flagged `legacy`.
backupRouter.get('/list', requireDeviceSourcePermission('configuration', 'read', 'query', 'device backups', { accept: 'stored' }), async (req: Request, res: Response) => {
  try {
    const { sourceId, protocol } = getStoredBackupTarget(req);
    const backups = await deviceConfigBackupService.list(sourceId, protocol, callerOf(req));
    res.json(backups);
  } catch (error) {
    failBackup(res, error, 'BACKUP_LIST_FAILED', 'Failed to list backups');
  }
});

// No-secret summary for the restore confirm dialog.
backupRouter.get('/summary/:filename', requireDeviceSourcePermission('configuration', 'read', 'query', 'device backups', { accept: 'stored' }), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    if (!FILENAME_RE.test(filename)) {
      return fail(res, 400, 'INVALID_FILENAME', 'Invalid filename format');
    }
    const { sourceId, protocol } = getStoredBackupTarget(req);
    // For the current-vs-backup comparison the MeshCore adapter reads the live
    // manager when one is registered; a disconnected source just gets the file side.
    const manager = sourceManagerRegistry.getManager(sourceId);
    const summary = await deviceConfigBackupService.summarize(sourceId, protocol, filename, callerOf(req), manager);
    return ok(res, summary);
  } catch (error) {
    return failBackup(res, error, 'BACKUP_SUMMARY_FAILED', 'Failed to summarize backup');
  }
});

// Download a specific backup. A file holds secrets (PSKs, PINs), so it needs
// `configuration:write` on its own source, like the PSK display rule.
backupRouter.get('/download/:filename', requireDeviceSourcePermission('configuration', 'write', 'query', 'device backups', { accept: 'stored' }), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;

    // Validate filename to prevent directory traversal - only allow alphanumeric, hyphens, underscores, and .yaml extension
    if (!FILENAME_RE.test(filename)) {
      return fail(res, 400, 'INVALID_FILENAME', 'Invalid filename format');
    }

    const { sourceId } = getStoredBackupTarget(req);
    const content = await deviceConfigBackupService.get(sourceId, filename, callerOf(req));

    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return void res.send(content);
  } catch (error) {
    return failBackup(res, error, 'BACKUP_DOWNLOAD_FAILED', 'Failed to download backup');
  }
});

// Delete a specific backup, inside the target source only.
backupRouter.delete('/delete/:filename', requireDeviceSourcePermission('configuration', 'write', 'query', 'device backups', { accept: 'stored' }), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;

    if (!FILENAME_RE.test(filename)) {
      return fail(res, 400, 'INVALID_FILENAME', 'Invalid filename format');
    }

    const { sourceId } = getStoredBackupTarget(req);
    await deviceConfigBackupService.delete(sourceId, filename, callerOf(req));
    return ok(res);
  } catch (error) {
    return failBackup(res, error, 'BACKUP_DELETE_FAILED', 'Failed to delete backup');
  }
});

// Restore a saved backup to the connected local device (#4926, #6285).
// Overwrites current device config, so the frontend confirms before calling this.
// The file must belong to the target source (admins may also use an unowned
// legacy file of the same protocol after `confirmLegacy: true`).
backupRouter.post(
  '/restore/:filename',
  extendRequestTimeout(DEVICE_RESTORE_TIMEOUT_MS),
  requireDeviceSourcePermission('configuration', 'write', 'body', 'device backups', { accept: 'config-capable' }),
  backupTargetLimiter,
  async (req: Request, res: Response) => {
    try {
      const { filename } = req.params;

      // Same directory-traversal guard as download/delete.
      if (!FILENAME_RE.test(filename)) {
        return fail(res, 400, 'INVALID_FILENAME', 'Invalid filename format');
      }

      const target = getConfigCapableTarget(req);
      const result = await deviceConfigBackupService.restore(
        { sourceId: target.sourceId, protocol: target.protocol, manager: target.manager },
        filename,
        callerOf(req),
        { confirmLegacy: req.body?.confirmLegacy === true },
      );

      logger.debug(`Backup restored: ${filename} (${result.applied.length} applied, ${result.failed.length} failed)`);
      return ok(res, result);
    } catch (error) {
      // Not-connected / transaction failures are operational, not server bugs.
      if (error instanceof Error && /not connected|transaction/i.test(error.message)
        && !(error instanceof BackupNotFoundError)) {
        return fail(res, 409, 'RESTORE_FAILED', error.message);
      }
      return failBackup(res, error, 'RESTORE_FAILED', 'Failed to restore backup');
    }
  },
);

/**
 * System-backup endpoints (full database export/import to JSON archives).
 * Mounted at `/system/backup`.
 */
const systemBackupRouter = Router();

// Create a system backup (exports all database tables to JSON).
// The export streams every table to disk; a database with millions of rows
// takes minutes, so the request outlives the default 30 s socket timeout.
// Admin only. A system backup is the whole database across every source —
// password hashes, API token hashes, channel decryption keys in the clear, and
// the encrypted PKI/Observer keys. `configuration:write` can be granted to a
// non-admin on a single source, and a single-source grant must not trigger a
// full cross-source export (#6053). Matches the download gate below.
systemBackupRouter.post('/', extendRequestTimeout(SYSTEM_BACKUP_TIMEOUT_MS), requireAdmin(), async (req: Request, res: Response) => {
  try {
    logger.debug('📦 System backup requested...');

    const dirname = await systemBackupService.createBackup('manual');

    // Audit log
    void databaseService.auditLogAsync(
      req.user!.id,
      'system_backup_created',
      'system_backup',
      JSON.stringify({ dirname, type: 'manual' }),
      req.ip || null
    );

    logger.debug(`✅ System backup created: ${dirname}`);

    res.json({
      success: true,
      dirname,
      message: 'System backup created successfully',
    });
  } catch (error) {
    if (error instanceof SystemBackupInProgressError) {
      return fail(res, 409, 'BACKUP_IN_PROGRESS', error.message);
    }
    logger.error('❌ Error creating system backup:', error);
    // `details` is kept beside the envelope: the settings page reads it.
    return fail(res, 500, 'BACKUP_FAILED', 'Failed to create system backup', {
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// List all system backups. Admin only: the listing exposes server-internal
// dirnames/sizes for full cross-source archives, and a single-source
// `configuration:write/read` grant must not enumerate them (#6067).
systemBackupRouter.get('/list', requireAdmin(), async (_req: Request, res: Response) => {
  try {
    const backups = await systemBackupService.listBackups();
    res.json(backups);
  } catch (error) {
    logger.error('❌ Error listing system backups:', error);
    res.status(500).json({
      error: 'Failed to list system backups',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Download a system backup as tar.gz.
// Admin only. The archive is the whole database: password hashes, API token
// hashes, channel decryption keys in the clear, and the encrypted PKI and
// Observer keys. `configuration:read` can be granted to a non-admin (and to the
// anonymous user), and no single permission should carry all of that out of
// the install.
systemBackupRouter.get('/download/:dirname', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { dirname } = req.params;

    // Validate dirname to prevent directory traversal - only allow date format YYYY-MM-DD_HHMMSS
    if (!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(dirname)) {
      return res.status(400).json({ error: 'Invalid backup directory name format' });
    }

    const backupPath = systemBackupService.getBackupPath(dirname);
    // archiver v8 exposes only named class exports; @types/archiver still ships v7 types.
    const { TarArchive } = (await import('archiver')) as unknown as {
      TarArchive: new (opts: import('archiver').ArchiverOptions) => import('archiver').Archiver;
    };
    // Check the backup exists — async so we don't block the event loop with
    // synchronous fs in the request path (#3524).
    try {
      await fsp.access(backupPath);
    } catch {
      return res.status(404).json({ error: 'Backup not found' });
    }

    // Create tar.gz archive on-the-fly
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${dirname}.tar.gz"`);

    const archive = new TarArchive({
      gzip: true,
      gzipOptions: { level: 9 },
    });

    archive.on('error', err => {
      logger.error('❌ Error creating archive:', err);
      // The archive can error mid-stream — after archive.pipe(res) has already
      // sent headers — so guard against "Cannot set headers after they are
      // sent" (#3524). If we're already streaming, just terminate the response.
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      } else {
        res.end();
      }
    });

    // Audit log before streaming
    void databaseService.auditLogAsync(
      req.user!.id,
      'system_backup_downloaded',
      'system_backup',
      JSON.stringify({ dirname }),
      req.ip || null
    );

    archive.pipe(res);
    archive.directory(backupPath, dirname);
    await archive.finalize();

    logger.debug(`📥 System backup downloaded: ${dirname}`);
  } catch (error) {
    logger.error('❌ Error downloading system backup:', error);
    // finalize() can throw after streaming began (headers sent) — same guard.
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to download system backup',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    } else {
      res.end();
    }
  }
});

// Delete a system backup. Admin only: deleting cross-source archives is a
// disaster-recovery concern, and a single-source grant must not control them
// (#6067).
systemBackupRouter.delete('/delete/:dirname', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { dirname } = req.params;

    // Validate dirname to prevent directory traversal
    if (!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(dirname)) {
      return res.status(400).json({ error: 'Invalid backup directory name format' });
    }

    await systemBackupService.deleteBackup(dirname);

    // Audit log
    void databaseService.auditLogAsync(
      req.user!.id,
      'system_backup_deleted',
      'system_backup',
      JSON.stringify({ dirname }),
      req.ip || null
    );

    logger.debug(`🗑️  System backup deleted: ${dirname}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error deleting system backup:', error);
    res.status(500).json({
      error: 'Failed to delete system backup',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get system backup settings
systemBackupRouter.get('/settings', requirePermission('configuration', 'read'), async (_req: Request, res: Response) => {
  try {
    const enabled = await databaseService.settings.getSetting('system_backup_enabled') === 'true';
    const maxBackups = parseInt(await databaseService.settings.getSetting('system_backup_maxBackups') || '7', 10);
    const backupTime = await databaseService.settings.getSetting('system_backup_time') || '03:00';

    res.json({
      enabled,
      maxBackups,
      backupTime,
    });
  } catch (error) {
    logger.error('❌ Error getting system backup settings:', error);
    res.status(500).json({
      error: 'Failed to get system backup settings',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Save system backup settings
systemBackupRouter.post('/settings', requirePermission('configuration', 'write'), async (req: Request, res: Response) => {
  try {
    const { enabled, maxBackups, backupTime } = req.body;

    // Validate inputs
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value' });
    }

    if (typeof maxBackups !== 'number' || maxBackups < 1 || maxBackups > 365) {
      return res.status(400).json({ error: 'Invalid maxBackups value (must be 1-365)' });
    }

    if (!backupTime || !/^\d{2}:\d{2}$/.test(backupTime)) {
      return res.status(400).json({ error: 'Invalid backupTime format (must be HH:MM)' });
    }

    // Save settings
    await databaseService.settings.setSetting('system_backup_enabled', enabled.toString());
    await databaseService.settings.setSetting('system_backup_maxBackups', maxBackups.toString());
    await databaseService.settings.setSetting('system_backup_time', backupTime);

    logger.debug(`⚙️  System backup settings updated: enabled=${enabled}, maxBackups=${maxBackups}, time=${backupTime}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error saving system backup settings:', error);
    res.status(500).json({
      error: 'Failed to save system backup settings',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export { backupRouter, systemBackupRouter };
