import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { backupFileService } from '../services/backupFileService.js';
import { systemBackupService } from '../services/systemBackupService.js';
import { logger } from '../../utils/logger.js';

/**
 * Config-backup endpoints (device config YAML backups).
 * Mounted at `/backup`.
 */
const backupRouter = Router();

// Get backup settings
backupRouter.get('/settings', requirePermission('configuration', 'read'), async (_req: Request, res: Response) => {
  try {
    const enabled = await databaseService.settings.getSetting('backup_enabled') === 'true';
    const maxBackups = parseInt(await databaseService.settings.getSetting('backup_maxBackups') || '7', 10);
    const backupTime = await databaseService.settings.getSetting('backup_time') || '02:00';

    res.json({
      enabled,
      maxBackups,
      backupTime,
    });
  } catch (error) {
    logger.error('❌ Error getting backup settings:', error);
    res.status(500).json({
      error: 'Failed to get backup settings',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Save backup settings
backupRouter.post('/settings', requirePermission('configuration', 'write'), async (req: Request, res: Response) => {
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
    await databaseService.settings.setSetting('backup_enabled', enabled.toString());
    await databaseService.settings.setSetting('backup_maxBackups', maxBackups.toString());
    await databaseService.settings.setSetting('backup_time', backupTime);

    logger.info(`⚙️  Backup settings updated: enabled=${enabled}, maxBackups=${maxBackups}, time=${backupTime}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error saving backup settings:', error);
    res.status(500).json({
      error: 'Failed to save backup settings',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// List all backups
backupRouter.get('/list', requirePermission('configuration', 'read'), async (_req: Request, res: Response) => {
  try {
    const backups = await backupFileService.listBackups();
    res.json(backups);
  } catch (error) {
    logger.error('❌ Error listing backups:', error);
    res.status(500).json({
      error: 'Failed to list backups',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Download a specific backup
backupRouter.get('/download/:filename', requirePermission('configuration', 'read'), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;

    // Validate filename to prevent directory traversal - only allow alphanumeric, hyphens, underscores, and .yaml extension
    if (!/^[a-zA-Z0-9\-_]+\.yaml$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename format' });
    }

    const content = await backupFileService.getBackup(filename);

    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);

    logger.info(`📥 Backup downloaded: ${filename}`);
  } catch (error) {
    logger.error('❌ Error downloading backup:', error);
    res.status(500).json({
      error: 'Failed to download backup',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Delete a specific backup
backupRouter.delete('/delete/:filename', requirePermission('configuration', 'write'), async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;

    // Validate filename to prevent directory traversal - only allow alphanumeric, hyphens, underscores, and .yaml extension
    if (!/^[a-zA-Z0-9\-_]+\.yaml$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename format' });
    }

    await backupFileService.deleteBackup(filename);

    logger.info(`🗑️  Backup deleted: ${filename}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error deleting backup:', error);
    res.status(500).json({
      error: 'Failed to delete backup',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * System-backup endpoints (full database export/import to JSON archives).
 * Mounted at `/system/backup`.
 */
const systemBackupRouter = Router();

// Create a system backup (exports all database tables to JSON)
systemBackupRouter.post('/', requirePermission('configuration', 'write'), async (req: Request, res: Response) => {
  try {
    logger.info('📦 System backup requested...');

    const dirname = await systemBackupService.createBackup('manual');

    // Audit log
    databaseService.auditLogAsync(
      req.user!.id,
      'system_backup_created',
      'system_backup',
      JSON.stringify({ dirname, type: 'manual' }),
      req.ip || null
    );

    logger.info(`✅ System backup created: ${dirname}`);

    res.json({
      success: true,
      dirname,
      message: 'System backup created successfully',
    });
  } catch (error) {
    logger.error('❌ Error creating system backup:', error);
    res.status(500).json({
      error: 'Failed to create system backup',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// List all system backups
systemBackupRouter.get('/list', requirePermission('configuration', 'read'), async (_req: Request, res: Response) => {
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

// Download a system backup as tar.gz
systemBackupRouter.get('/download/:dirname', requirePermission('configuration', 'read'), async (req: Request, res: Response) => {
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
    const fs = await import('fs');

    // Check if backup exists
    if (!fs.existsSync(backupPath)) {
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
      res.status(500).json({ error: 'Failed to create archive' });
    });

    // Audit log before streaming
    databaseService.auditLogAsync(
      req.user!.id,
      'system_backup_downloaded',
      'system_backup',
      JSON.stringify({ dirname }),
      req.ip || null
    );

    archive.pipe(res);
    archive.directory(backupPath, dirname);
    await archive.finalize();

    logger.info(`📥 System backup downloaded: ${dirname}`);
  } catch (error) {
    logger.error('❌ Error downloading system backup:', error);
    res.status(500).json({
      error: 'Failed to download system backup',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Delete a system backup
systemBackupRouter.delete('/delete/:dirname', requirePermission('configuration', 'write'), async (req: Request, res: Response) => {
  try {
    const { dirname } = req.params;

    // Validate dirname to prevent directory traversal
    if (!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(dirname)) {
      return res.status(400).json({ error: 'Invalid backup directory name format' });
    }

    await systemBackupService.deleteBackup(dirname);

    // Audit log
    databaseService.auditLogAsync(
      req.user!.id,
      'system_backup_deleted',
      'system_backup',
      JSON.stringify({ dirname }),
      req.ip || null
    );

    logger.info(`🗑️  System backup deleted: ${dirname}`);

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

    logger.info(`⚙️  System backup settings updated: enabled=${enabled}, maxBackups=${maxBackups}, time=${backupTime}`);

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
