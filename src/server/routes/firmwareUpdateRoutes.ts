/**
 * Firmware Update Routes
 *
 * REST API routes for OTA firmware update management.
 * All routes require admin authentication.
 */

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import { firmwareUpdateService } from '../services/firmwareUpdateService.js';
import { getEnvironmentConfig } from '../config/environment.js';
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

    // Issue #2981: refuse to start the wizard when the resolved gateway is the
    // env default *and* MESHTASTIC_NODE_IP was not explicitly provided. This
    // is the fallback that used to silently target 192.168.1.100 for non-TCP
    // or unconfigured sources. We surface it as an explicit error instead.
    const env = getEnvironmentConfig();
    if (!env.meshtasticNodeIpProvided && gatewayIp === env.meshtasticNodeIp) {
      return res.status(400).json({
        success: false,
        error:
          'No node IP configured for this source. OTA firmware update requires ' +
          'a TCP source with a host configured, or MESHTASTIC_NODE_IP explicitly set.',
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

    // Reject double-submits while a step is mid-flight. Without this the user
    // can re-click Confirm during a slow backup and trigger a parallel run.
    if (firmwareUpdateService.isStepRunning()) {
      return res.status(409).json({
        success: false,
        error: 'A firmware update step is already running',
      });
    }

    // Long-running steps are kicked off async and the HTTP response returns
    // immediately. The frontend tracks progress via Socket.IO `firmware:status`
    // events on every updateStatus() call — it never relied on this response
    // body for anything other than current state. Synchronous awaits here
    // routinely tripped reverse-proxy idle timeouts (60–100s) on slow
    // backups, leaving the wizard convinced the step hung while the server
    // kept running.
    switch (status.step) {
      case 'preflight': {
        // Advance to backup step
        if (!gatewayIp || !nodeId) {
          return res.status(400).json({
            success: false,
            error: 'gatewayIp and nodeId are required to confirm preflight',
          });
        }
        // Safety rail 5: refuse OTA on a device flagged half-flashed.
        // Operators must clear the marker (typically after a USB-tethered
        // recovery) before another OTA attempt.
        if (firmwareUpdateService.hasFlashIncompleteMarker(nodeId)) {
          return res.status(409).json({
            success: false,
            error:
              `Node "${nodeId}" is flagged as half-flashed from a previous OTA attempt. ` +
              `Recover via USB, then DELETE /api/firmware/recovery-marker/${encodeURIComponent(nodeId)} to clear the flag.`,
          });
        }
        // Visibly disconnect from node before backup — stays disconnected through entire flash
        void (async () => {
          try {
            await firmwareUpdateService.disconnectFromNode();
            await firmwareUpdateService.executeBackup(gatewayIp, nodeId);
          } catch (err) {
            logger.error('[FirmwareRoutes] Backup step failed:', err);
          }
        })();
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

        const downloadUrl = status.downloadUrl;
        const preflightInfo = status.preflightInfo;
        void (async () => {
          try {
            await firmwareUpdateService.executeDownload(downloadUrl);
            const tempDir = firmwareUpdateService.getTempDir();
            if (!tempDir) {
              logger.error('[FirmwareRoutes] Temp directory missing after download');
              return;
            }
            const zipPath = path.join(tempDir, 'firmware.zip');
            await firmwareUpdateService.executeExtract(
              zipPath,
              preflightInfo.boardName,
              preflightInfo.targetVersion
            );
          } catch (err) {
            logger.error('[FirmwareRoutes] Download/extract step failed:', err);
          }
        })();
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
        const gatewayForFlash = status.preflightInfo.gatewayIp;
        void (async () => {
          try {
            await firmwareUpdateService.executeFlash(gatewayForFlash, firmwarePath);
          } catch (err) {
            logger.error('[FirmwareRoutes] Flash step failed:', err);
          }
        })();
        break;
      }

      case 'flash': {
        // Read the firmware version the device is actually running now —
        // not the target. Otherwise verifyUpdate is comparing target against
        // target and trivially "succeeds" regardless of what flashed.
        // Wait for MyNodeInfo to arrive after the post-flash reconnect; the
        // TCP connect event fires before the node sends its metadata, and
        // getLocalNodeInfo() can also return the pre-flash cached version
        // until MyNodeInfo is re-emitted.
        const preFlashVersion = status.preflightInfo?.currentVersion ?? '';
        const verifyGatewayIp = status.preflightInfo?.gatewayIp;
        firmwareUpdateService.markVerifyInProgress();
        void (async () => {
          try {
            const actualVersion = await firmwareUpdateService.waitForFirmwareVersion({
              staleVersion: preFlashVersion,
              gatewayIp: verifyGatewayIp,
            });
            firmwareUpdateService.verifyUpdate(
              actualVersion,
              status.targetVersion ?? ''
            );
          } catch (err) {
            logger.error('[FirmwareRoutes] Verify step failed:', err);
          }
        })();
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
router.post('/update/cancel', async (_req: Request, res: Response) => {
  try {
    await firmwareUpdateService.cancelUpdate();
    return res.json({ success: true, message: 'Update cancelled' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error cancelling update:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/firmware/update/done
 * Complete a successful update: reset state, force full disconnect→reconnect
 * so all node data is re-downloaded with the new firmware version.
 */
router.post('/update/done', async (_req: Request, res: Response) => {
  try {
    await firmwareUpdateService.completeUpdate();
    return res.json({ success: true, message: 'Update completed, reconnecting to node' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error completing update:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/firmware/update/retry
 * Retry a failed flash step — directly re-executes the flash with existing firmware
 */
router.post('/update/retry', async (_req: Request, res: Response) => {
  try {
    firmwareUpdateService.retryFlash();
    const status = firmwareUpdateService.getStatus();

    // Immediately execute the flash (don't wait for another confirm round-trip)
    const tempDir = firmwareUpdateService.getTempDir();
    if (!tempDir || !status.matchedFile || !status.preflightInfo) {
      return res.status(500).json({
        success: false,
        error: 'Firmware files or preflight info not available. Please start a new update.',
      });
    }
    const firmwarePath = path.join(tempDir, 'extracted', status.matchedFile);
    // Fire-and-forget: flash runs async, frontend tracks via Socket.IO status events
    firmwareUpdateService.executeFlash(status.preflightInfo.gatewayIp, firmwarePath).catch((err) => {
      logger.error('[FirmwareRoutes] Retry flash failed:', err);
    });

    return res.json({ success: true, status: firmwareUpdateService.getStatus() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error retrying flash:', error);
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

/**
 * DELETE /api/firmware/recovery-marker/:nodeId
 * Clear the half-flashed marker for a node. Should only be called after
 * a USB-tethered recovery has been performed.
 */
router.delete('/recovery-marker/:nodeId', (req: Request, res: Response) => {
  try {
    const nodeId = req.params.nodeId;
    if (!nodeId) {
      return res.status(400).json({ success: false, error: 'nodeId is required' });
    }
    const removed = firmwareUpdateService.clearFlashIncompleteMarker(nodeId);
    logger.info(`[FirmwareRoutes] Cleared ${removed} half-flash marker(s) for node ${nodeId}`);
    return res.json({ success: true, removed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error clearing recovery marker:', error);
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;
