/**
 * A user's grants, loaded once and answered per source.
 *
 * A leaf module (database + types only) so `nodeEnhancer` and the route gates
 * in `sourceScopedAccess` can both use it without an import cycle through the
 * source managers.
 */
import { isSourceyResource } from '../../types/permission.js';
import type { ResourceType, PermissionAction, PermissionSet } from '../../types/permission.js';
import type { User } from '../../types/auth.js';
import databaseService from '../../services/database.js';

/** One user's grants, loaded once, answered per source with no further query. */
export interface SourcePermissions {
  readonly isAdmin: boolean;
  /** `resource:action` on `sourceId`. Always true for an admin. A resource
   *  that is not per-source is answered from the global grant. */
  can(resource: ResourceType, action: PermissionAction, sourceId: string): boolean;
  /** The grants held on one source. Empty for an admin: use `isAdmin`. */
  on(sourceId: string): PermissionSet;
  /** Sources where the grants satisfy `test`. Throws for an admin, who is not
   *  limited to a list: check `isAdmin` first. */
  sourcesWhere(test: (grants: PermissionSet) => boolean): string[];
}

type Grant = { viewOnMap: boolean; read: boolean; write: boolean };

const NO_GRANTS: PermissionSet = Object.freeze({});

/**
 * Load every grant `user` holds in ONE query, so a handler that must decide
 * per row which source's permission applies does not query per row or per
 * source. `null` (no user at all) holds nothing.
 */
export async function loadSourcePermissions(user: User | null | undefined): Promise<SourcePermissions> {
  if (!user) {
    return { isAdmin: false, can: () => false, on: () => NO_GRANTS, sourcesWhere: () => [] };
  }
  if (user.isAdmin) {
    return {
      isAdmin: true,
      can: () => true,
      on: () => NO_GRANTS,
      // An admin is not limited to a list of sources. An empty list here would
      // read as "no source" and silently return nothing.
      sourcesWhere: () => {
        throw new Error('SourcePermissions.sourcesWhere: an admin may read every source; check isAdmin first');
      },
    };
  }
  // Built from the raw rows, with the same precedence `checkPermissionAsync`
  // applies: for a per-source resource the FIRST row for (resource, source)
  // decides; for a global resource any row that grants the action does.
  const rows = await databaseService.auth.getPermissionsForUser(user.id);
  const sets: Record<string, PermissionSet> = {};
  const globalRows: Array<{ resource: string; grant: Grant; sourceId: string | null }> = [];
  for (const row of rows) {
    const grant: Grant = {
      viewOnMap: (row as { canViewOnMap?: boolean | null }).canViewOnMap ? true : false,
      read: !!row.canRead,
      write: !!row.canWrite,
    };
    const sourceId = (row as { sourceId?: string | null }).sourceId ?? null;
    const resource = row.resource as ResourceType;
    if (!isSourceyResource(resource)) {
      globalRows.push({ resource, grant, sourceId });
      continue;
    }
    if (!sourceId) continue;
    const set = (sets[sourceId] ??= {});
    if (set[resource] === undefined) set[resource] = grant;
  }
  return {
    isAdmin: false,
    can(resource, action, sourceId) {
      if (isSourceyResource(resource)) return sets[sourceId]?.[resource]?.[action] === true;
      return globalRows.some((row) => row.resource === resource && row.grant[action] === true);
    },
    on: (sourceId) => sets[sourceId] ?? NO_GRANTS,
    sourcesWhere: (test) => Object.keys(sets).filter((sourceId) => test(sets[sourceId])),
  };
}
