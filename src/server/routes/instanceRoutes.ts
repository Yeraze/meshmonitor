/**
 * Instance Metadata Route for MeshManager Integration
 * 
 * Provides instance identification and metadata for health checks
 * 
 * Endpoint:
 * - GET /api/instance/metadata - Instance identification and metadata
 */

import express, { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');

const router = express.Router();

/**
 * Optional authentication middleware that supports both session and API key
 * Tries session auth first, then API key from headers
 */
const optionalAuthWithApiKey = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    // Try session authentication first
    if (req.session?.userId) {
      const user = databaseService.userModel.findById(req.session.userId);
      if (user && user.isActive) {
        (req as any).user = user;
        return next();
      }
    }

    // Try API key authentication
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
    
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const userId = await databaseService.apiTokenModel.validate(token);
      if (userId) {
        const user = databaseService.userModel.findById(userId);
        if (user && user.isActive) {
          (req as any).user = user;
          return next();
        }
      }
    } else if (apiKeyHeader) {
      const userId = await databaseService.apiTokenModel.validate(apiKeyHeader);
      if (userId) {
        const user = databaseService.userModel.findById(userId);
        if (user && user.isActive) {
          (req as any).user = user;
          return next();
        }
      }
    }

    // If no authentication, attach anonymous user for permission checks
    const anonymousUser = databaseService.userModel.findByUsername('anonymous');
    if (anonymousUser && anonymousUser.isActive) {
      (req as any).user = anonymousUser;
    }

    next();
  } catch (error) {
    logger.error('Error in optionalAuthWithApiKey middleware:', error);
    next();
  }
};

// Apply optional authentication (supports both session and API key)
router.use(optionalAuthWithApiKey);

/**
 * GET /api/instance/metadata
 * Returns instance identification and metadata
 */
router.get('/metadata', (_req: Request, res: Response) => {
  try {
    res.json({
      version: packageJson.version,
      meshmonitorVersion: packageJson.version,
      instanceId: 'default', // Can be customized via environment variable in future
      capabilities: ['aggregation'],
    });
  } catch (error) {
    logger.error('Error in /api/instance/metadata:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to get metadata',
    });
  }
});

export default router;

