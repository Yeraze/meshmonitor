/**
 * Unified Routes
 *
 * Cross-source endpoints for the unified views. Returns merged data from all
 * sources the authenticated user has read access to, tagged with sourceId and
 * sourceName so the frontend can group and color-code entries.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// All unified routes allow optional auth (some data may be public)
router.use(optionalAuth);

/**
 * GET /api/unified/messages?limit=50
 *
 * Returns messages from all sources the user can read, merged by timestamp
 * (newest first). Each message includes `sourceId` and `sourceName`.
 */
router.get('/messages', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    // Fetch all sources
    const sources = await databaseService.sources.getAllSources();

    // For each source, check if user has messages read permission and fetch messages
    const sourceMsgResults = await Promise.allSettled(
      sources.map(async (source) => {
        // Permission check: admin sees all, otherwise check per-source then global
        const canRead = isAdmin || (user
          ? await databaseService.checkPermissionAsync(user.id, 'messages', 'read', source.id)
          : false);

        if (!canRead) return [];

        const messages = await databaseService.messages.getMessages(limit, 0, source.id);
        return messages.map(m => ({
          ...m,
          sourceId: source.id,
          sourceName: source.name,
        }));
      })
    );

    // Merge and sort by timestamp descending
    const allMessages: Array<Record<string, unknown>> = [];
    for (const result of sourceMsgResults) {
      if (result.status === 'fulfilled') {
        allMessages.push(...result.value);
      }
    }

    allMessages.sort((a, b) => {
      const ta = (a.timestamp as number) ?? 0;
      const tb = (b.timestamp as number) ?? 0;
      return tb - ta;
    });

    res.json(allMessages.slice(0, limit));
  } catch (error) {
    logger.error('Error fetching unified messages:', error);
    res.status(500).json({ error: 'Failed to fetch unified messages' });
  }
});

/**
 * GET /api/unified/sources-status
 *
 * Returns connection status for all sources the user can access.
 * Used by the source list page to show live status without polling each source.
 */
router.get('/sources-status', async (_req: Request, res: Response) => {
  try {
    const { sourceManagerRegistry } = await import('../sourceManagerRegistry.js');
    const sources = await databaseService.sources.getAllSources();

    const statuses = await Promise.allSettled(
      sources.map(async (source) => {
        const manager = sourceManagerRegistry.getManager(source.id);
        if (!manager) {
          return { sourceId: source.id, connected: false };
        }
        const status = manager.getStatus();
        return { sourceId: source.id, connected: status.connected };
      })
    );

    const result: Record<string, unknown> = {};
    statuses.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        result[sources[i].id] = s.value;
      }
    });

    res.json(result);
  } catch (error) {
    logger.error('Error fetching unified sources status:', error);
    res.status(500).json({ error: 'Failed to fetch sources status' });
  }
});

export default router;
