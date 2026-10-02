import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import translationRoutes from './translationRoutes.js';
import v1TranslateRoutes from './v1/translate.js';

vi.mock('../services/translation/translationService.js', () => ({
  translationService: {
    translate: vi.fn().mockResolvedValue({
      translatedText: 'Hola',
      sourceText: 'Hello',
      targetLanguage: 'es',
      provider: 'libretranslate',
    }),
    testConfig: vi.fn().mockResolvedValue({
      translatedText: 'Hola test',
      sourceText: 'Hello test',
      targetLanguage: 'es',
      provider: 'libretranslate',
    }),
    getLanguages: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn(),
  },
  isNonConversational: vi.fn().mockReturnValue(false),
  STANDARD_LANGUAGES: [],
}));

vi.mock('../middleware/rateLimiters.js', () => ({
  translateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe('Translation Routes — Authentication & Permissions', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/translate', translationRoutes);
        app.use('/api/v1/translate', v1TranslateRoutes);
      },
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('POST /api/translate', () => {
    it('should reject unauthenticated / anonymous user with 401', async () => {
      const res = await request(harness.app).post('/api/translate').send({
        text: 'Hello',
        targetLang: 'es',
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('should reject authenticated user without messages:read permission with 403', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/translate').send({
        text: 'Hello',
        targetLang: 'es',
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('should allow authenticated user with messages:read permission with 200', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/translate').send({
        text: 'Hello',
        targetLang: 'es',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.translatedText).toBe('Hola');
    });

    it('should allow admin user with 200', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/translate').send({
        text: 'Hello',
        targetLang: 'es',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/v1/translate', () => {
    it('should reject unauthenticated / anonymous user without permissions with 403', async () => {
      const res = await request(harness.app).post('/api/v1/translate').send({
        text: 'Hello',
        targetLang: 'es',
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('should reject authenticated user without messages:read permission with 403', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/v1/translate').send({
        text: 'Hello',
        targetLang: 'es',
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('should allow authenticated user with messages:read permission with 200', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/v1/translate').send({
        text: 'Hello',
        targetLang: 'es',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/translate/test', () => {
    it('should reject unauthenticated / anonymous user with 401', async () => {
      const res = await request(harness.app).post('/api/translate/test').send({
        provider: 'libretranslate',
        url: 'http://localhost:5000',
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('should reject non-admin authenticated user with 403', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/translate/test').send({
        provider: 'libretranslate',
        url: 'http://localhost:5000',
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ADMIN');
    });


    it('should allow admin user to test configuration with 200', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/translate/test').send({
        provider: 'libretranslate',
        url: 'http://localhost:5000',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.translatedText).toBe('Hola test');
    });
  });
});
