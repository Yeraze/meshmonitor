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
router.get('/issues', async (_req: Request, res: Response) => {
  try {
    const nodesWithIssues = await databaseService.getNodesWithKeySecurityIssuesAsync();

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

// Export security issues
router.get('/export', async (req: Request, res: Response) => {
  try {
    const format = req.query.format as string || 'csv';

    const nodesWithIssues = await databaseService.getNodesWithKeySecurityIssuesAsync();
    const timestamp = new Date().toISOString();

    // Log the export action
    databaseService.auditLog(
      req.user!.id,
      'security_export',
      'security',
      `Security issues exported as ${format.toUpperCase()}`,
      req.ip || null
    );

    if (format === 'json') {
      // JSON export
      const jsonData = {
        exportDate: timestamp,
        total: nodesWithIssues.length,
        lowEntropyCount: nodesWithIssues.filter(n => n.keyIsLowEntropy).length,
        duplicateKeyCount: nodesWithIssues.filter(n => n.duplicateKeyDetected).length,
        nodes: nodesWithIssues.map(node => ({
          nodeNum: node.nodeNum,
          nodeId: `!${node.nodeNum.toString(16).padStart(8, '0')}`,
          shortName: node.shortName || 'Unknown',
          longName: node.longName || 'Unknown',
          hwModel: node.hwModel,
          lastHeard: node.lastHeard,
          lastHeardDate: node.lastHeard ? new Date(node.lastHeard * 1000).toISOString() : null,
          keyIsLowEntropy: node.keyIsLowEntropy,
          duplicateKeyDetected: node.duplicateKeyDetected,
          keySecurityIssueDetails: node.keySecurityIssueDetails,
          // Include partial key hash for duplicate identification (first 16 chars only)
          keyHashPrefix: node.publicKey ? node.publicKey.substring(0, 16) : null
        }))
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="security-scan-${Date.now()}.json"`);
      // Use pretty-printed JSON for consistency with other exports
      return res.send(JSON.stringify(jsonData, null, 2));
    } else {
      // CSV export (default)
      const csvRows = [
        // Header row
        'Node ID,Short Name,Long Name,Hardware Model,Last Heard,Low-Entropy Key,Duplicate Key,Issue Details,Key Hash Prefix'
      ];

      nodesWithIssues.forEach(node => {
        const nodeId = `!${node.nodeNum.toString(16).padStart(8, '0')}`;
        const shortName = (node.shortName || 'Unknown').replace(/,/g, ';'); // Escape commas
        const longName = (node.longName || 'Unknown').replace(/,/g, ';');
        const hwModel = node.hwModel || '';
        const lastHeard = node.lastHeard ? new Date(node.lastHeard * 1000).toISOString() : 'Never';
        const isLowEntropy = node.keyIsLowEntropy ? 'Yes' : 'No';
        const isDuplicate = node.duplicateKeyDetected ? 'Yes' : 'No';
        const details = (node.keySecurityIssueDetails || '').replace(/,/g, ';').replace(/\n/g, ' ');
        const keyPrefix = node.publicKey ? node.publicKey.substring(0, 16) : '';

        csvRows.push(`${nodeId},"${shortName}","${longName}",${hwModel},${lastHeard},${isLowEntropy},${isDuplicate},"${details}",${keyPrefix}`);
      });

      const csvContent = csvRows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="security-scan-${Date.now()}.csv"`);
      return res.send(csvContent);
    }
  } catch (error) {
    logger.error('Error exporting security issues:', error);
    return res.status(500).json({ error: 'Failed to export security issues' });
  }
});

export default router;
