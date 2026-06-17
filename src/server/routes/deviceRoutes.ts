/**
 * Device Routes
 *
 * GET  /device-config        — fetch the device configuration
 * GET  /device/backup        — export device config as YAML (optionally save to disk)
 * POST /device/reboot        — reboot the device
 * POST /device/purge-nodedb  — purge the device + local node database
 *
 * Extracted from server.ts. All handlers resolve the per-source manager via
 * resolveSourceManager and delegate to importable services, so the module has
 * no server.ts-local coupling.
 */

import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { deviceBackupService } from '../services/deviceBackupService.js';
import { backupFileService } from '../services/backupFileService.js';

const router: Router = Router();

router.get('/device-config', requirePermission('configuration', 'read'), async (req: Request, res: Response) => {
  try {
    const dcSourceId = req.query.sourceId as string | undefined;
    const dcManager = resolveSourceManager(dcSourceId);
    const config = await dcManager.getDeviceConfig();
    if (config) {
      res.json(config);
    } else {
      res.status(503).json({ error: 'Unable to retrieve device configuration' });
    }
  } catch (error) {
    logger.error('Error fetching device config:', error);
    res.status(500).json({ error: 'Failed to fetch device configuration' });
  }
});

// Export complete device configuration as YAML backup
// Compatible with Meshtastic CLI --export-config format
// Query param ?save=true will save to disk instead of just downloading
router.get('/device/backup', requirePermission('configuration', 'read'), async (req: Request, res: Response) => {
  try {
    const saveToFile = req.query.save === 'true';
    const backupSourceId = req.query.sourceId as string | undefined;
    const backupManager = resolveSourceManager(backupSourceId);
    logger.info(`📦 Device backup requested (save=${saveToFile})...`);

    // Generate YAML backup using the device backup service
    const yamlBackup = await deviceBackupService.generateBackup(backupManager);

    // Get node ID for filename
    const localNodeInfo = backupManager.getLocalNodeInfo();
    const nodeId = localNodeInfo?.nodeId || '!unknown';

    if (saveToFile) {
      // Save to disk with new filename format
      const filename = await backupFileService.saveBackup(yamlBackup, 'manual', nodeId);

      // Also send the file for download
      res.setHeader('Content-Type', 'application/x-yaml');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(yamlBackup);

      logger.info(`✅ Device backup saved and downloaded: ${filename}`);
    } else {
      // Just download, don't save - generate filename for display
      const nodeIdNumber = nodeId.startsWith('!') ? nodeId.substring(1) : nodeId;
      const now = new Date();
      const date = now.toISOString().split('T')[0];
      const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `${nodeIdNumber}-${date}-${time}.yaml`;

      res.setHeader('Content-Type', 'application/x-yaml');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(yamlBackup);

      logger.info(`✅ Device backup generated: ${filename}`);
    }
  } catch (error) {
    logger.error('❌ Error generating device backup:', error);
    res.status(500).json({
      error: 'Failed to generate device backup',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/device/reboot', requirePermission('configuration', 'write'), async (req: Request, res: Response) => {
  try {
    const { seconds: rebootSeconds, sourceId: rebootSourceId } = req.body || {};
    const seconds = rebootSeconds || 10;
    const rebootManager = resolveSourceManager(rebootSourceId);
    await rebootManager.rebootDevice(seconds);
    res.json({ success: true, message: `Device will reboot in ${seconds} seconds` });
  } catch (error) {
    logger.error('Error rebooting device:', error);
    res.status(500).json({ error: 'Failed to reboot device' });
  }
});

router.post('/device/purge-nodedb', requirePermission('configuration', 'write'), async (req: Request, res: Response) => {
  try {
    const { seconds: purgeSeconds, sourceId: purgeSourceId } = req.body || {};
    const seconds = purgeSeconds || 0;
    const purgeManager = resolveSourceManager(purgeSourceId);

    // Purge the device's node database
    await purgeManager.purgeNodeDb(seconds);

    // Also purge the local database (scoped to the source we just told the
    // device to wipe — purging globally on a per-source admin command would
    // wipe siblings)
    logger.info('🗑️ Purging local node database');
    await databaseService.purgeAllNodesAsync(purgeSourceId);
    logger.info('✅ Local node database purged successfully');

    res.json({
      success: true,
      message: `Node database purged (both device and local)${seconds > 0 ? ` in ${seconds} seconds` : ''}`,
    });
  } catch (error) {
    logger.error('Error purging node database:', error);
    res.status(500).json({ error: 'Failed to purge node database' });
  }
});

export default router;
