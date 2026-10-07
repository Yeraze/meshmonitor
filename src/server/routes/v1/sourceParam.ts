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
import type { User } from '../../../types/auth.js';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { loadNodeViewAccess, type NodeViewAccess } from '../../utils/nodeEnhancer.js';
import { fail } from '../../utils/apiResponse.js';

export const DEFAULT_SOURCE_ALIAS = 'default';

/**
 * Returns the first enabled source (by createdAt ASC) that the token's user
 * holds the specified permission on. Admins get the first enabled source.
 * Returns null if no such source exists.
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

const ACCESS = Symbol.for('meshmonitor.v1NodeViewAccess');
type AccessCarrier = { [ACCESS]?: Promise<NodeViewAccess> };

/**
 * The token user's grants for this request, loaded ONCE and answered per
 * source with no further query: a handler that decides row by row (which
 * channel, which private position) reads this one object however many rows it
 * returns. `attachSource` makes its own single check at the door. Every v1
 * route sits behind `requireAPIToken()`, so `req.user` is the token's creator:
 * a token carries exactly that user's per-source permissions.
 */
export function loadV1Access(req: Request): Promise<NodeViewAccess> {
  const carrier = req as unknown as AccessCarrier;
  carrier[ACCESS] ??= loadNodeViewAccess((req as Request & { user?: User }).user ?? null);
  return carrier[ACCESS];
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
  const middleware: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
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
      logger.debug(`[v1] default alias resolved → ${resolved.id} for user ${user.id}`);
    } else {
      resolved = await databaseService.sources.getSource(rawSourceId);
      if (!resolved) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Source ${rawSourceId} not found`,
        });
      }

      // The grant must be held on THIS source. Admins pass.
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
  (middleware as unknown as { [ATTACH_SOURCE_GATE]: AttachSourceGate })[ATTACH_SOURCE_GATE] = { resource, action };
  return middleware;
}

/** What an `attachSource()` middleware enforces. Read by the route guard tests. */
export interface AttachSourceGate {
  resource: ResourceType;
  action: PermissionAction;
}

const ATTACH_SOURCE_GATE = Symbol.for('meshmonitor.v1AttachSourceGate');

/** The gate a middleware function enforces, or undefined if it was not built
 *  by `attachSource()`. */
export function getAttachSourceGate(handler: unknown): AttachSourceGate | undefined {
  return (handler as { [ATTACH_SOURCE_GATE]?: AttachSourceGate } | null | undefined)?.[ATTACH_SOURCE_GATE];
}

/**
 * Convenience type for handlers that run after attachSource — guarantees
 * req.source is present.
 */
export interface RequestWithSource extends Request {
  source: Source;
}

/**
 * Request that MAY have passed through `attachSource`. `source` is present only
 * on the canonical per-source mounts; it is undefined on the legacy root mounts
 * (`/api/v1/nodes?sourceId=`), where `attachSource` never runs.
 */
interface MaybeRequestWithSource extends Request {
  source?: Source;
}

/**
 * Resolve the concrete source id for a path-scoped request.
 *
 * Prefers `req.source.id` (attached by `attachSource`) over the raw `:sourceId`
 * path param. This is load-bearing for the `default` alias: `attachSource`
 * normalises `req.params.sourceId` to the resolved id, but Express RE-DERIVES
 * `req.params` for each `mergeParams` sub-router from the matched URL — so a
 * handler inside a sub-router reads the raw URL literal (e.g. `"default"`), NOT
 * the normalised value. `req.source` is a request-level property that survives
 * the re-derivation, so it carries the concrete resolved Source. Returns
 * `undefined` on the legacy root mounts, where callers fall back to `?sourceId=`.
 */
export function resolvedSourceIdFromPath(req: Request): string | undefined {
  const fromSource = (req as MaybeRequestWithSource).source?.id;
  if (typeof fromSource === 'string' && fromSource) return fromSource;
  return typeof req.params.sourceId === 'string' ? req.params.sourceId : undefined;
}

/**
 * The one source a per-source v1 handler reads. Every such handler sits behind
 * `attachSource`, which has checked the token user's grant on it. If a router
 * is ever mounted without it there is no source the permission check covered:
 * the handler answers 400 here instead of reading every source, which is what
 * the old `sourceId ?? ALL_SOURCES` fallbacks did.
 */
export function requireScopedSourceId(req: Request, res: Response): string | null {
  const sourceId = (req as MaybeRequestWithSource).source?.id;
  if (typeof sourceId === 'string' && sourceId) return sourceId;
  fail(res, 400, 'MISSING_SOURCE_ID', 'This endpoint is served under /api/v1/sources/{sourceId}/');
  return null;
}

/**
 * May the token user read a row (telemetry, traceroute) heard on `channel` of
 * `sourceId`? A row with no channel recorded carries no channel restriction.
 */
export function canViewRowChannel(
  access: NodeViewAccess,
  sourceId: string,
  channel: number | null | undefined,
): boolean {
  if (access.isAdmin || channel === undefined || channel === null) return true;
  return access.canViewNode(sourceId, channel);
}
