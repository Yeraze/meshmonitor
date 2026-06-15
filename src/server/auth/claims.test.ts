import { describe, it, expect } from 'vitest';
import {
  getNestedValue,
  normalizeGroups,
  groupsContainAny,
  resolveGroupRole,
} from './claims';

describe('getNestedValue', () => {
  it('reads a flat key', () => {
    expect(getNestedValue({ groups: ['a'] }, 'groups')).toEqual(['a']);
  });

  it('reads a dot-notation nested key (Keycloak realm_access.roles)', () => {
    expect(getNestedValue({ realm_access: { roles: ['admin'] } }, 'realm_access.roles')).toEqual(['admin']);
  });

  it('returns undefined for a missing path without throwing', () => {
    expect(getNestedValue({}, 'realm_access.roles')).toBeUndefined();
  });

  it('handles URL-style namespaced claims, including the Cloudflare custom fallback', () => {
    expect(getNestedValue({ 'https://x/roles': ['r'] }, 'https://x/roles')).toEqual(['r']);
    expect(getNestedValue({ custom: { 'https://x/roles': ['r'] } }, 'https://x/roles')).toEqual(['r']);
  });
});

describe('normalizeGroups', () => {
  it('handles null/undefined/empty', () => {
    expect(normalizeGroups(null)).toEqual([]);
    expect(normalizeGroups(undefined)).toEqual([]);
    expect(normalizeGroups('')).toEqual([]);
  });

  it('wraps a single string', () => {
    expect(normalizeGroups('admin')).toEqual(['admin']);
  });

  it('passes through a string array and trims', () => {
    expect(normalizeGroups([' admin ', 'users'])).toEqual(['admin', 'users']);
  });

  it('extracts name from object arrays (mixed)', () => {
    expect(normalizeGroups([{ name: 'admin-role' }, 'plain'])).toEqual(['admin-role', 'plain']);
  });
});

describe('groupsContainAny', () => {
  it('is case-insensitive', () => {
    expect(groupsContainAny(['Admins'], ['admins'])).toBe(true);
    expect(groupsContainAny(['users'], ['admins'])).toBe(false);
  });
});

describe('resolveGroupRole', () => {
  it('no admin groups configured: not admin, adminGroupsConfigured=false (bootstrap fallback applies)', () => {
    const r = resolveGroupRole(['anything'], { adminGroups: [], allowedGroups: [] });
    expect(r).toEqual({ allowed: true, isAdmin: false, adminGroupsConfigured: false });
  });

  it('admin group match → isAdmin', () => {
    const r = resolveGroupRole(['meshmonitor-admins'], { adminGroups: ['meshmonitor-admins'], allowedGroups: [] });
    expect(r.isAdmin).toBe(true);
    expect(r.adminGroupsConfigured).toBe(true);
    expect(r.allowed).toBe(true);
  });

  it('admin groups configured but user not in them → not admin (demotion case)', () => {
    const r = resolveGroupRole(['users'], { adminGroups: ['admins'], allowedGroups: [] });
    expect(r.isAdmin).toBe(false);
    expect(r.adminGroupsConfigured).toBe(true);
  });

  it('allowed-groups gate: rejects a user in none of the allowed groups', () => {
    const r = resolveGroupRole(['guests'], { adminGroups: [], allowedGroups: ['meshmonitor-users'] });
    expect(r.allowed).toBe(false);
  });

  it('allowed-groups gate: accepts a user in an allowed group', () => {
    const r = resolveGroupRole(['meshmonitor-users'], { adminGroups: [], allowedGroups: ['meshmonitor-users'] });
    expect(r.allowed).toBe(true);
  });

  it('admins always pass the allowed-groups gate even if not in an allowed group', () => {
    const r = resolveGroupRole(['admins'], { adminGroups: ['admins'], allowedGroups: ['meshmonitor-users'] });
    expect(r.isAdmin).toBe(true);
    expect(r.allowed).toBe(true);
  });

  it('empty groups + allowed-groups set → denied (fail closed)', () => {
    const r = resolveGroupRole([], { adminGroups: ['admins'], allowedGroups: ['users'] });
    expect(r.allowed).toBe(false);
    expect(r.isAdmin).toBe(false);
  });
});
