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
import { requireDeviceSourcePermission, getDeviceSourceTarget, getConfigCapableTarget } from '../utils/deviceSourcePermission.js';
import { fail } from '../utils/apiResponse.js';
import { deviceConfigBackupService, RestoreInProgressError } from '../services/deviceConfigBackupService.js';
import { backupTargetLimiter } from '../middleware/backupTargetLimiter.js';

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

// Export complete device configuration as YAML backup (Meshtastic CLI
// --export-config compatible; MeshCore Companion in its own YAML).
// Query param ?save=true will also keep the file on disk.
// The file holds secrets (PSKs, PINs), so it needs configuration:write.
router.get(
  '/device/backup',
  requireDeviceSourcePermission('configuration', 'write', 'query', 'device backups', { accept: 'config-capable' }),
  backupTargetLimiter,
  async (req: Request, res: Response) => {
    try {
      const saveToFile = req.query.save === 'true';
      const target = getConfigCapableTarget(req);
      const backupTarget = { sourceId: target.sourceId, protocol: target.protocol, manager: target.manager };
      logger.debug(`Device backup requested (save=${saveToFile}, protocol=${target.protocol})...`);

      const { filename, content } = saveToFile
        ? await deviceConfigBackupService.create(backupTarget, 'manual', {
            userId: req.user?.id ?? null,
            ip: req.ip || null,
          })
        : await deviceConfigBackupService.generateOnly(backupTarget);

      res.setHeader('Content-Type', 'application/x-yaml');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
      logger.debug(`Device backup ${saveToFile ? 'saved and downloaded' : 'generated'}: ${filename}`);
    } catch (error) {
      if (error instanceof RestoreInProgressError) {
        return fail(res, 409, 'RESTORE_IN_PROGRESS', error.message);
      }
      logger.error('Error generating device backup:', error instanceof Error ? error.message : String(error));
      return fail(res, 500, 'DEVICE_BACKUP_FAILED', 'Failed to generate device backup');
    }
  },
);

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
