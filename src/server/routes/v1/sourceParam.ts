/**
 * v1 API — source scoping middleware.
 *
 * Every per-source v1 endpoint sits under /api/v1/sources/:sourceId/... and
 * uses `attachSource(resource, action)` to:
 *
 *   1. Validate the :sourceId path param (including the literal `default`
 *      alias, which resolves to the first source the authenticated token's
 *      user has `<resource>:<action>` on).
 *   2. Enforce the per-source permission check in one shot.
 *   3. Attach the resolved `Source` to `req.source` and normalise
 *      `req.params.sourceId` so downstream code can rely on a concrete UUID.
 *
 * Admin users bypass the permission probe and get the first enabled source by
 * `createdAt` when they request `default`.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Source } from '../../../db/repositories/sources.js';
import type { ResourceType, PermissionAction } from '../../../types/permission.js';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';

export const DEFAULT_SOURCE_ALIAS = 'default';

/**
 * Returns the first enabled source (by createdAt ASC) that the given user
 * has the specified permission on. Admins get the first enabled source
 * without a permission probe. Returns null if no such source exists.
 */
async function resolveDefaultForUser(
  userId: number,
  isAdmin: boolean,
  resource: ResourceType,
  action: PermissionAction
): Promise<Source | null> {
  const allSources = await databaseService.sources.getAllSources();
  // Stable order — first-created first. getAllSources doesn't guarantee this,
  // so sort explicitly.
  const sorted = [...allSources]
    .filter((s) => s.enabled)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (sorted.length === 0) return null;

  if (isAdmin) {
    return sorted[0];
  }

  for (const source of sorted) {
    const allowed = await databaseService.checkPermissionAsync(
      userId,
      resource,
      action,
      source.id
    );
    if (allowed) return source;
  }
  return null;
}

/**
 * Express middleware factory — attach the resolved source (or short-circuit
 * with 401/403/404) before the route handler runs.
 *
 * Must be mounted on a sub-router created with `Router({ mergeParams: true })`
 * so `req.params.sourceId` is available.
 */
export function attachSource(
  resource: ResourceType,
  action: PermissionAction = 'read'
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const rawSourceId = req.params.sourceId;
    if (typeof rawSourceId !== 'string' || rawSourceId === '') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'sourceId path parameter is required',
      });
    }

    // `requireAPIToken` (upstream) populates `req.user` for successful token
    // auth. If it's missing, auth failed earlier — return 401 defensively.
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    let resolved: Source | null = null;
    if (rawSourceId === DEFAULT_SOURCE_ALIAS) {
      resolved = await resolveDefaultForUser(user.id, Boolean(user.isAdmin), resource, action);
      if (!resolved) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message:
            'No source found that this token has permission to access. Configure a source and/or grant permissions.',
        });
      }
      logger.info(`[v1] default alias resolved → ${resolved.id} for user ${user.id}`);
    } else {
      resolved = await databaseService.sources.getSource(rawSourceId);
      if (!resolved) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Source ${rawSourceId} not found`,
        });
      }

      // Permission check (admins bypass inside checkPermissionAsync? No — we
      // must short-circuit explicitly).
      if (!user.isAdmin) {
        const allowed = await databaseService.checkPermissionAsync(
          user.id,
          resource,
          action,
          resolved.id
        );
        if (!allowed) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'Insufficient permissions for this source',
            required: { resource, action, sourceId: resolved.id },
          });
        }
      }
    }

    (req as any).source = resolved;
    // Normalise the param so handlers can pull either from req.source.id or
    // req.params.sourceId interchangeably.
    req.params.sourceId = resolved.id;
    next();
  };
}

/**
 * Convenience type for handlers that run after attachSource — guarantees
 * req.source is present.
 */
export interface RequestWithSource extends Request {
  source: Source;
}
