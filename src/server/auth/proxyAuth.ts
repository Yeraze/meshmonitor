/**
 * Proxy Authentication Module
 *
 * Handles authentication via reverse proxy headers (Cloudflare Access, oauth2-proxy, etc.)
 * Supports JWT decoding and generic header extraction.
 *
 * SECURITY MODEL:
 * - Assumes proxy is trusted and upstream from MeshMonitor
 * - Requires TRUST_PROXY to be configured
 * - MeshMonitor should NOT be directly accessible (use Docker networks, firewall, etc.)
 * - No JWT signature validation (proxy already validated)
 */

import { Request } from 'express';
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';

/**
 * Proxy user information extracted from headers
 */
export interface ProxyUser {
  email: string;
  groups: string[];
  source: 'cloudflare' | 'oauth2-proxy' | 'generic';
}

/**
 * Case-insensitive header lookup
 */
function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Get nested value from object by dot-path
 * Supports both dot notation and URL-style paths (Auth0 custom namespaces)
 * Cloudflare Access application JWTs often nest IdP custom claims under `custom`,
 * e.g. custom["https://tenant/roles"] while the flat top-level key is absent.
 * Examples:
 *   - getNestedValue(obj, 'groups') → obj.groups
 *   - getNestedValue(obj, 'realm_access.roles') → obj.realm_access.roles
 *   - getNestedValue(obj, 'https://mydomain.com/roles') → obj[path] or obj.custom[path]
 */
function getNestedValue(obj: any, path: string): any {
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
 * Parse comma-separated groups string
 */
function parseGroups(groupsHeader: string | undefined): string[] {
  if (!groupsHeader) return [];
  return groupsHeader.split(',').map(g => g.trim()).filter(Boolean);
}

/**
 * Decode JWT payload without signature validation
 * WARNING: Only use this when the JWT comes from a trusted proxy!
 * The proxy has already validated the JWT signature - we just extract claims.
 */
function decodeJwtPayload(jwtToken: string): any {
  try {
    const parts = jwtToken.split('.');
    if (parts.length !== 3) {
      logger.warn('Invalid JWT format (expected 3 parts)');
      return null;
    }

    // Decode base64url payload (middle part)
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (err) {
    logger.error('Failed to decode JWT payload:', err);
    return null;
  }
}

/**
 * Normalize JWT groups claim to a flat string array.
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
 * Extract user from Cloudflare Access JWT
 */
function extractFromCloudflareJwt(jwtToken: string): ProxyUser | null {
  const payload = decodeJwtPayload(jwtToken);
  if (!payload) return null;

  const email = payload.email;
  if (!email) {
    logger.warn('Cloudflare JWT missing email claim');
    return null;
  }

  const config = getEnvironmentConfig();
  const groupsClaim = config.proxyAuthJwtGroupsClaim;
  const rawGroups = getNestedValue(payload, groupsClaim);
  const groups = normalizeGroups(rawGroups);

  return {
    email,
    groups,
    source: 'cloudflare'
  };
}

/**
 * Extract user from oauth2-proxy headers
 */
function extractFromOauth2Proxy(headers: Record<string, string | string[] | undefined>): ProxyUser | null {
  const email = getHeader(headers, 'x-auth-request-email');
  if (!email) return null;

  const groupsHeader = getHeader(headers, 'x-auth-request-groups');
  const groups = parseGroups(groupsHeader);

  return {
    email,
    groups,
    source: 'oauth2-proxy'
  };
}

/**
 * Extract user from generic proxy headers
 */
function extractFromGenericProxy(headers: Record<string, string | string[] | undefined>): ProxyUser | null {
  const config = getEnvironmentConfig();

  // Check custom header names first
  let email: string | undefined;
  if (config.proxyAuthHeaderEmail) {
    email = getHeader(headers, config.proxyAuthHeaderEmail);
  } else {
    // Default: Remote-User header
    email = getHeader(headers, 'remote-user');
  }

  if (!email) return null;

  // Extract groups
  let groups: string[] = [];
  if (config.proxyAuthHeaderGroups) {
    const groupsHeader = getHeader(headers, config.proxyAuthHeaderGroups);
    groups = parseGroups(groupsHeader);
  } else {
    // Default: Remote-Groups header
    const groupsHeader = getHeader(headers, 'remote-groups');
    groups = parseGroups(groupsHeader);
  }

  return {
    email,
    groups,
    source: 'generic'
  };
}

/**
 * Extract proxy user from request headers
 * Auto-detects Cloudflare Access, oauth2-proxy, or generic proxy
 *
 * Priority:
 * 1. Cloudflare Access JWT (Cf-Access-Jwt-Assertion header)
 * 2. oauth2-proxy (X-Auth-Request-Email header)
 * 3. Generic proxy (configurable headers or defaults)
 */
export function extractProxyUser(req: Request): ProxyUser | null {
  const config = getEnvironmentConfig();

  if (!config.proxyAuthEnabled) {
    return null;
  }

  // Priority 1: Cloudflare Access JWT
  const cfJwt = getHeader(req.headers as Record<string, string | string[] | undefined>, 'cf-access-jwt-assertion');
  if (cfJwt) {
    const user = extractFromCloudflareJwt(cfJwt);
    if (user) {
      logger.debug(`✅ Extracted user from Cloudflare Access: ${user.email}`);
      return user;
    }
  }

  // Priority 2: oauth2-proxy
  const oauth2User = extractFromOauth2Proxy(req.headers as Record<string, string | string[] | undefined>);
  if (oauth2User) {
    logger.debug(`✅ Extracted user from oauth2-proxy: ${oauth2User.email}`);
    return oauth2User;
  }

  // Priority 3: Generic proxy
  const genericUser = extractFromGenericProxy(req.headers as Record<string, string | string[] | undefined>);
  if (genericUser) {
    logger.debug(`✅ Extracted user from generic proxy: ${genericUser.email}`);
    return genericUser;
  }

  return null;
}

/**
 * Case-insensitive check: does `groups` contain any value from `allowList`?
 */
function groupsContainAny(groups: string[], allowList: string[]): boolean {
  const lowerAllow = allowList.map(g => g.toLowerCase());
  return groups.some(g => lowerAllow.includes(g.toLowerCase()));
}

/**
 * Determine if user should be admin based on groups or email
 *
 * Priority:
 * 1. If PROXY_AUTH_ADMIN_GROUPS is set and user has any of those groups → admin (case-insensitive)
 * 2. If PROXY_AUTH_ADMIN_EMAILS is set and user email matches → admin (case-insensitive)
 * 3. Otherwise → not admin
 */
export function isAdminUser(email: string, groups: string[]): boolean {
  const config = getEnvironmentConfig();

  // Check group-based admin detection (case-insensitive)
  if (config.proxyAuthAdminGroups.length > 0 && groups.length > 0) {
    if (groupsContainAny(groups, config.proxyAuthAdminGroups)) {
      logger.debug(`✅ User ${email} has admin group: ${groups.join(', ')}`);
      return true;
    }
  }

  // Fallback: Check email-based admin list (case-insensitive)
  if (config.proxyAuthAdminEmails.length > 0) {
    const isAdminEmail = config.proxyAuthAdminEmails.includes(email.toLowerCase());
    if (isAdminEmail) {
      logger.debug(`✅ User ${email} in admin email list`);
      return true;
    }
  }

  return false;
}

/**
 * Determine if a proxy user is allowed to access the application.
 *
 * Two-layer model:
 * - The reverse proxy (e.g. Cloudflare Access) controls who can reach the URL.
 * - PROXY_AUTH_NORMAL_USER_GROUPS adds an application-layer group gate.
 *
 * Returns true if:
 * - PROXY_AUTH_NORMAL_USER_GROUPS is empty (no extra gate — default)
 * - The user is an admin (admins always pass)
 * - The user's groups contain at least one value from the config list (case-insensitive)
 */
export function isNormalProxyUserAllowed(email: string, groups: string[]): boolean {
  const config = getEnvironmentConfig();

  if (config.proxyAuthNormalUserGroups.length === 0) {
    return true;
  }

  if (isAdminUser(email, groups)) {
    return true;
  }

  if (groups.length > 0 && groupsContainAny(groups, config.proxyAuthNormalUserGroups)) {
    return true;
  }

  logger.warn(`❌ Proxy user ${email} not in any allowed normal-user group: ${config.proxyAuthNormalUserGroups.join(', ')}`);
  return false;
}

