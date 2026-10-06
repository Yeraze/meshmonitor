/**
 * Device Routes
 *
 * GET  /device-config        — fetch the device configuration
 * GET  /device/backup        — export device config as YAML (optionally save to disk)
 * POST /device/reboot        — reboot the device
 * POST /device/purge-nodedb  — purge the device + local node database
 *
 * Extracted from server.ts. Every route is gated by
 * requireDeviceSourcePermission(): it resolves the target source once (the
 * request's sourceId, or the primary Meshtastic source when omitted), checks
 * `configuration` on that source, and the handler takes the same manager from
 * getDeviceSourceTarget(). deviceSourcePermission.scope.test.ts fails on a
 * route added without it.
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireDeviceSourcePermission, getDeviceSourceTarget } from '../utils/deviceSourcePermission.js';
import { fail } from '../utils/apiResponse.js';
import { deviceBackupService } from '../services/deviceBackupService.js';
import { backupFileService } from '../services/backupFileService.js';

const router: Router = Router();

router.get('/device-config', requireDeviceSourcePermission('configuration', 'read', 'query'), async (req: Request, res: Response) => {
  try {
    const { manager: dcManager } = getDeviceSourceTarget(req);
    const config = await dcManager.getDeviceConfig();
    if (config) {
      res.json(config);
    } else {
      fail(res, 503, 'DEVICE_CONFIG_UNAVAILABLE', 'Unable to retrieve device configuration');
    }
  } catch (error) {
    logger.error('Error fetching device config:', error);
    fail(res, 500, 'DEVICE_CONFIG_FAILED', 'Failed to fetch device configuration');
  }
});

// Export complete device configuration as YAML backup
// Compatible with Meshtastic CLI --export-config format
// Query param ?save=true will save to disk instead of just downloading
router.get('/device/backup', requireDeviceSourcePermission('configuration', 'read', 'query'), async (req: Request, res: Response) => {
  try {
    const saveToFile = req.query.save === 'true';
    const { manager: backupManager } = getDeviceSourceTarget(req);
    logger.debug(`📦 Device backup requested (save=${saveToFile})...`);

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

      logger.debug(`✅ Device backup saved and downloaded: ${filename}`);
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

      logger.debug(`✅ Device backup generated: ${filename}`);
    }
  } catch (error) {
    logger.error('❌ Error generating device backup:', error);
    fail(res, 500, 'DEVICE_BACKUP_FAILED', 'Failed to generate device backup', {
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/device/reboot', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req: Request, res: Response) => {
  try {
    const { seconds: rebootSeconds } = req.body || {};
    const seconds = rebootSeconds || 10;
    const { manager: rebootManager } = getDeviceSourceTarget(req);
    await rebootManager.rebootDevice(seconds);
    res.json({ success: true, message: `Device will reboot in ${seconds} seconds` });
  } catch (error) {
    logger.error('Error rebooting device:', error);
    fail(res, 500, 'DEVICE_REBOOT_FAILED', 'Failed to reboot device');
  }
});

router.post('/device/purge-nodedb', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req: Request, res: Response) => {
  try {
    const { seconds: purgeSeconds } = req.body || {};
    const seconds = purgeSeconds || 0;
    // The local purge below uses the SAME source the permission was checked
    // on and the device purge went to. It is never undefined: an undefined
    // sourceId makes purgeAllNodesAsync wipe every source's rows.
    const { manager: purgeManager, sourceId: purgeSourceId } = getDeviceSourceTarget(req);

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
    fail(res, 500, 'NODEDB_PURGE_FAILED', 'Failed to purge node database');
  }
});

export default router;
