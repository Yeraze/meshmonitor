/**
 * API Key Authentication Middleware
 *
 * Provides authentication via API keys for external API access
 * Supports Authorization: Bearer <api-key> header format
 */

import { Request, Response, NextFunction } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { User } from '../../types/auth.js';

// Extend Express Request type to include user from API key auth
declare global {
  namespace Express {
    interface Request {
      user?: User;
      apiKeyAuth?: boolean; // Flag to indicate this was API key authentication
    }
  }
}

/**
 * Extract API key from Authorization header
 * Supports: Authorization: Bearer <api-key>
 */
function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  // Check for Bearer token format
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}

/**
 * API Key Authentication Middleware
 *
 * Validates API key from Authorization header and loads associated user
 * Sets req.user if valid API key is provided
 * Sets req.apiKeyAuth = true to indicate API key auth was used
 */
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const apiKey = extractApiKey(req);

    if (!apiKey) {
      // No API key provided, continue to next middleware
      // (might be session-based auth)
      return next();
    }

    // Validate API key
    const apiKeyRecord = await databaseService.apiKeyModel.validateKey(apiKey);

    if (!apiKeyRecord || !apiKeyRecord.isActive) {
      logger.warn(`Invalid or inactive API key used: ${apiKey.substring(0, 10)}...`);
      res.status(401).json({
        error: 'Invalid or inactive API key'
      });
      return;
    }

    // Load associated user
    const user = databaseService.userModel.findById(apiKeyRecord.userId);

    if (!user || !user.isActive) {
      logger.warn(`API key associated with inactive or non-existent user: ${apiKeyRecord.userId}`);
      res.status(401).json({
        error: 'API key associated with inactive user'
      });
      return;
    }

    // Set user on request
    req.user = user;
    req.apiKeyAuth = true;

    logger.debug(`API key authentication successful for user: ${user.username}`);

    next();
  } catch (error) {
    logger.error('Error in API key authentication:', error);
    res.status(500).json({
      error: 'Internal server error during authentication'
    });
  }
}

/**
 * Require API Key Authentication Middleware
 *
 * Returns 401 if no valid API key is provided
 * Use this for endpoints that ONLY support API key auth (not session)
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !req.apiKeyAuth) {
    res.status(401).json({
      error: 'API key authentication required',
      message: 'Please provide a valid API key in the Authorization header: Bearer <api-key>'
    });
    return;
  }

  next();
}

/**
 * API Key OR Session Authentication Middleware
 *
 * Accepts either API key (Authorization header) or session-based auth
 * Useful for v1 endpoints that should support both methods
 */
export async function apiKeyOrSessionAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Check if already authenticated via session
  if (req.user) {
    return next();
  }

  // Try API key authentication
  await apiKeyAuth(req, res, next);
}
