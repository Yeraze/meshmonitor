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
        const user = databaseService.userModel.findById(req.session.userId);
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
        const anonymousUser = databaseService.userModel.findByUsername('anonymous');
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
        return res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED'
        });
      }

      const user = databaseService.userModel.findById(req.session.userId);

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
 */
export function requirePermission(resource: ResourceType, action: PermissionAction) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'UNAUTHORIZED'
        });
      }

      const user = databaseService.userModel.findById(req.session.userId);

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

      // Admins have all permissions
      if (user.isAdmin) {
        req.user = user;
        return next();
      }

      // Check permission
      const hasPermission = databaseService.permissionModel.check(
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

      const user = databaseService.userModel.findById(req.session.userId);

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
 * Check if user has a specific permission
 */
export function hasPermission(user: User, resource: ResourceType, action: PermissionAction): boolean {
  // Admins have all permissions
  if (user.isAdmin) {
    return true;
  }

  // Check permission via database
  return databaseService.permissionModel.check(user.id, resource, action);
}
