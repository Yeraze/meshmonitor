/**
 * Firmware Update Routes
 *
 * REST API routes for OTA firmware update management.
 * All routes require admin authentication.
 */

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import { firmwareUpdateService } from '../services/firmwareUpdateService.js';
import { logger } from '../../utils/logger.js';
import path from 'path';

const router = Router();

// All firmware routes require admin access
router.use(requireAdmin());

/**
 * GET /api/firmware/status
 * Returns current update status, channel, customUrl, and lastChecked timestamp
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = firmwareUpdateService.getStatus();
    const channel = await firmwareUpdateService.getChannel();
    const customUrl = await firmwareUpdateService.getCustomUrl();
    const lastChecked = firmwareUpdateService.getLastFetchTime();

    return res.json({ success: true, status, channel, customUrl, lastChecked });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error getting status:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * GET /api/firmware/releases
 * Returns cached releases filtered by current channel
 */
router.get('/releases', async (_req: Request, res: Response) => {
  try {
    const channel = await firmwareUpdateService.getChannel();
    const allReleases = firmwareUpdateService.getCachedReleases();
    const releases = firmwareUpdateService.filterByChannel(allReleases, channel);

    return res.json({ success: true, releases, channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error getting releases:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/firmware/check
 * Force a release check and return updated releases
 */
router.post('/check', async (_req: Request, res: Response) => {
  try {
    const allReleases = await firmwareUpdateService.fetchReleases();
    const channel = await firmwareUpdateService.getChannel();
    const releases = firmwareUpdateService.filterByChannel(allReleases, channel);

    return res.json({ success: true, releases, channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error checking releases:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/firmware/channel
 * Set release channel. Body: { channel: 'stable'|'alpha'|'custom', customUrl?: string }
 */
router.post('/channel', async (req: Request, res: Response) => {
  try {
    const { channel, customUrl } = req.body;

    if (!channel || !['stable', 'alpha', 'custom'].includes(channel)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid channel. Must be one of: stable, alpha, custom',
      });
    }

    if (channel === 'custom' && !customUrl) {
      return res.status(400).json({
        success: false,
        error: 'customUrl is required when channel is "custom"',
      });
    }

    await firmwareUpdateService.setChannel(channel);

    if (channel === 'custom' && customUrl) {
      await firmwareUpdateService.setCustomUrl(customUrl);
    }

    logger.info(`[FirmwareRoutes] Channel set to "${channel}"${customUrl ? ` with URL: ${customUrl}` : ''}`);
    return res.json({ success: true, channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error setting channel:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/firmware/update
 * Start preflight check. Body: { targetVersion, gatewayIp, hwModel, currentVersion }
 */
router.post('/update', async (req: Request, res: Response) => {
  try {
    const { targetVersion, gatewayIp, hwModel, currentVersion } = req.body;

    if (!targetVersion || !gatewayIp || hwModel === undefined || !currentVersion) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: targetVersion, gatewayIp, hwModel, currentVersion',
      });
    }

    // Find the target release in cached releases
    const releases = firmwareUpdateService.getCachedReleases();
    const targetRelease = releases.find((r) => r.version === targetVersion || r.tagName === `v${targetVersion}`);

    if (!targetRelease) {
      return res.status(400).json({
        success: false,
        error: `Release version "${targetVersion}" not found in cached releases. Try checking for updates first.`,
      });
    }

    firmwareUpdateService.startPreflight({
      currentVersion,
      targetVersion,
      targetRelease,
      gatewayIp,
      hwModel: Number(hwModel),
    });

    const status = firmwareUpdateService.getStatus();
    return res.json({ success: true, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error starting preflight:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/firmware/update/confirm
 * Confirm the current wizard step and advance to the next one.
 * Body: { gatewayIp, nodeId }
 */
router.post('/update/confirm', async (req: Request, res: Response) => {
  try {
    const { gatewayIp, nodeId } = req.body;
    const status = firmwareUpdateService.getStatus();

    if (status.state !== 'awaiting-confirm' || !status.step) {
      return res.status(400).json({
        success: false,
        error: 'No update step is awaiting confirmation',
      });
    }

    switch (status.step) {
      case 'preflight': {
        // Advance to backup step
        if (!gatewayIp || !nodeId) {
          return res.status(400).json({
            success: false,
            error: 'gatewayIp and nodeId are required to confirm preflight',
          });
        }
        await firmwareUpdateService.executeBackup(gatewayIp, nodeId);
        break;
      }

      case 'backup': {
        // Auto-advance through download → extract (non-destructive steps)
        if (!status.downloadUrl) {
          return res.status(400).json({
            success: false,
            error: 'No download URL available. Preflight may not have completed.',
          });
        }
        if (!status.preflightInfo) {
          return res.status(500).json({
            success: false,
            error: 'Preflight info not available.',
          });
        }

        // Download
        await firmwareUpdateService.executeDownload(status.downloadUrl);

        // Extract immediately after download (no user prompt needed)
        const tempDir = firmwareUpdateService.getTempDir();
        if (!tempDir) {
          return res.status(500).json({
            success: false,
            error: 'Temp directory not available. Download may have failed.',
          });
        }
        const zipPath = path.join(tempDir, 'firmware.zip');
        await firmwareUpdateService.executeExtract(
          zipPath,
          status.preflightInfo.boardName,
          status.preflightInfo.targetVersion
        );
        break;
      }

      case 'extract': {
        // Advance to flash step - firmware path is tempDir/extracted/matchedFile
        const extractTempDir = firmwareUpdateService.getTempDir();
        if (!extractTempDir || !status.matchedFile) {
          return res.status(500).json({
            success: false,
            error: 'Firmware binary path not available. Extract may have failed.',
          });
        }
        if (!status.preflightInfo) {
          return res.status(500).json({
            success: false,
            error: 'Preflight info not available.',
          });
        }
        const firmwarePath = path.join(extractTempDir, 'extracted', status.matchedFile);
        await firmwareUpdateService.executeFlash(status.preflightInfo.gatewayIp, firmwarePath);
        break;
      }

      case 'flash': {
        // After flash, move to verify step (waiting for reconnect)
        firmwareUpdateService.verifyUpdate(
          status.targetVersion ?? '',
          status.preflightInfo?.targetVersion ?? ''
        );
        break;
      }

      default:
        return res.status(400).json({
          success: false,
          error: `Unknown step: ${status.step}`,
        });
    }

    const updatedStatus = firmwareUpdateService.getStatus();
    return res.json({ success: true, status: updatedStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error confirming step:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/firmware/update/cancel
 * Cancel an in-progress update
 */
router.post('/update/cancel', (_req: Request, res: Response) => {
  try {
    firmwareUpdateService.cancelUpdate();
    return res.json({ success: true, message: 'Update cancelled' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error cancelling update:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * GET /api/firmware/backups
 * List config backups
 */
router.get('/backups', (_req: Request, res: Response) => {
  try {
    const backups = firmwareUpdateService.listBackups();
    return res.json({ success: true, backups });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error listing backups:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/firmware/restore
 * Restore a config backup. Body: { gatewayIp, backupPath }
 */
router.post('/restore', async (req: Request, res: Response) => {
  try {
    const { gatewayIp, backupPath } = req.body;

    if (!gatewayIp || !backupPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: gatewayIp, backupPath',
      });
    }

    await firmwareUpdateService.restoreBackup(gatewayIp, backupPath);
    return res.json({ success: true, message: 'Config restored successfully' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error restoring backup:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;
