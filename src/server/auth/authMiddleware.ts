/**
 * Authentication Middleware
 *
 * Express middleware for authentication and authorization
 */

import { Request, Response, NextFunction } from 'express';
import { ResourceType, PermissionAction } from '../../types/permission.js';
import { User } from '../../types/auth.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Attach user to request if authenticated (optional auth)
 * If not authenticated, attaches anonymous user for permission checks
 */
export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.session.userId) {
        const user = await databaseService.findUserByIdAsync(req.session.userId);
        if (user && user.isActive) {
          req.user = user;
        } else {
          // Session is invalid, clear it
          req.session.userId = undefined;
          req.session.username = undefined;
          req.session.authProvider = undefined;
          req.session.isAdmin = undefined;
        }
      }

      // If no authenticated user, attach anonymous user for permission checks
      if (!req.user) {
        const anonymousUser = await databaseService.findUserByUsernameAsync('anonymous');
        if (anonymousUser && anonymousUser.isActive) {
          req.user = anonymousUser;
        }
      }

      next();
    } catch (error) {
      logger.error('Error in optionalAuth middleware:', error);
      next();
    }
  };
}

/**
 * Require authentication
 */
export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.session.userId) {
        // Check if the session cookie exists at all
        const hasCookie = req.headers.cookie?.includes('meshmonitor.sid');
        if (!hasCookie) {
          logger.warn('⚠️  Authentication failed: No session cookie present. This may indicate:');
          logger.warn('   1. Secure cookies enabled but accessing via HTTP');
          logger.warn('   2. Browser blocking cookies due to SameSite policy');
          logger.warn('   3. Reverse proxy stripping cookies');
        }

        return res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED'
        });
      }

      const user = await databaseService.findUserByIdAsync(req.session.userId);

      if (!user || !user.isActive) {
        // Clear invalid session
        req.session.userId = undefined;
        req.session.username = undefined;
        req.session.authProvider = undefined;
        req.session.isAdmin = undefined;

        return res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED'
        });
      }

      req.user = user;
      next();
    } catch (error) {
      logger.error('Error in requireAuth middleware:', error);
      return res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  };
}

/**
 * Require specific permission
 * Works with both authenticated and anonymous users
 */
export function requirePermission(resource: ResourceType, action: PermissionAction) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let user;

      // Get authenticated user or anonymous user
      if (req.session.userId) {
        user = await databaseService.findUserByIdAsync(req.session.userId);

        if (!user || !user.isActive) {
          // Clear invalid session
          req.session.userId = undefined;
          req.session.username = undefined;
          req.session.authProvider = undefined;
          req.session.isAdmin = undefined;
          user = null;
        }
      }

      // If no authenticated user, try anonymous
      if (!user) {
        const anonymousUser = await databaseService.findUserByUsernameAsync('anonymous');
        if (anonymousUser && anonymousUser.isActive) {
          user = anonymousUser;
        }
      }

      // If still no user, deny access
      if (!user) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED'
        });
      }

      // Admins have all permissions
      if (user.isAdmin) {
        req.user = user;
        return next();
      }

      // Check permission
      const hasPermission = await databaseService.checkPermissionAsync(
        user.id,
        resource,
        action
      );

      if (!hasPermission) {
        logger.debug(`❌ User ${user.username} denied ${action} access to ${resource}`);

        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource, action }
        });
      }

      req.user = user;
      next();
    } catch (error) {
      logger.error('Error in requirePermission middleware:', error);
      return res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  };
}

/**
 * Require admin role
 */
export function requireAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED'
        });
      }

      const user = await databaseService.findUserByIdAsync(req.session.userId);

      if (!user || !user.isActive) {
        // Clear invalid session
        req.session.userId = undefined;
        req.session.username = undefined;
        req.session.authProvider = undefined;
        req.session.isAdmin = undefined;

        return res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED'
        });
      }

      if (!user.isAdmin) {
        logger.debug(`❌ User ${user.username} denied admin access`);

        return res.status(403).json({
          error: 'Admin access required',
          code: 'FORBIDDEN_ADMIN'
        });
      }

      req.user = user;
      next();
    } catch (error) {
      logger.error('Error in requireAdmin middleware:', error);
      return res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  };
}

/**
 * Check if user has a specific permission (async version)
 */
export async function hasPermission(user: User, resource: ResourceType, action: PermissionAction): Promise<boolean> {
  // Admins have all permissions
  if (user.isAdmin) {
    return true;
  }

  // Check permission via database (async for PostgreSQL support)
  return databaseService.checkPermissionAsync(user.id, resource, action);
}

/**
 * Require API token authentication (for v1 API)
 * Extracts token from Authorization header: "Bearer mm_v1_..."
 */
export function requireAPIToken() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'API token required. Use Authorization: Bearer <token>'
        });
      }

      const token = authHeader.substring(7); // Remove 'Bearer ' prefix

      // Validate token and get user (async method returns user object directly)
      const user = await databaseService.validateApiTokenAsync(token);
      if (!user) {
        // Log failed attempt for security monitoring (fire-and-forget)
        databaseService.auditLogAsync(
          null,
          'api_token_invalid',
          null,
          JSON.stringify({ path: req.path }),
          req.ip || req.socket.remoteAddress || 'unknown'
        ).catch(err => logger.error('Failed to write audit log:', err));

        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid or expired API token'
        });
      }

      // Check if user is active
      if (!user.isActive) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User account is inactive'
        });
      }

      // Attach user to request (same pattern as session auth)
      req.user = user;

      // Log successful API access (for audit trail, fire-and-forget)
      databaseService.auditLogAsync(
        user.id,
        'api_token_used',
        req.path,
        JSON.stringify({ method: req.method }),
        req.ip || req.socket.remoteAddress || 'unknown'
      ).catch(err => logger.error('Failed to write audit log:', err));

      next();
    } catch (error) {
      logger.error('Error in requireAPIToken middleware:', error);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to authenticate API token'
      });
    }
  };
}
