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
    const tokenInfo = databaseService.apiTokenModel.getUserToken(userId);

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

    // Generate new token (automatically revokes old one)
    const { token, tokenInfo } = await databaseService.apiTokenModel.create({
      userId,
      createdBy
    });

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

    // Get current token
    const tokenInfo = databaseService.apiTokenModel.getUserToken(userId);
    if (!tokenInfo) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'No active API token found'
      });
    }

    // Revoke token
    const revoked = databaseService.apiTokenModel.revoke(tokenInfo.id, userId);
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
