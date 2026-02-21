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
    it('should enforce API rate limit after max requests exceeded', async () => {
      const app = await createTestApp({
        rateLimitApi: 2,
        rateLimitApiProvided: true,
      });

      // First 2 should succeed
      expect((await request(app).get('/api')).status).toBe(200);
      expect((await request(app).get('/api')).status).toBe(200);

      // Third should be rate-limited
      const res = await request(app).get('/api');
      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Too many requests');
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

      // All three should show disabled
      const disabledLogs = infoCalls.filter((msg: string) =>
        msg.includes('unlimited (disabled)')
      );
      expect(disabledLogs).toHaveLength(3);
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
});
