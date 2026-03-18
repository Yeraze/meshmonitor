/**
 * API Token Management Routes
 *
 * Routes for users to manage their API tokens for the v1 API
 */

import express, { Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/token
 * Get user's current API token info (without the actual token)
 */
router.get('/', requireAuth(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const tokenInfo = await databaseService.auth.getUserActiveApiToken(userId);

    if (!tokenInfo) {
      return res.json({
        hasToken: false,
        token: null
      });
    }

    res.json({
      hasToken: true,
      token: {
        id: tokenInfo.id,
        prefix: tokenInfo.prefix,
        createdAt: tokenInfo.createdAt,
        lastUsedAt: tokenInfo.lastUsedAt,
        isActive: tokenInfo.isActive
      }
    });
  } catch (error) {
    logger.error('Error getting API token:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve API token information'
    });
  }
});

/**
 * POST /api/token/generate
 * Generate a new API token (revokes existing token if present)
 * Returns the full token (shown only once!)
 */
router.post('/generate', requireAuth(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const createdBy = req.user!.id;

    let token: string;
    let tokenInfo: {
      id: number;
      prefix: string;
      isActive: boolean;
      createdAt: number;
      lastUsedAt: number | null;
    };

    // Use AuthRepository for all backends
    const result = await databaseService.auth.generateAndCreateApiToken(userId, createdBy);
    token = result.token;
    tokenInfo = result.tokenInfo;

    // Audit log
    databaseService.auditLog(
      userId,
      'api_token_generated',
      'api_token',
      JSON.stringify({ tokenId: tokenInfo.id, prefix: tokenInfo.prefix }),
      req.ip || req.socket.remoteAddress || 'unknown'
    );

    logger.info(`API token generated for user ${userId} (prefix: ${tokenInfo.prefix})`);

    res.json({
      message: 'API token generated successfully. Save this token securely - it will not be shown again.',
      token: token,  // Full token shown ONCE
      tokenInfo: {
        id: tokenInfo.id,
        prefix: tokenInfo.prefix,
        createdAt: tokenInfo.createdAt,
        isActive: tokenInfo.isActive
      }
    });
  } catch (error) {
    logger.error('Error generating API token:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to generate API token'
    });
  }
});

/**
 * DELETE /api/token
 * Revoke the user's current API token
 */
router.delete('/', requireAuth(), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const activeToken = await databaseService.auth.getUserActiveApiToken(userId);
    if (!activeToken) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'No active API token found'
      });
    }
    const tokenInfo = { id: activeToken.id, prefix: activeToken.prefix };
    const revoked = await databaseService.auth.revokeApiToken(activeToken.id, userId);

    if (!revoked) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Token not found or already revoked'
      });
    }

    // Audit log
    databaseService.auditLog(
      userId,
      'api_token_revoked',
      'api_token',
      JSON.stringify({ tokenId: tokenInfo.id, prefix: tokenInfo.prefix }),
      req.ip || req.socket.remoteAddress || 'unknown'
    );

    logger.info(`API token revoked for user ${userId} (prefix: ${tokenInfo.prefix})`);

    res.json({
      message: 'API token revoked successfully'
    });
  } catch (error) {
    logger.error('Error revoking API token:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to revoke API token'
    });
  }
});

export default router;
