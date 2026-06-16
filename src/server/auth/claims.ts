/**
 * Shared helpers for resolving group/role information from identity-provider
 * claims. Used by both proxy auth (JWT/header groups) and native OIDC
 * (ID-token groups claim) so the two paths interpret group claims identically.
 */

/**
 * Get a nested value from an object by dot-path.
 * Supports both dot notation and URL-style paths (Auth0 custom namespaces).
 * Cloudflare Access application JWTs often nest IdP custom claims under `custom`,
 * e.g. custom["https://tenant/roles"] while the flat top-level key is absent.
 * Examples:
 *   - getNestedValue(obj, 'groups') → obj.groups
 *   - getNestedValue(obj, 'realm_access.roles') → obj.realm_access.roles
 *   - getNestedValue(obj, 'https://mydomain.com/roles') → obj[path] or obj.custom[path]
 */
export function getNestedValue(obj: any, path: string): any {
  // Handle URL-style paths (Auth0 custom namespaces)
  if (path.includes('://')) {
    const top = obj[path];
    if (top !== undefined && top !== null) {
      return top;
    }
    return obj.custom?.[path];
  }

  // Handle dot notation
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

/**
 * Normalize a groups/roles claim to a flat string array.
 * Handles: string, string[], { name: string }[], and mixed arrays.
 */
export function normalizeGroups(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(raw)) return [];

  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) result.push(trimmed);
    } else if (entry && typeof entry === 'object' && 'name' in entry) {
      const name = String((entry as { name: unknown }).name).trim();
      if (name) result.push(name);
    }
  }
  return result;
}

/**
 * Case-insensitive check: does `groups` contain any value from `allowList`?
 */
export function groupsContainAny(groups: string[], allowList: string[]): boolean {
  const lowerAllow = allowList.map((g) => g.toLowerCase());
  return groups.some((g) => lowerAllow.includes(g.toLowerCase()));
}

export interface GroupRoleDecision {
  /** Whether the user is permitted to log in (allowed-groups gate). */
  allowed: boolean;
  /** Whether the user should be granted admin rights. */
  isAdmin: boolean;
  /** Whether admin groups are configured at all (governs bootstrap fallback). */
  adminGroupsConfigured: boolean;
}

/**
 * Resolve a login decision from a user's groups and the configured admin /
 * allowed group lists. Pure and dialect-agnostic so it can be unit-tested
 * without an IdP.
 *
 * - `isAdmin` is true only when admin groups are configured AND the user is in
 *   one of them. When admin groups are NOT configured, the caller keeps its
 *   existing behaviour (e.g. the first-OIDC-login bootstrap / manual promotion).
 * - `allowed` is true unless an allowed-groups list is configured and the user
 *   is in neither it nor an admin group (admins always pass the gate, mirroring
 *   proxy auth's `isNormalProxyUserAllowed`).
 */
export function resolveGroupRole(
  groups: string[],
  opts: { adminGroups: string[]; allowedGroups: string[] },
): GroupRoleDecision {
  const adminGroupsConfigured = opts.adminGroups.length > 0;
  const isAdmin = adminGroupsConfigured && groupsContainAny(groups, opts.adminGroups);

  let allowed = true;
  if (opts.allowedGroups.length > 0) {
    allowed = isAdmin || groupsContainAny(groups, opts.allowedGroups);
  }

  return { allowed, isAdmin, adminGroupsConfigured };
}
