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
import databaseService from '../../services/database.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');

const router = Router();

// All routes require authentication
router.use(requireAuth());

/**
 * GET /api/upgrade/status
 * Check if upgrade functionality is enabled and if an upgrade is in progress
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const activeUpgrade = await upgradeService.getActiveUpgrade();

    return res.json({
      enabled: upgradeService.isEnabled(),
      deploymentMethod: upgradeService.getDeploymentMethod(),
      currentVersion: packageJson.version,
      activeUpgrade: activeUpgrade || null
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

    // Validate targetVersion format if provided
    if (targetVersion !== undefined && targetVersion !== null && targetVersion !== 'latest') {
      const versionPattern = /^v?\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
      if (typeof targetVersion !== 'string' || !versionPattern.test(targetVersion)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid targetVersion format. Must be "latest" or a valid semantic version (e.g., "2.14.4", "v2.14.4")'
        });
      }
    }

    // Validate boolean parameters
    if (force !== undefined && typeof force !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Invalid force parameter. Must be a boolean'
      });
    }

    if (backup !== undefined && typeof backup !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Invalid backup parameter. Must be a boolean'
      });
    }

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
      // Log upgrade trigger to audit log
      databaseService.auditLog(
        typeof userId === 'number' ? userId : null,
        'upgrade_triggered',
        'system',
        `Upgrade initiated: ${packageJson.version} → ${targetVersion || 'latest'}`,
        req.ip || null
      );

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

    // Validate UUID format
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(upgradeId)) {
      return res.status(400).json({ error: 'Invalid upgrade ID format. Must be a valid UUID' });
    }

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
    // Validate and bound the limit parameter
    let limit = 10; // Default
    if (req.query.limit) {
      const parsedLimit = parseInt(req.query.limit as string, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        return res.status(400).json({ error: 'Invalid limit parameter. Must be a positive integer' });
      }
      // Cap at 100 to prevent resource exhaustion
      limit = Math.min(parsedLimit, 100);
    }

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

    // Validate UUID format
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(upgradeId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid upgrade ID format. Must be a valid UUID'
      });
    }

    // Get upgrade details before cancelling for audit log
    const upgradeStatus = await upgradeService.getUpgradeStatus(upgradeId);

    const result = await upgradeService.cancelUpgrade(upgradeId);

    if (result.success) {
      // Log upgrade cancellation to audit log
      const versionInfo = upgradeStatus
        ? `${upgradeStatus.fromVersion} → ${upgradeStatus.toVersion}`
        : 'unknown version';

      databaseService.auditLog(
        req.user?.id || null,
        'upgrade_cancelled',
        'system',
        `Upgrade cancelled: ${versionInfo} (ID: ${upgradeId})`,
        req.ip || null
      );

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
router.get('/latest-status', async (_req: Request, res: Response) => {
  try {
    const status = await upgradeService.getLatestUpgradeStatus();
    return res.json({ status });
  } catch (error) {
    logger.error('Error getting latest upgrade status:', error);
    return res.status(500).json({ error: 'Failed to get latest status' });
  }
});

/**
 * GET /api/upgrade/test-configuration
 * Test auto-upgrade configuration and verify all components are working
 */
router.get('/test-configuration', async (_req: Request, res: Response) => {
  try {
    const testResult = await upgradeService.testConfiguration();
    return res.json(testResult);
  } catch (error) {
    logger.error('Error testing upgrade configuration:', error);
    return res.status(500).json({
      success: false,
      results: [],
      overallMessage: 'Failed to run configuration test',
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
