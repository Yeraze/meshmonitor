/**
 * Security Routes
 *
 * Routes for viewing security scan results and key management
 */

import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { duplicateKeySchedulerService } from '../services/duplicateKeySchedulerService.js';
import { securityDigestService } from '../services/securityDigestService.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// All routes require security:read permission
router.use(requirePermission('security', 'read'));

// Get all nodes with security issues
router.get('/issues', async (req: Request, res: Response) => {
  try {
    const secSourceId = req.query.sourceId as string | undefined;
    const nodesWithKeyIssues = await databaseService.getNodesWithKeySecurityIssuesAsync(secSourceId);
    const nodesWithExcessivePackets = await databaseService.getNodesWithExcessivePacketsAsync(secSourceId);

    // Combine and deduplicate
    const allIssueNodes = new Map<number, any>();

    for (const node of nodesWithKeyIssues) {
      allIssueNodes.set(node.nodeNum, {
        nodeNum: node.nodeNum,
        shortName: node.shortName || 'Unknown',
        longName: node.longName || 'Unknown',
        lastHeard: node.lastHeard,
        keyIsLowEntropy: node.keyIsLowEntropy,
        duplicateKeyDetected: node.duplicateKeyDetected,
        keySecurityIssueDetails: node.keySecurityIssueDetails,
        publicKey: node.publicKey,
        hwModel: node.hwModel,
        isExcessivePackets: (node as any).isExcessivePackets || false,
        packetRatePerHour: (node as any).packetRatePerHour || null,
        packetRateLastChecked: (node as any).packetRateLastChecked || null,
        isTimeOffsetIssue: (node as any).isTimeOffsetIssue || false,
        timeOffsetSeconds: (node as any).timeOffsetSeconds || null
      });
    }

    for (const node of nodesWithExcessivePackets) {
      if (!allIssueNodes.has(node.nodeNum)) {
        allIssueNodes.set(node.nodeNum, {
          nodeNum: node.nodeNum,
          shortName: node.shortName || 'Unknown',
          longName: node.longName || 'Unknown',
          lastHeard: node.lastHeard,
          keyIsLowEntropy: node.keyIsLowEntropy || false,
          duplicateKeyDetected: node.duplicateKeyDetected || false,
          keySecurityIssueDetails: node.keySecurityIssueDetails,
          publicKey: node.publicKey,
          hwModel: node.hwModel,
          isExcessivePackets: (node as any).isExcessivePackets || false,
          packetRatePerHour: (node as any).packetRatePerHour || null,
          packetRateLastChecked: (node as any).packetRateLastChecked || null,
          isTimeOffsetIssue: (node as any).isTimeOffsetIssue || false,
          timeOffsetSeconds: (node as any).timeOffsetSeconds || null
        });
      } else {
        // Merge excessive packets info into existing node
        const existing = allIssueNodes.get(node.nodeNum)!;
        existing.isExcessivePackets = (node as any).isExcessivePackets || false;
        existing.packetRatePerHour = (node as any).packetRatePerHour || null;
        existing.packetRateLastChecked = (node as any).packetRateLastChecked || null;
      }
    }

    // Add time offset nodes
    const nodesWithTimeOffset = await databaseService.getNodesWithTimeOffsetIssuesAsync(secSourceId);

    for (const node of nodesWithTimeOffset) {
      if (!allIssueNodes.has(node.nodeNum)) {
        allIssueNodes.set(node.nodeNum, {
          nodeNum: node.nodeNum,
          shortName: node.shortName || 'Unknown',
          longName: node.longName || 'Unknown',
          lastHeard: node.lastHeard,
          keyIsLowEntropy: node.keyIsLowEntropy || false,
          duplicateKeyDetected: node.duplicateKeyDetected || false,
          keySecurityIssueDetails: node.keySecurityIssueDetails,
          publicKey: node.publicKey,
          hwModel: node.hwModel,
          isExcessivePackets: (node as any).isExcessivePackets || false,
          packetRatePerHour: (node as any).packetRatePerHour || null,
          packetRateLastChecked: (node as any).packetRateLastChecked || null,
          isTimeOffsetIssue: (node as any).isTimeOffsetIssue || false,
          timeOffsetSeconds: (node as any).timeOffsetSeconds || null
        });
      } else {
        const existing = allIssueNodes.get(node.nodeNum)!;
        existing.isTimeOffsetIssue = (node as any).isTimeOffsetIssue || false;
        existing.timeOffsetSeconds = (node as any).timeOffsetSeconds || null;
      }
    }

    const nodesWithIssues = Array.from(allIssueNodes.values());

    // Categorize issues
    const lowEntropyNodes = nodesWithIssues.filter(node => node.keyIsLowEntropy);
    const duplicateKeyNodes = nodesWithIssues.filter(node => node.duplicateKeyDetected);
    const excessivePacketsNodes = nodesWithIssues.filter(node => node.isExcessivePackets);
    const timeOffsetNodes = nodesWithIssues.filter(node => node.isTimeOffsetIssue);

    // Get top 5 broadcasters for spam analysis
    const topBroadcasters = await databaseService.getTopBroadcastersAsync(5, secSourceId);

    return res.json({
      total: nodesWithIssues.length,
      lowEntropyCount: lowEntropyNodes.length,
      duplicateKeyCount: duplicateKeyNodes.length,
      excessivePacketsCount: excessivePacketsNodes.length,
      timeOffsetCount: timeOffsetNodes.length,
      nodes: nodesWithIssues,
      topBroadcasters
    });
  } catch (error) {
    logger.error('Error getting security issues:', error);
    return res.status(500).json({ error: 'Failed to get security issues' });
  }
});

// Get scanner status. Accepts optional ?sourceId for single-source view;
// omitting it returns the full per-source map.
router.get('/scanner/status', (req: Request, res: Response) => {
  try {
    const sourceId = req.query.sourceId as string | undefined;
    const status = duplicateKeySchedulerService.getStatus(sourceId);
    return res.json(status);
  } catch (error) {
    logger.error('Error getting scanner status:', error);
    return res.status(500).json({ error: 'Failed to get scanner status' });
  }
});

// Trigger manual scan for a specific source. sourceId is required in the body
// and used both for permission scoping and scan targeting.
router.post(
  '/scanner/scan',
  requirePermission('security', 'write', { sourceIdFrom: 'body' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = req.body?.sourceId;
      if (!sourceId || typeof sourceId !== 'string') {
        return res.status(400).json({ error: 'sourceId is required' });
      }

      // Require the source to be registered — no fallback to a default manager.
      const manager = sourceManagerRegistry.getManager(sourceId);
      if (!manager) {
        return res.status(400).json({ error: `Unknown sourceId: ${sourceId}` });
      }

      const status = duplicateKeySchedulerService.getStatus(sourceId);
      if (status.scanningNow) {
        return res.status(409).json({
          error: `A scan is already in progress for source ${sourceId}`
        });
      }

      databaseService.auditLogAsync(
        req.user!.id,
        'security_scan_triggered',
        'security',
        `Manual security scan initiated for source ${sourceId}`,
        req.ip || null
      );

      duplicateKeySchedulerService.runScan(sourceId).catch(err => {
        logger.error(`Error during manual security scan for ${sourceId}:`, err);
      });

      return res.json({
        success: true,
        message: `Security scan initiated for source ${sourceId}`,
        sourceId,
      });
    } catch (error) {
      logger.error('Error triggering security scan:', error);
      return res.status(500).json({ error: 'Failed to trigger security scan' });
    }
  }
);

// Export security issues
router.get('/export', async (req: Request, res: Response) => {
  try {
    const format = req.query.format as string || 'csv';
    const exportSourceId = req.query.sourceId as string | undefined;

    const nodesWithIssues = await databaseService.getNodesWithKeySecurityIssuesAsync(exportSourceId);
    const timestamp = new Date().toISOString();

    // Log the export action
    databaseService.auditLogAsync(
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
          isTimeOffsetIssue: (node as any).isTimeOffsetIssue || false,
          timeOffsetSeconds: (node as any).timeOffsetSeconds || null,
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
        'Node ID,Short Name,Long Name,Hardware Model,Last Heard,Low-Entropy Key,Duplicate Key,Time Offset,Offset (seconds),Issue Details,Key Hash Prefix'
      ];

      nodesWithIssues.forEach(node => {
        const nodeId = `!${node.nodeNum.toString(16).padStart(8, '0')}`;
        const shortName = (node.shortName || 'Unknown').replace(/,/g, ';'); // Escape commas
        const longName = (node.longName || 'Unknown').replace(/,/g, ';');
        const hwModel = node.hwModel || '';
        const lastHeard = node.lastHeard ? new Date(node.lastHeard * 1000).toISOString() : 'Never';
        const isLowEntropy = node.keyIsLowEntropy ? 'Yes' : 'No';
        const isDuplicate = node.duplicateKeyDetected ? 'Yes' : 'No';
        const isTimeOffset = (node as any).isTimeOffsetIssue ? 'Yes' : 'No';
        const offsetSeconds = (node as any).timeOffsetSeconds ?? '';
        const details = (node.keySecurityIssueDetails || '').replace(/,/g, ';').replace(/\n/g, ' ');
        const keyPrefix = node.publicKey ? node.publicKey.substring(0, 16) : '';

        csvRows.push(`${nodeId},"${shortName}","${longName}",${hwModel},${lastHeard},${isLowEntropy},${isDuplicate},${isTimeOffset},${offsetSeconds},"${details}",${keyPrefix}`);
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

// Clear security issues for a specific node (requires write permission)
router.post('/nodes/:nodeNum/clear', requirePermission('security', 'write'), async (req: Request, res: Response) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);

    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'Invalid node number' });
    }

    const node = await databaseService.nodes.getNode(nodeNum);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const nodeName = node.shortName || node.longName || `Node ${nodeNum}`;

    // Clear all security flags
    await databaseService.nodes.upsertNode({
      nodeNum,
      nodeId: node.nodeId,
      keyIsLowEntropy: false,
      duplicateKeyDetected: false,
      keyMismatchDetected: false,
      keySecurityIssueDetails: null, // null explicitly clears the field (undefined would preserve existing value)
    });

    // Clear time offset flags (scoped to the node's source per migration 029)
    await databaseService.updateNodeTimeOffsetFlagsAsync(nodeNum, false, null, (node as any).sourceId);

    // Log the action
    databaseService.auditLogAsync(
      req.user!.id,
      'security_issues_cleared',
      'security',
      `Cleared security issues for ${nodeName} (${nodeNum})`,
      req.ip || null
    );

    logger.info(`🔐 Security issues cleared for ${nodeName} (${nodeNum}) by user ${req.user!.username}`);

    return res.json({
      success: true,
      message: `Security issues cleared for ${nodeName}`,
      nodeNum,
      nodeName
    });
  } catch (error) {
    logger.error('Error clearing security issues:', error);
    return res.status(500).json({ error: 'Failed to clear security issues' });
  }
});

/**
 * GET /api/security/key-mismatches
 * Returns recent key mismatch events from the repair log
 */
router.get('/key-mismatches', async (_req: Request, res: Response) => {
  try {
    const log = await databaseService.getKeyRepairLogAsync(100);

    // Filter to mismatch-related actions
    const mismatchActions = new Set(['mismatch', 'purge', 'fixed', 'exhausted']);
    const filtered = log.filter(entry => mismatchActions.has(entry.action));

    // Filter to last 7 days
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recent = filtered.filter(entry => entry.timestamp >= sevenDaysAgo);

    // Limit to 50 entries
    const limited = recent.slice(0, 50);

    res.json({
      success: true,
      count: limited.length,
      events: limited
    });
  } catch (error) {
    logger.error('Error fetching key mismatch history:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch key mismatch history' });
  }
});

/**
 * GET /api/security/dead-nodes
 * Returns nodes not heard from in 7+ days
 */
router.get('/dead-nodes', async (req: Request, res: Response) => {
  try {
    let deadNodesSourceId = req.query.sourceId as string | undefined;
    // Fall back to first registered manager for legacy single-source callers
    if (!deadNodesSourceId) {
      const managers = sourceManagerRegistry.getAllManagers();
      if (managers.length === 0) {
        return res.status(400).json({ error: 'No source managers available' });
      }
      deadNodesSourceId = managers[0].sourceId;
    }
    const deadNodesManagerBase = sourceManagerRegistry.getManager(deadNodesSourceId);
    if (!deadNodesManagerBase) {
      return res.status(400).json({ error: `Unknown sourceId: ${deadNodesSourceId}` });
    }
    const deadNodesManager = deadNodesManagerBase as any;
    const DEAD_NODE_DAYS = 7;
    const cutoffSeconds = Math.floor(Date.now() / 1000) - (DEAD_NODE_DAYS * 24 * 60 * 60);

    const allNodes = await databaseService.nodes.getAllNodes();
    const localNodeNum = parseInt(await databaseService.settings.getSetting('localNodeNum') || '0');

    const deadNodes = allNodes
      .filter(node => {
        // Exclude local node
        if (Number(node.nodeNum) === localNodeNum) return false;
        // Exclude broadcast address
        if (Number(node.nodeNum) === 0xFFFFFFFF) return false;
        // Exclude ignored nodes
        if (node.isIgnored) return false;
        // Include if never heard or last heard before cutoff
        if (!node.lastHeard) return true;
        return Number(node.lastHeard) < cutoffSeconds;
      })
      .map(node => ({
        nodeNum: Number(node.nodeNum),
        nodeId: node.nodeId,
        longName: node.longName,
        shortName: node.shortName,
        hwModel: node.hwModel,
        lastHeard: node.lastHeard ? Number(node.lastHeard) : null,
        inDeviceDb: deadNodesManager.isNodeInDeviceDb(Number(node.nodeNum)),
      }))
      .sort((a, b) => (a.lastHeard ?? 0) - (b.lastHeard ?? 0)); // Oldest first

    res.json({ nodes: deadNodes, count: deadNodes.length, thresholdDays: DEAD_NODE_DAYS });
  } catch (error) {
    logger.error('Error fetching dead nodes:', error);
    res.status(500).json({ error: 'Failed to fetch dead nodes' });
  }
});

/**
 * POST /api/security/dead-nodes/bulk-delete
 * Delete multiple nodes from local DB and optionally from device NodeDB
 */
router.post('/dead-nodes/bulk-delete', requirePermission('security', 'write'), async (req: Request, res: Response) => {
  try {
    const { nodeNums, sourceId: bulkDeleteSourceId } = req.body;
    const user = (req as any).user;
    if (!bulkDeleteSourceId || typeof bulkDeleteSourceId !== 'string') {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const bulkDeleteManagerBase = sourceManagerRegistry.getManager(bulkDeleteSourceId);
    if (!bulkDeleteManagerBase) {
      return res.status(400).json({ error: `Unknown sourceId: ${bulkDeleteSourceId}` });
    }
    const bulkDeleteManager = bulkDeleteManagerBase as any;

    if (!Array.isArray(nodeNums) || nodeNums.length === 0) {
      return res.status(400).json({ error: 'nodeNums must be a non-empty array' });
    }

    const results: { nodeNum: number; deleted: boolean; removedFromDevice: boolean; error?: string }[] = [];

    for (const nodeNum of nodeNums) {
      try {
        const num = Number(nodeNum);
        let removedFromDevice = false;

        // Remove from device NodeDB if present
        if (bulkDeleteManager.isNodeInDeviceDb(num)) {
          try {
            await bulkDeleteManager.sendRemoveNode(num);
            removedFromDevice = true;
          } catch (deviceErr) {
            logger.warn(`⚠️ Failed to remove node ${num} from device:`, deviceErr);
          }
        }

        // Delete from local database
        await databaseService.deleteNodeAsync(num, bulkDeleteSourceId);
        results.push({ nodeNum: num, deleted: true, removedFromDevice });

        logger.info(`🗑️ Dead node cleanup: deleted node ${num}${removedFromDevice ? ' (+ device)' : ''}`);
      } catch (err) {
        logger.error(`Error deleting node ${nodeNum}:`, err);
        results.push({ nodeNum: Number(nodeNum), deleted: false, removedFromDevice: false, error: String(err) });
      }
    }

    const deletedCount = results.filter(r => r.deleted).length;

    // Audit log
    if (user?.id) {
      await databaseService.auditLogAsync(
        user.id,
        'dead_nodes_cleanup',
        'nodes',
        `Bulk deleted ${deletedCount} dead node(s): ${nodeNums.join(', ')}`,
        req.ip || ''
      );
    }

    res.json({ success: true, deletedCount, results });
  } catch (error) {
    logger.error('Error bulk deleting dead nodes:', error);
    res.status(500).json({ error: 'Failed to bulk delete nodes' });
  }
});

/**
 * POST /api/security/digest/send
 * Manually trigger a security digest (admin only)
 */
router.post('/digest/send', requirePermission('security', 'write'), async (req: Request, res: Response) => {
  try {
    const digestSourceId = (req.body?.sourceId as string | undefined) || undefined;
    const result = await securityDigestService.sendDigest(digestSourceId);
    res.json(result);
  } catch (error) {
    logger.error('Error sending security digest:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
