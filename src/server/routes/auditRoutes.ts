/**
 * Audit Log Routes
 *
 * Admin-only routes for viewing audit logs
 */

import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// All routes require audit:read permission (admin only)
router.use(requirePermission('audit', 'read'));

// Get audit logs with filtering
router.get('/', (req: Request, res: Response) => {
  try {
    const {
      limit = '100',
      offset = '0',
      userId,
      action,
      resource,
      startDate,
      endDate,
      search
    } = req.query;

    const options = {
      limit: Math.min(parseInt(limit as string, 10) || 100, 1000), // Max 1000
      offset: parseInt(offset as string, 10) || 0,
      userId: userId ? parseInt(userId as string, 10) : undefined,
      action: action as string | undefined,
      resource: resource as string | undefined,
      startDate: startDate ? parseInt(startDate as string, 10) : undefined,
      endDate: endDate ? parseInt(endDate as string, 10) : undefined,
      search: search as string | undefined
    };

    const result = databaseService.getAuditLogs(options);

    return res.json({
      logs: result.logs,
      total: result.total,
      offset: options.offset,
      limit: options.limit
    });
  } catch (error) {
    logger.error('Error getting audit logs:', error);
    return res.status(500).json({ error: 'Failed to get audit logs' });
  }
});

// Get specific audit log entry
router.get('/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid audit log ID' });
    }

    // Use getAuditLogs with no filters but get all to find specific ID
    // This is inefficient but works for now
    const result = databaseService.getAuditLogs({ limit: 10000 });
    const log = result.logs.find((l: any) => l.id === id);

    if (!log) {
      return res.status(404).json({ error: 'Audit log entry not found' });
    }

    return res.json({ log });
  } catch (error) {
    logger.error('Error getting audit log entry:', error);
    return res.status(500).json({ error: 'Failed to get audit log entry' });
  }
});

// Get audit log statistics
router.get('/stats/summary', (req: Request, res: Response) => {
  try {
    const daysParam = req.query.days as string;

    // Validate days parameter if provided
    if (daysParam) {
      const parsed = parseInt(daysParam, 10);
      if (isNaN(parsed) || parsed < 1) {
        return res.status(400).json({ error: 'days must be a positive number' });
      }
    }

    const days = parseInt(daysParam, 10) || 30;
    const stats = databaseService.getAuditStats(days);

    return res.json({
      stats,
      days
    });
  } catch (error) {
    logger.error('Error getting audit stats:', error);
    return res.status(500).json({ error: 'Failed to get audit statistics' });
  }
});

// Cleanup old audit logs (admin only)
router.post('/cleanup', requirePermission('audit', 'write'), (req: Request, res: Response) => {
  try {
    // Require admin for cleanup operations
    if (!req.user?.isAdmin) {
      return res.status(403).json({
        error: 'Admin privileges required for audit log cleanup'
      });
    }

    const { days } = req.body;

    if (!days || typeof days !== 'number' || days < 1) {
      return res.status(400).json({
        error: 'days must be a positive number'
      });
    }

    const deletedCount = databaseService.cleanupAuditLogs(days);

    // Log the cleanup action
    databaseService.auditLog(
      req.user!.id,
      'audit_cleanup',
      'audit',
      JSON.stringify({ days, deletedCount }),
      req.ip || null
    );

    return res.json({
      success: true,
      deletedCount,
      message: `Cleaned up ${deletedCount} audit log entries older than ${days} days`
    });
  } catch (error) {
    logger.error('Error cleaning up audit logs:', error);
    return res.status(500).json({ error: 'Failed to cleanup audit logs' });
  }
});

export default router;
