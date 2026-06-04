/**
 * Rate Limiters Middleware Tests
 *
 * Tests that the rate limiters respect the "unlimited" / disabled sentinel (0)
 * by using `skip: () => true`, and that normal positive limits still enforce.
 *
 * Because rateLimiters.ts reads getEnvironmentConfig() at module scope,
 * we use vi.resetModules() + dynamic imports to re-evaluate with different mocks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Mock dependencies before any import of rateLimiters
vi.mock('../config/environment.js');
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

async function createTestApp(envOverrides: Record<string, unknown>): Promise<Express> {
  // Reset module registry so rateLimiters re-evaluates with new mock
  vi.resetModules();

  // Re-mock after reset
  vi.doMock('../config/environment.js', () => ({
    getEnvironmentConfig: () => ({
      rateLimitApi: 10000,
      rateLimitApiProvided: false,
      rateLimitAuth: 100,
      rateLimitAuthProvided: false,
      rateLimitMessages: 100,
      rateLimitMessagesProvided: false,
      isProduction: false,
      trustProxyProvided: true,
      ...envOverrides,
    }),
  }));
  vi.doMock('../../utils/logger.js', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }));

  const { apiLimiter, authLimiter, messageLimiter } =
    await import('./rateLimiters.js');

  const app = express();
  app.use('/api', apiLimiter, (_req, res) => res.json({ ok: true }));
  app.use('/auth', authLimiter, (_req, res) => res.json({ ok: true }));
  app.use('/messages', messageLimiter, (_req, res) => res.json({ ok: true }));
  return app;
}

describe('Rate Limiters Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('When rate limits are set to 0 (disabled)', () => {
    it('should not throttle API requests when rateLimitApi is 0', async () => {
      const app = await createTestApp({
        rateLimitApi: 0,
        rateLimitApiProvided: true,
      });

      // All requests should succeed — no throttling
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/api');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      }
    });

    it('should not throttle auth requests when rateLimitAuth is 0', async () => {
      const app = await createTestApp({
        rateLimitAuth: 0,
        rateLimitAuthProvided: true,
      });

      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/auth');
        expect(res.status).toBe(200);
      }
    });

    it('should not throttle message requests when rateLimitMessages is 0', async () => {
      const app = await createTestApp({
        rateLimitMessages: 0,
        rateLimitMessagesProvided: true,
      });

      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/messages');
        expect(res.status).toBe(200);
      }
    });

    it('should allow all limiters disabled simultaneously', async () => {
      const app = await createTestApp({
        rateLimitApi: 0,
        rateLimitApiProvided: true,
        rateLimitAuth: 0,
        rateLimitAuthProvided: true,
        rateLimitMessages: 0,
        rateLimitMessagesProvided: true,
      });

      const apiRes = await request(app).get('/api');
      const authRes = await request(app).get('/auth');
      const msgRes = await request(app).get('/messages');

      expect(apiRes.status).toBe(200);
      expect(authRes.status).toBe(200);
      expect(msgRes.status).toBe(200);
    });
  });

  describe('When rate limits are set to a small positive value', () => {
    it('should enforce API rate limit after max requests exceeded from a public IP', async () => {
      const app = await createTestApp({
        rateLimitApi: 2,
        rateLimitApiProvided: true,
      });
      // Enable trust proxy so X-Forwarded-For is honoured, bypassing the private-IP exemption
      app.set('trust proxy', 1);

      const makeRequest = () => request(app).get('/api').set('X-Forwarded-For', '1.2.3.4');

      // First 2 should succeed
      expect((await makeRequest()).status).toBe(200);
      expect((await makeRequest()).status).toBe(200);

      // Third should be rate-limited
      const res = await makeRequest();
      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Too many requests');
    });

    it('should not throttle private/local network IPs regardless of limit', async () => {
      const app = await createTestApp({
        rateLimitApi: 2, // very tight limit
        rateLimitApiProvided: true,
      });

      // Supertest connects from 127.0.0.1 (loopback) — should always pass
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/api');
        expect(res.status).toBe(200);
      }
    });

    it('should enforce auth rate limit after max requests exceeded', async () => {
      // authLimiter has skipSuccessfulRequests: true, so successful (200)
      // responses don't count. We need the handler to return a non-2xx status
      // to trigger counting.
      vi.resetModules();
      vi.doMock('../config/environment.js', () => ({
        getEnvironmentConfig: () => ({
          rateLimitApi: 10000,
          rateLimitApiProvided: false,
          rateLimitAuth: 1,
          rateLimitAuthProvided: true,
          rateLimitMessages: 100,
          rateLimitMessagesProvided: false,
          isProduction: false,
          trustProxyProvided: true,
        }),
      }));
      vi.doMock('../../utils/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));

      const { authLimiter } = await import('./rateLimiters.js');
      const app = express();
      // Return 401 so the request counts against the rate limit
      app.use('/auth', authLimiter, (_req, res) => res.status(401).json({ error: 'bad creds' }));

      expect((await request(app).get('/auth')).status).toBe(401);

      const res = await request(app).get('/auth');
      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Too many login attempts');
    });

    it('should enforce message rate limit after max requests exceeded', async () => {
      const app = await createTestApp({
        rateLimitMessages: 1,
        rateLimitMessagesProvided: true,
      });

      expect((await request(app).get('/messages')).status).toBe(200);

      const res = await request(app).get('/messages');
      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Too many messages');
    });
  });

  describe('Mixed configuration', () => {
    it('should allow disabled API but enforce auth limits', async () => {
      // authLimiter has skipSuccessfulRequests: true, so we need 401 responses
      vi.resetModules();
      vi.doMock('../config/environment.js', () => ({
        getEnvironmentConfig: () => ({
          rateLimitApi: 0,
          rateLimitApiProvided: true,
          rateLimitAuth: 1,
          rateLimitAuthProvided: true,
          rateLimitMessages: 100,
          rateLimitMessagesProvided: false,
          isProduction: false,
          trustProxyProvided: true,
        }),
      }));
      vi.doMock('../../utils/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));

      const { apiLimiter, authLimiter } = await import('./rateLimiters.js');
      const app = express();
      app.use('/api', apiLimiter, (_req, res) => res.json({ ok: true }));
      app.use('/auth', authLimiter, (_req, res) => res.status(401).json({ error: 'bad creds' }));

      // API: unlimited — always 200
      expect((await request(app).get('/api')).status).toBe(200);
      expect((await request(app).get('/api')).status).toBe(200);
      expect((await request(app).get('/api')).status).toBe(200);

      // Auth: limit 1 — second request blocked (401 counts against the limit)
      expect((await request(app).get('/auth')).status).toBe(401);
      expect((await request(app).get('/auth')).status).toBe(429);
    });
  });

  describe('Startup logging', () => {
    it('should log "unlimited (disabled)" when rate limit is 0', async () => {
      vi.resetModules();
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      vi.doMock('../config/environment.js', () => ({
        getEnvironmentConfig: () => ({
          rateLimitApi: 0,
          rateLimitApiProvided: true,
          rateLimitAuth: 0,
          rateLimitAuthProvided: true,
          rateLimitMessages: 0,
          rateLimitMessagesProvided: true,
          isProduction: false,
          trustProxyProvided: true,
        }),
      }));
      vi.doMock('../../utils/logger.js', () => ({
        logger: mockLogger,
      }));

      await import('./rateLimiters.js');

      const infoCalls = mockLogger.info.mock.calls.map((c: unknown[]) => c[0]);
      expect(infoCalls).toContainEqual(
        expect.stringContaining('unlimited (disabled)')
      );

      // API, Auth, and Messages should all show disabled
      const disabledLogs = infoCalls.filter((msg: string) =>
        msg.includes('unlimited (disabled)')
      );
      expect(disabledLogs).toHaveLength(3);

      // Private-IP exemption line should always be logged
      expect(infoCalls).toContainEqual(
        expect.stringContaining('private/local network addresses: always exempt')
      );
    });

    it('should log normal values when rate limit is a positive number', async () => {
      vi.resetModules();
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      vi.doMock('../config/environment.js', () => ({
        getEnvironmentConfig: () => ({
          rateLimitApi: 500,
          rateLimitApiProvided: true,
          rateLimitAuth: 10,
          rateLimitAuthProvided: false,
          rateLimitMessages: 30,
          rateLimitMessagesProvided: false,
          isProduction: false,
          trustProxyProvided: true,
        }),
      }));
      vi.doMock('../../utils/logger.js', () => ({
        logger: mockLogger,
      }));

      await import('./rateLimiters.js');

      const infoCalls = mockLogger.info.mock.calls.map((c: unknown[]) => c[0]);
      expect(infoCalls).toContainEqual(
        expect.stringContaining('500 requests per 15 minutes')
      );
      expect(infoCalls).toContainEqual(
        expect.stringContaining('10 attempts per 15 minutes')
      );
      expect(infoCalls).toContainEqual(
        expect.stringContaining('30 messages per minute')
      );
    });
  });

  describe('isPrivateNetworkIp', () => {
    async function getIsPrivateNetworkIp() {
      vi.resetModules();
      vi.doMock('../config/environment.js', () => ({
        getEnvironmentConfig: () => ({
          rateLimitApi: 10000,
          rateLimitApiProvided: false,
          rateLimitAuth: 100,
          rateLimitAuthProvided: false,
          rateLimitMessages: 100,
          rateLimitMessagesProvided: false,
          isProduction: false,
          trustProxyProvided: true,
        }),
      }));
      vi.doMock('../../utils/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));
      const { isPrivateNetworkIp } = await import('./rateLimiters.js');
      return isPrivateNetworkIp;
    }

    it('should return true for IPv4 loopback', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('127.0.0.1')).toBe(true);
    });

    it('should return true for 10.x.x.x', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('10.0.0.1')).toBe(true);
      expect(fn('10.255.255.255')).toBe(true);
    });

    it('should return true for 192.168.x.x', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('192.168.1.100')).toBe(true);
      expect(fn('192.168.0.1')).toBe(true);
    });

    it('should return true for 172.16-31.x.x', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('172.16.0.1')).toBe(true);
      expect(fn('172.31.255.255')).toBe(true);
      expect(fn('172.20.10.5')).toBe(true);
    });

    it('should return false for public IPv4 addresses', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('1.2.3.4')).toBe(false);
      expect(fn('8.8.8.8')).toBe(false);
      expect(fn('172.15.0.1')).toBe(false);  // just outside 172.16/12
      expect(fn('172.32.0.1')).toBe(false);  // just outside 172.16/12
    });

    it('should return true for IPv6 loopback (::1)', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('::1')).toBe(true);
    });

    it('should return true for IPv6 ULA (fc/fd prefix)', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('fc00::1')).toBe(true);
      expect(fn('fd12:3456:789a::1')).toBe(true);
    });

    it('should return true for IPv4-mapped private addresses (::ffff:192.168.x.x)', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('::ffff:192.168.1.1')).toBe(true);
      expect(fn('::ffff:10.0.0.1')).toBe(true);
      expect(fn('::ffff:127.0.0.1')).toBe(true);
    });

    it('should return false for IPv4-mapped public addresses', async () => {
      const fn = await getIsPrivateNetworkIp();
      expect(fn('::ffff:1.2.3.4')).toBe(false);
      expect(fn('::ffff:8.8.8.8')).toBe(false);
    });
  });

  describe('normalizeRateLimitKey', () => {
    async function getNormalizeRateLimitKey() {
      vi.resetModules();
      vi.doMock('../config/environment.js', () => ({
        getEnvironmentConfig: () => ({
          rateLimitApi: 10000,
          rateLimitApiProvided: false,
          rateLimitAuth: 100,
          rateLimitAuthProvided: false,
          rateLimitMessages: 100,
          rateLimitMessagesProvided: false,
          isProduction: false,
          trustProxyProvided: true,
        }),
      }));
      vi.doMock('../../utils/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      }));
      const { normalizeRateLimitKey } = await import('./rateLimiters.js');
      return normalizeRateLimitKey;
    }

    it('should produce distinct keys for different IPv4-mapped IPv6 addresses', async () => {
      const normalize = await getNormalizeRateLimitKey();
      const key1 = normalize({ ip: '::ffff:192.168.1.100' });
      const key2 = normalize({ ip: '::ffff:10.0.0.1' });
      const key3 = normalize({ ip: '::ffff:172.18.0.1' });

      // The core bug: all three used to collapse to '::/56'
      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key2).not.toBe(key3);
    });

    it('should return the plain IPv4 address for mapped addresses', async () => {
      const normalize = await getNormalizeRateLimitKey();
      const key = normalize({ ip: '::ffff:192.168.1.100' });
      expect(key).toBe('192.168.1.100');
    });

    it('should pass through plain IPv4 addresses unchanged', async () => {
      const normalize = await getNormalizeRateLimitKey();
      const key = normalize({ ip: '192.168.1.100' });
      expect(key).toBe('192.168.1.100');
    });

    it('should apply /56 subnet masking to real IPv6 addresses', async () => {
      const normalize = await getNormalizeRateLimitKey();
      // Two addresses in the same /56 subnet should produce the same key
      const key1 = normalize({ ip: '2001:db8:85a3:0000:0000:0000:0000:0001' });
      const key2 = normalize({ ip: '2001:db8:85a3:0000:1111:2222:3333:4444' });
      expect(key1).toBe(key2);

      // An address in a different /56 subnet should produce a different key
      const key3 = normalize({ ip: '2001:db8:85a4:0100:0000:0000:0000:0001' });
      expect(key1).not.toBe(key3);
    });

    it('should handle undefined ip gracefully', async () => {
      const normalize = await getNormalizeRateLimitKey();
      const key = normalize({ ip: undefined });
      expect(key).toBe('');
    });

    it('should handle empty ip gracefully', async () => {
      const normalize = await getNormalizeRateLimitKey();
      const key = normalize({ ip: '' });
      expect(key).toBe('');
    });
  });
});
