/**
 * Security Routes
 *
 * Routes for viewing security scan results and key management
 */

import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { duplicateKeySchedulerService } from '../services/duplicateKeySchedulerService.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// All routes require security:read permission
router.use(requirePermission('security', 'read'));

// Get all nodes with security issues
router.get('/issues', (_req: Request, res: Response) => {
  try {
    const nodesWithIssues = databaseService.getNodesWithKeySecurityIssues();

    // Categorize issues
    const lowEntropyNodes = nodesWithIssues.filter(node => node.keyIsLowEntropy);
    const duplicateKeyNodes = nodesWithIssues.filter(node => node.duplicateKeyDetected);

    return res.json({
      total: nodesWithIssues.length,
      lowEntropyCount: lowEntropyNodes.length,
      duplicateKeyCount: duplicateKeyNodes.length,
      nodes: nodesWithIssues.map(node => ({
        nodeNum: node.nodeNum,
        shortName: node.shortName || 'Unknown',
        longName: node.longName || 'Unknown',
        lastHeard: node.lastHeard,
        keyIsLowEntropy: node.keyIsLowEntropy,
        duplicateKeyDetected: node.duplicateKeyDetected,
        keySecurityIssueDetails: node.keySecurityIssueDetails,
        publicKey: node.publicKey,
        hwModel: node.hwModel
      }))
    });
  } catch (error) {
    logger.error('Error getting security issues:', error);
    return res.status(500).json({ error: 'Failed to get security issues' });
  }
});

// Get scanner status
router.get('/scanner/status', (_req: Request, res: Response) => {
  try {
    const status = duplicateKeySchedulerService.getStatus();

    return res.json(status);
  } catch (error) {
    logger.error('Error getting scanner status:', error);
    return res.status(500).json({ error: 'Failed to get scanner status' });
  }
});

// Trigger manual scan (requires write permission)
router.post('/scanner/scan', requirePermission('security', 'write'), async (req: Request, res: Response) => {
  try {
    const status = duplicateKeySchedulerService.getStatus();

    if (status.scanningNow) {
      return res.status(409).json({
        error: 'A scan is already in progress'
      });
    }

    // Log the manual scan trigger
    databaseService.auditLog(
      req.user!.id,
      'security_scan_triggered',
      'security',
      'Manual security scan initiated',
      req.ip || null
    );

    // Run scan asynchronously
    duplicateKeySchedulerService.runScan().catch(err => {
      logger.error('Error during manual security scan:', err);
    });

    return res.json({
      success: true,
      message: 'Security scan initiated'
    });
  } catch (error) {
    logger.error('Error triggering security scan:', error);
    return res.status(500).json({ error: 'Failed to trigger security scan' });
  }
});

export default router;
