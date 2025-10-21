/**
 * API Key Management Routes
 *
 * Handles creation, viewing, and revocation of API keys
 */

import express, { Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * POST /api/users/me/api-key
 *
 * Generate a new API key for the authenticated user
 * This will revoke any existing active API key
 * Returns the plaintext key (only time it will be available)
 */
router.post('/me/api-key', requireAuth(), async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { key, apiKey } = await databaseService.apiKeyModel.create({
      userId: req.user.id
    });

    logger.info(`API key generated for user: ${req.user.username} (${req.user.id})`);

    // Audit log
    databaseService.auditLog(
      req.user.id,
      'api_key_generated',
      'api_key',
      `API key ID: ${apiKey.id}`,
      (req.ip || req.socket.remoteAddress) ?? null
    );

    res.json({
      success: true,
      message: 'API key generated successfully. Save this key - it will not be shown again.',
      apiKey: {
        key,  // Plaintext key - only shown once
        id: apiKey.id,
        preview: apiKey.keyPreview,
        createdAt: apiKey.createdAt
      }
    });
  } catch (error) {
    logger.error('Error generating API key:', error);
    res.status(500).json({
      error: 'Failed to generate API key',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/users/me/api-key
 *
 * Get current active API key info (preview only, not plaintext)
 */
router.get('/me/api-key', requireAuth(), (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const apiKey = databaseService.apiKeyModel.findByUserId(req.user.id);

    if (!apiKey) {
      res.json({
        hasApiKey: false,
        apiKey: null
      });
      return;
    }

    res.json({
      hasApiKey: true,
      apiKey: {
        id: apiKey.id,
        preview: apiKey.keyPreview,
        createdAt: apiKey.createdAt,
        lastUsedAt: apiKey.lastUsedAt,
        isActive: apiKey.isActive
      }
    });
  } catch (error) {
    logger.error('Error fetching API key:', error);
    res.status(500).json({
      error: 'Failed to fetch API key',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/users/me/api-key
 *
 * Revoke the current active API key
 */
router.delete('/me/api-key', requireAuth(), async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const apiKey = databaseService.apiKeyModel.findByUserId(req.user.id);

    if (!apiKey) {
      res.status(404).json({
        error: 'No active API key found'
      });
      return;
    }

    await databaseService.apiKeyModel.revokeAllForUser(req.user.id);

    logger.info(`API key revoked for user: ${req.user.username} (${req.user.id})`);

    // Audit log
    databaseService.auditLog(
      req.user.id,
      'api_key_revoked',
      'api_key',
      `API key ID: ${apiKey.id}`,
      (req.ip || req.socket.remoteAddress) ?? null
    );

    res.json({
      success: true,
      message: 'API key revoked successfully'
    });
  } catch (error) {
    logger.error('Error revoking API key:', error);
    res.status(500).json({
      error: 'Failed to revoke API key',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
