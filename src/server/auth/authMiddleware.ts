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
import { extractProxyUser, isAdminUser, isNormalProxyUserAllowed } from './proxyAuth.js';
import { getEnvironmentConfig } from '../config/environment.js';

/**
 * Attach user to request if authenticated (optional auth)
 * If not authenticated, attaches anonymous user for permission checks
 *
 * Authentication priority:
 * 1. Proxy auth (if enabled) - highest priority
 * 2. Session auth - fallback if no proxy headers
 * 3. Anonymous user - fallback if no auth
 */
export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const config = getEnvironmentConfig();

      // NEW: Try proxy auth first (highest priority)
      if (config.proxyAuthEnabled) {
        const proxyUser = extractProxyUser(req);

        if (proxyUser) {
          // Application-layer group gate (PROXY_AUTH_NORMAL_USER_GROUPS)
          if (!isNormalProxyUserAllowed(proxyUser.email, proxyUser.groups)) {
            return _res.status(403).json({
              error: 'Access denied: user is not in any allowed proxy group',
              code: 'FORBIDDEN_PROXY_GROUP'
            });
          }

          // Look up user by email
          let user = await databaseService.findUserByEmailAsync(proxyUser.email);

          if (!user) {
            // Auto-provision if enabled
            if (config.proxyAuthAutoProvision) {
              logger.info(`🔐 Auto-provisioning proxy user: ${proxyUser.email}`);

              const isAdmin = isAdminUser(proxyUser.email, proxyUser.groups);
              const username = proxyUser.email.split('@')[0]; // Use email prefix as username

              // Create user (reuse OIDC pattern)
              const userId = await databaseService.auth.createUser({
                username,
                email: proxyUser.email,
                displayName: proxyUser.email,
                authMethod: 'proxy',
                isAdmin,
                isActive: true,
                passwordHash: null,
                passwordLocked: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                lastLoginAt: Date.now()
              });

              // Grant default permissions (same as OIDC)
              const defaultResources = ['dashboard', 'nodes', 'messages', 'settings', 'info', 'traceroute'];
              for (const resource of defaultResources) {
                await databaseService.auth.createPermission({
                  userId,
                  resource,
                  canRead: true,
                  canWrite: false,
                  grantedBy: null,
                  grantedAt: Date.now()
                });
              }

              user = await databaseService.findUserByIdAsync(userId);

              // Audit log (if enabled)
              if (config.proxyAuthAuditLogging) {
                databaseService.auditLogAsync(
                  userId,
                  'proxy_user_created',
                  'users',
                  JSON.stringify({
                    email: proxyUser.email,
                    groups: proxyUser.groups,
                    source: proxyUser.source,
                    isAdmin
                  }),
                  req.ip || null
                ).catch(err => logger.error('Audit log failed:', err));
              }

              logger.debug(`✅ Proxy user auto-created: ${username}`);
            } else {
              // Auto-provision disabled - fall through to session/anonymous auth
              logger.warn(`❌ Proxy user not found and auto-provision disabled: ${proxyUser.email}`);
            }
          }

          // Check if we need to migrate local user to proxy
          if (user && user.authProvider === 'local') {
            logger.info(`🔄 Migrating local user '${user.username}' to proxy auth`);

            const isAdmin = isAdminUser(proxyUser.email, proxyUser.groups);

            await databaseService.auth.updateUser(user.id, {
              authMethod: 'proxy',
              email: proxyUser.email || user.email,
              passwordHash: null, // Clear password for proxy users (same as OIDC)
              isAdmin,
              lastLoginAt: Date.now()
            });

            user = await databaseService.findUserByIdAsync(user.id);

            // Audit log
            if (config.proxyAuthAuditLogging) {
              databaseService.auditLogAsync(
                user!.id,
                'user_migrated_to_proxy',
                'users',
                JSON.stringify({
                  userId: user!.id,
                  username: user!.username,
                  email: proxyUser.email,
                  source: proxyUser.source
                }),
                req.ip || null
              ).catch(err => logger.error('Audit log failed:', err));
            }

            logger.debug(`✅ User migrated to proxy auth: ${user!.username}`);
          }

          // Update admin status (re-evaluate on every request for immediate privilege changes)
          if (user && user.authProvider === 'proxy') {
            const currentIsAdmin = isAdminUser(proxyUser.email, proxyUser.groups);

            if (currentIsAdmin !== user.isAdmin) {
              logger.info(`🔄 Updating admin status for ${user.username}: ${user.isAdmin} → ${currentIsAdmin}`);

              await databaseService.auth.updateUser(user.id, {
                isAdmin: currentIsAdmin,
                lastLoginAt: Date.now()
              });

              user = await databaseService.findUserByIdAsync(user.id);
            } else {
              // Just update lastLoginAt
              await databaseService.auth.updateUser(user.id, {
                lastLoginAt: Date.now()
              });
            }
          }

          // Attach user to request
          if (user && user.isActive) {
            req.user = user;

            // Update session to match (creates session if not exists)
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.authProvider = 'proxy';
            req.session.isAdmin = user.isAdmin;

            // Audit log successful auth (if enabled)
            if (config.proxyAuthAuditLogging) {
              databaseService.auditLogAsync(
                user.id,
                'proxy_auth_success',
                'auth',
                JSON.stringify({
                  username: user.username,
                  email: proxyUser.email,
                  groups: proxyUser.groups,
                  source: proxyUser.source,
                  isAdmin: user.isAdmin
                }),
                req.ip || null
              ).catch(err => logger.error('Audit log failed:', err));
            }

            return next();
          }
        }
      }

      // EXISTING: Session-based auth (fallback)
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
export interface RequirePermissionOptions {
  sourceIdFrom?: 'params.id' | 'query' | 'body';
  /** If the primary resource check fails, try this resource as a fallback.
   *  Useful for endpoints consumed by the dashboard — `dashboard:read`
   *  grants access even if the specific resource permission is missing. */
  fallbackResource?: ResourceType;
}

export function requirePermission(
  resource: ResourceType,
  action: PermissionAction,
  options?: RequirePermissionOptions
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let user;

      // Resolve scoped sourceId if requested
      let scopedSourceId: string | undefined;
      if (options?.sourceIdFrom) {
        let raw: unknown;
        if (options.sourceIdFrom === 'params.id') {
          raw = req.params?.id;
        } else if (options.sourceIdFrom === 'query') {
          raw = req.query?.sourceId;
        } else if (options.sourceIdFrom === 'body') {
          raw = req.body?.sourceId;
        }
        if (raw !== undefined && raw !== null && raw !== '') {
          if (typeof raw !== 'string') {
            return res.status(400).json({
              error: 'Invalid sourceId',
              code: 'BAD_REQUEST'
            });
          }
          scopedSourceId = raw;
        }
      }
      (req as any).scopedSourceId = scopedSourceId;

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

      // Check permission (scoped to source if provided)
      const hasPermission = await databaseService.checkPermissionAsync(
        user.id,
        resource,
        action,
        scopedSourceId
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
export async function hasPermission(user: User, resource: ResourceType, action: PermissionAction, sourceId?: string): Promise<boolean> {
  // Admins have all permissions
  if (user.isAdmin) {
    return true;
  }

  // Check permission via database (async for PostgreSQL support)
  return databaseService.checkPermissionAsync(user.id, resource, action, sourceId);
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
