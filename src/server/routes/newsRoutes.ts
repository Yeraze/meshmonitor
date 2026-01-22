/**
 * News Routes
 *
 * API endpoints for news functionality:
 * - GET /api/news - Get cached news feed
 * - GET /api/user/news-status - Get user's news status
 * - POST /api/user/news-status - Update user's news status
 */

import express from 'express';
import { newsService } from '../services/newsService.js';
import { requireAuth, optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/news
 * Get the cached news feed
 * Public endpoint - no auth required
 */
router.get('/', optionalAuth(), async (_req, res) => {
  try {
    const feed = await newsService.getCachedNews();

    if (!feed) {
      res.json({
        version: '1',
        lastUpdated: new Date().toISOString(),
        items: []
      });
      return;
    }

    res.json(feed);
  } catch (error) {
    logger.error('Error getting news feed:', error);
    res.status(500).json({ error: 'Failed to get news feed' });
  }
});

/**
 * GET /api/user/news-status
 * Get current user's news status (last seen, dismissed items)
 * Requires authentication
 */
router.get('/user/status', requireAuth(), async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const status = await newsService.getUserNewsStatus(userId);

    res.json({
      lastSeenNewsId: status?.lastSeenNewsId || null,
      dismissedNewsIds: status?.dismissedNewsIds || []
    });
  } catch (error) {
    logger.error('Error getting user news status:', error);
    res.status(500).json({ error: 'Failed to get news status' });
  }
});

/**
 * POST /api/user/news-status
 * Update current user's news status
 * Requires authentication
 */
router.post('/user/status', requireAuth(), async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { lastSeenNewsId, dismissedNewsIds } = req.body;

    // Validate input
    if (dismissedNewsIds !== undefined && !Array.isArray(dismissedNewsIds)) {
      res.status(400).json({ error: 'dismissedNewsIds must be an array' });
      return;
    }

    await newsService.saveUserNewsStatus(
      userId,
      lastSeenNewsId ?? null,
      Array.isArray(dismissedNewsIds) ? dismissedNewsIds : []
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Error saving user news status:', error);
    res.status(500).json({ error: 'Failed to save news status' });
  }
});

/**
 * POST /api/news/dismiss/:id
 * Dismiss a specific news item for the current user
 * Requires authentication
 */
router.post('/dismiss/:id', requireAuth(), async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const newsId = req.params.id;
    if (!newsId) {
      res.status(400).json({ error: 'News ID required' });
      return;
    }

    // Get current status
    const currentStatus = await newsService.getUserNewsStatus(userId);
    const dismissedIds = currentStatus?.dismissedNewsIds || [];

    // Add to dismissed if not already there
    if (!dismissedIds.includes(newsId)) {
      dismissedIds.push(newsId);
    }

    await newsService.saveUserNewsStatus(
      userId,
      newsId, // Also update last seen to this item
      dismissedIds
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Error dismissing news item:', error);
    res.status(500).json({ error: 'Failed to dismiss news item' });
  }
});

/**
 * GET /api/news/unread
 * Get unread news items for the current user
 * Requires authentication
 */
router.get('/unread', requireAuth(), async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const unreadItems = await newsService.getUnreadNewsForUser(userId);

    res.json({
      items: unreadItems
    });
  } catch (error) {
    logger.error('Error getting unread news:', error);
    res.status(500).json({ error: 'Failed to get unread news' });
  }
});

export default router;
