/**
 * Proxy Authentication Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { extractProxyUser, isAdminUser, isNormalProxyUserAllowed, normalizeGroups } from './proxyAuth.js';
import { Request } from 'express';

// Mock environment config
let mockConfig = {
  proxyAuthEnabled: false,
  proxyAuthAdminGroups: [] as string[],
  proxyAuthAdminEmails: [] as string[],
  proxyAuthNormalUserGroups: [] as string[],
  proxyAuthJwtGroupsClaim: 'groups',
  proxyAuthHeaderEmail: undefined as string | undefined,
  proxyAuthHeaderGroups: undefined as string | undefined
};

// Mock getEnvironmentConfig
vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: () => mockConfig
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

describe('proxyAuth', () => {
  beforeEach(() => {
    mockConfig = {
      proxyAuthEnabled: true,
      proxyAuthAdminGroups: [],
      proxyAuthAdminEmails: [],
      proxyAuthNormalUserGroups: [],
      proxyAuthJwtGroupsClaim: 'groups',
      proxyAuthHeaderEmail: undefined,
      proxyAuthHeaderGroups: undefined
    };
  });

  describe('normalizeGroups', () => {
    it('should return empty array for null/undefined', () => {
      expect(normalizeGroups(null)).toEqual([]);
      expect(normalizeGroups(undefined)).toEqual([]);
    });

    it('should wrap a single string in an array', () => {
      expect(normalizeGroups('admin')).toEqual(['admin']);
    });

    it('should return empty array for empty string', () => {
      expect(normalizeGroups('')).toEqual([]);
      expect(normalizeGroups('  ')).toEqual([]);
    });

    it('should pass through string arrays', () => {
      expect(normalizeGroups(['admin', 'users'])).toEqual(['admin', 'users']);
    });

    it('should extract name from role objects', () => {
      expect(normalizeGroups([{ name: 'admin-role' }, { name: 'user-role' }]))
        .toEqual(['admin-role', 'user-role']);
    });

    it('should handle mixed arrays of strings and objects', () => {
      expect(normalizeGroups(['plain-string', { name: 'object-role' }]))
        .toEqual(['plain-string', 'object-role']);
    });

    it('should skip entries without name property', () => {
      expect(normalizeGroups([{ id: 1 }, { name: 'valid' }]))
        .toEqual(['valid']);
    });

    it('should trim whitespace from entries', () => {
      expect(normalizeGroups(['  admin  ', { name: '  user  ' }]))
        .toEqual(['admin', 'user']);
    });

    it('should filter out empty names', () => {
      expect(normalizeGroups(['', { name: '' }, 'valid']))
        .toEqual(['valid']);
    });

    it('should return empty array for non-array non-string input', () => {
      expect(normalizeGroups(42)).toEqual([]);
      expect(normalizeGroups(true)).toEqual([]);
      expect(normalizeGroups({})).toEqual([]);
    });
  });

  describe('extractProxyUser', () => {
    it('should return null when proxy auth is disabled', () => {
      mockConfig.proxyAuthEnabled = false;

      const req = {
        headers: {
          'x-auth-request-email': 'user@example.com'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toBeNull();
    });

    it('should extract user from Cloudflare Access JWT', () => {
      const payload = { email: 'alice@example.com', groups: ['users'] };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const fakeJwt = `header.${encodedPayload}.signature`;

      const req = {
        headers: {
          'cf-access-jwt-assertion': fakeJwt
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'alice@example.com',
        groups: ['users'],
        source: 'cloudflare'
      });
    });

    it('should extract nested groups claim from JWT', () => {
      const payload = {
        email: 'bob@example.com',
        'https://mydomain.com/roles': ['admin', 'user']
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const fakeJwt = `header.${encodedPayload}.signature`;

      mockConfig.proxyAuthJwtGroupsClaim = 'https://mydomain.com/roles';

      const req = {
        headers: {
          'cf-access-jwt-assertion': fakeJwt
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'bob@example.com',
        groups: ['admin', 'user'],
        source: 'cloudflare'
      });
    });

    it('should read URL-style groups claim from Cloudflare custom object', () => {
      const payload = {
        email: 'cf@example.com',
        custom: {
          'https://example.com/roles': ['admins', 'mesh-users']
        }
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const fakeJwt = `header.${encodedPayload}.signature`;

      mockConfig.proxyAuthJwtGroupsClaim = 'https://example.com/roles';

      const req = {
        headers: {
          'cf-access-jwt-assertion': fakeJwt
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'cf@example.com',
        groups: ['admins', 'mesh-users'],
        source: 'cloudflare'
      });
    });

    it('should prefer top-level URL claim over custom when both exist', () => {
      const payload = {
        email: 'both@example.com',
        'https://example.com/roles': ['top-level'],
        custom: {
          'https://example.com/roles': ['from-custom']
        }
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const fakeJwt = `header.${encodedPayload}.signature`;

      mockConfig.proxyAuthJwtGroupsClaim = 'https://example.com/roles';

      const req = {
        headers: {
          'cf-access-jwt-assertion': fakeJwt
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result?.groups).toEqual(['top-level']);
    });

    it('should normalize Auth0-style role objects from JWT', () => {
      const payload = {
        email: 'auth0user@example.com',
        'https://mydomain.com/roles': [
          { id: 'rol_abc', name: 'admins', description: 'Admin role' },
          { id: 'rol_def', name: 'users', description: 'User role' }
        ]
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const fakeJwt = `header.${encodedPayload}.signature`;

      mockConfig.proxyAuthJwtGroupsClaim = 'https://mydomain.com/roles';

      const req = {
        headers: {
          'cf-access-jwt-assertion': fakeJwt
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'auth0user@example.com',
        groups: ['admins', 'users'],
        source: 'cloudflare'
      });
    });

    it('should handle JWT with missing groups claim', () => {
      const payload = { email: 'nogroupuser@example.com' };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const fakeJwt = `header.${encodedPayload}.signature`;

      mockConfig.proxyAuthJwtGroupsClaim = 'https://mydomain.com/roles';

      const req = {
        headers: {
          'cf-access-jwt-assertion': fakeJwt
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'nogroupuser@example.com',
        groups: [],
        source: 'cloudflare'
      });
    });

    it('should handle JWT with single string groups claim', () => {
      const payload = {
        email: 'singlegroup@example.com',
        'https://mydomain.com/roles': 'admin-role'
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const fakeJwt = `header.${encodedPayload}.signature`;

      mockConfig.proxyAuthJwtGroupsClaim = 'https://mydomain.com/roles';

      const req = {
        headers: {
          'cf-access-jwt-assertion': fakeJwt
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'singlegroup@example.com',
        groups: ['admin-role'],
        source: 'cloudflare'
      });
    });

    it('should extract user from oauth2-proxy headers', () => {
      const req = {
        headers: {
          'x-auth-request-email': 'charlie@example.com',
          'x-auth-request-groups': 'admins,users'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'charlie@example.com',
        groups: ['admins', 'users'],
        source: 'oauth2-proxy'
      });
    });

    it('should extract user from oauth2-proxy with no groups', () => {
      const req = {
        headers: {
          'x-auth-request-email': 'dave@example.com'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'dave@example.com',
        groups: [],
        source: 'oauth2-proxy'
      });
    });

    it('should extract user from generic proxy with default headers', () => {
      const req = {
        headers: {
          'remote-user': 'eve@example.com',
          'remote-groups': 'group1,group2,group3'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'eve@example.com',
        groups: ['group1', 'group2', 'group3'],
        source: 'generic'
      });
    });

    it('should extract user from generic proxy with custom headers', () => {
      mockConfig.proxyAuthHeaderEmail = 'X-Custom-User';
      mockConfig.proxyAuthHeaderGroups = 'X-Custom-Groups';

      const req = {
        headers: {
          'x-custom-user': 'frank@example.com',
          'x-custom-groups': 'developers,testers'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'frank@example.com',
        groups: ['developers', 'testers'],
        source: 'generic'
      });
    });

    it('should be case-insensitive for header names', () => {
      const req = {
        headers: {
          'X-AUTH-REQUEST-EMAIL': 'george@example.com',
          'X-Auth-Request-Groups': 'admins'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toEqual({
        email: 'george@example.com',
        groups: ['admins'],
        source: 'oauth2-proxy'
      });
    });

    it('should prioritize Cloudflare JWT over oauth2-proxy', () => {
      const payload = { email: 'cloudflare@example.com', groups: [] };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const fakeJwt = `header.${encodedPayload}.signature`;

      const req = {
        headers: {
          'cf-access-jwt-assertion': fakeJwt,
          'x-auth-request-email': 'oauth2@example.com'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result?.email).toBe('cloudflare@example.com');
      expect(result?.source).toBe('cloudflare');
    });

    it('should prioritize oauth2-proxy over generic', () => {
      const req = {
        headers: {
          'x-auth-request-email': 'oauth2@example.com',
          'remote-user': 'generic@example.com'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result?.email).toBe('oauth2@example.com');
      expect(result?.source).toBe('oauth2-proxy');
    });

    it('should handle whitespace in group lists', () => {
      const req = {
        headers: {
          'x-auth-request-email': 'test@example.com',
          'x-auth-request-groups': ' admin , users , developers '
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result?.groups).toEqual(['admin', 'users', 'developers']);
    });

    it('should handle empty group strings', () => {
      const req = {
        headers: {
          'x-auth-request-email': 'test@example.com',
          'x-auth-request-groups': ',,,'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result?.groups).toEqual([]);
    });

    it('should return null for invalid JWT format', () => {
      const req = {
        headers: {
          'cf-access-jwt-assertion': 'not.a.valid.jwt.too.many.parts'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toBeNull();
    });

    it('should return null when no proxy headers present', () => {
      const req = {
        headers: {
          'user-agent': 'Mozilla/5.0'
        }
      } as Request;

      const result = extractProxyUser(req);
      expect(result).toBeNull();
    });
  });

  describe('isAdminUser', () => {
    it('should return true if user has admin group', () => {
      mockConfig.proxyAuthAdminGroups = ['admins', 'mesh-admins'];

      const result = isAdminUser('user@example.com', ['users', 'admins']);
      expect(result).toBe(true);
    });

    it('should return false if user has no admin groups', () => {
      mockConfig.proxyAuthAdminGroups = ['admins', 'mesh-admins'];

      const result = isAdminUser('user@example.com', ['users', 'developers']);
      expect(result).toBe(false);
    });

    it('should return true if user email is in admin list', () => {
      mockConfig.proxyAuthAdminEmails = ['admin@example.com', 'superuser@example.com'];

      const result = isAdminUser('admin@example.com', []);
      expect(result).toBe(true);
    });

    it('should be case-insensitive for email matching', () => {
      mockConfig.proxyAuthAdminEmails = ['admin@example.com'];

      const result = isAdminUser('ADMIN@EXAMPLE.COM', []);
      expect(result).toBe(true);
    });

    it('should be case-insensitive for group matching', () => {
      mockConfig.proxyAuthAdminGroups = ['Admins'];

      expect(isAdminUser('user@example.com', ['admins'])).toBe(true);
      expect(isAdminUser('user@example.com', ['ADMINS'])).toBe(true);
      expect(isAdminUser('user@example.com', ['Admins'])).toBe(true);
    });

    it('should prioritize group-based admin over email', () => {
      mockConfig.proxyAuthAdminGroups = ['admins'];
      mockConfig.proxyAuthAdminEmails = ['other@example.com'];

      const result = isAdminUser('user@example.com', ['admins']);
      expect(result).toBe(true);
    });

    it('should return false if no admin groups or emails configured', () => {
      mockConfig.proxyAuthAdminGroups = [];
      mockConfig.proxyAuthAdminEmails = [];

      const result = isAdminUser('user@example.com', ['users']);
      expect(result).toBe(false);
    });

    it('should return false if user has no groups and not in email list', () => {
      mockConfig.proxyAuthAdminGroups = ['admins'];
      mockConfig.proxyAuthAdminEmails = ['admin@example.com'];

      const result = isAdminUser('user@example.com', []);
      expect(result).toBe(false);
    });

    it('should handle multiple group matches', () => {
      mockConfig.proxyAuthAdminGroups = ['admins', 'mesh-admins', 'superusers'];

      const result = isAdminUser('user@example.com', ['users', 'mesh-admins', 'developers']);
      expect(result).toBe(true);
    });
  });

  describe('isNormalProxyUserAllowed', () => {
    it('should return true when no normal-user groups are configured (open gate)', () => {
      mockConfig.proxyAuthNormalUserGroups = [];

      const result = isNormalProxyUserAllowed('anyone@example.com', []);
      expect(result).toBe(true);
    });

    it('should return true for admin users even without matching normal group', () => {
      mockConfig.proxyAuthNormalUserGroups = ['meshmonitor-users'];
      mockConfig.proxyAuthAdminGroups = ['admins'];

      const result = isNormalProxyUserAllowed('admin@example.com', ['admins']);
      expect(result).toBe(true);
    });

    it('should return true for admin by email even without matching normal group', () => {
      mockConfig.proxyAuthNormalUserGroups = ['meshmonitor-users'];
      mockConfig.proxyAuthAdminEmails = ['boss@example.com'];

      const result = isNormalProxyUserAllowed('boss@example.com', []);
      expect(result).toBe(true);
    });

    it('should return true when user has a matching normal-user group', () => {
      mockConfig.proxyAuthNormalUserGroups = ['meshmonitor-users', 'mesh-operators'];

      const result = isNormalProxyUserAllowed('user@example.com', ['meshmonitor-users']);
      expect(result).toBe(true);
    });

    it('should return false when user lacks matching normal-user group', () => {
      mockConfig.proxyAuthNormalUserGroups = ['meshmonitor-users'];

      const result = isNormalProxyUserAllowed('outsider@example.com', ['some-other-group']);
      expect(result).toBe(false);
    });

    it('should return false when user has no groups and gate is configured', () => {
      mockConfig.proxyAuthNormalUserGroups = ['meshmonitor-users'];

      const result = isNormalProxyUserAllowed('outsider@example.com', []);
      expect(result).toBe(false);
    });

    it('should be case-insensitive for normal-user group matching', () => {
      mockConfig.proxyAuthNormalUserGroups = ['MeshMonitor-Users'];

      expect(isNormalProxyUserAllowed('user@example.com', ['meshmonitor-users'])).toBe(true);
      expect(isNormalProxyUserAllowed('user@example.com', ['MESHMONITOR-USERS'])).toBe(true);
    });
  });
});
