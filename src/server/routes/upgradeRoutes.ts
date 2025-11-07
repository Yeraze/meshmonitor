/**
 * Upgrade Routes
 *
 * Routes for managing automatic Docker upgrades
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/authMiddleware.js';
import { upgradeService } from '../services/upgradeService.js';
import { logger } from '../../utils/logger.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/upgrade/status
 * Check if upgrade functionality is enabled
 */
router.get('/status', (req: Request, res: Response) => {
  try {
    return res.json({
      enabled: upgradeService.isEnabled(),
      deploymentMethod: upgradeService.getDeploymentMethod(),
      currentVersion: packageJson.version
    });
  } catch (error) {
    logger.error('Error checking upgrade status:', error);
    return res.status(500).json({ error: 'Failed to check upgrade status' });
  }
});

/**
 * POST /api/upgrade/trigger
 * Trigger an upgrade
 */
router.post('/trigger', async (req: Request, res: Response) => {
  try {
    const { targetVersion, force, backup } = req.body;
    const userId = req.user?.id || 'unknown';

    logger.info(`Upgrade requested by user ${userId}: ${packageJson.version} → ${targetVersion || 'latest'}`);

    const result = await upgradeService.triggerUpgrade(
      {
        targetVersion,
        force: force === true,
        backup: backup !== false // Default to true
      },
      packageJson.version,
      userId.toString()
    );

    if (result.success) {
      return res.json({
        success: true,
        upgradeId: result.upgradeId,
        currentVersion: packageJson.version,
        targetVersion: targetVersion || 'latest',
        message: result.message
      });
    } else {
      return res.status(400).json({
        success: false,
        message: result.message,
        issues: result.issues
      });
    }
  } catch (error) {
    logger.error('Error triggering upgrade:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to trigger upgrade',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/upgrade/status/:upgradeId
 * Get status of a specific upgrade
 */
router.get('/status/:upgradeId', async (req: Request, res: Response) => {
  try {
    const { upgradeId } = req.params;

    const status = await upgradeService.getUpgradeStatus(upgradeId);

    if (!status) {
      return res.status(404).json({ error: 'Upgrade not found' });
    }

    return res.json(status);
  } catch (error) {
    logger.error('Error getting upgrade status:', error);
    return res.status(500).json({ error: 'Failed to get upgrade status' });
  }
});

/**
 * GET /api/upgrade/history
 * Get upgrade history
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const history = await upgradeService.getUpgradeHistory(limit);

    return res.json({
      history,
      count: history.length
    });
  } catch (error) {
    logger.error('Error getting upgrade history:', error);
    return res.status(500).json({ error: 'Failed to get upgrade history' });
  }
});

/**
 * POST /api/upgrade/cancel/:upgradeId
 * Cancel an in-progress upgrade
 */
router.post('/cancel/:upgradeId', async (req: Request, res: Response) => {
  try {
    const { upgradeId } = req.params;

    const result = await upgradeService.cancelUpgrade(upgradeId);

    if (result.success) {
      return res.json(result);
    } else {
      return res.status(400).json(result);
    }
  } catch (error) {
    logger.error('Error cancelling upgrade:', error);
    return res.status(500).json({ error: 'Failed to cancel upgrade' });
  }
});

/**
 * GET /api/upgrade/latest-status
 * Get latest status from watchdog (file-based)
 */
router.get('/latest-status', async (req: Request, res: Response) => {
  try {
    const status = await upgradeService.getLatestUpgradeStatus();
    return res.json({ status });
  } catch (error) {
    logger.error('Error getting latest upgrade status:', error);
    return res.status(500).json({ error: 'Failed to get latest status' });
  }
});

export default router;
