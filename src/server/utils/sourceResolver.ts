/**
 * Shared helper for resolving a default sourceId from the authenticated
 * caller's permissions. Used by non-v1 legacy endpoints (where the source is
 * expressed as an optional query/body field rather than a path segment) to
 * match the v1 behaviour in `routes/v1/sourceParam.ts` — callers that omit
 * `sourceId` get the first enabled source they have the requested permission
 * on, ordered by `createdAt` ASC.
 *
 * Admins bypass the per-source permission probe and always get the first
 * enabled source.
 */

import type { Source } from '../../db/repositories/sources.js';
import type { ResourceType, PermissionAction } from '../../types/permission.js';
import databaseService from '../../services/database.js';

export async function resolveDefaultSourceForUser(
  userId: number,
  isAdmin: boolean,
  resource: ResourceType,
  action: PermissionAction
): Promise<Source | null> {
  const allSources = await databaseService.sources.getAllSources();
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
 * Resolve the effective sourceId for a request. Looks at (in order) the query
 * string, request body, and finally the fallback "first permitted source"
 * helper. Returns `null` if no source can be resolved — callers should 400.
 */
export async function resolveRequestSourceId(
  req: { query: any; body?: any; user?: { id: number; isAdmin?: boolean } },
  resource: ResourceType,
  action: PermissionAction
): Promise<string | null> {
  const raw =
    (typeof req.query?.sourceId === 'string' && req.query.sourceId) ||
    (typeof req.body?.sourceId === 'string' && req.body.sourceId) ||
    null;
  if (raw) return raw;

  const user = req.user;
  if (!user) return null;

  const defaultSource = await resolveDefaultSourceForUser(
    user.id,
    Boolean(user.isAdmin),
    resource,
    action
  );
  return defaultSource ? defaultSource.id : null;
}
