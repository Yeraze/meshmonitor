import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import translationRoutes from './translationRoutes.js';
import v1TranslateRoutes from './v1/translate.js';
import { translationService } from '../services/translation/translationService.js';

vi.mock('../services/translation/translationService.js', () => ({
  translationService: {
    translate: vi.fn(),
    testConfig: vi.fn(),
    getLanguages: vi.fn(),
    getSettings: vi.fn(),
  },
  isNonConversational: vi.fn().mockReturnValue(false),
  STANDARD_LANGUAGES: [
    { code: 'en', name: 'English' },
    { code: 'ja', name: 'Japanese' },
    { code: 'es', name: 'Spanish' },
  ],
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  requireAdmin: () => (_req: any, _res: any, next: any) => next(),
  optionalAuth: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middleware/rateLimiters.js', () => ({
  translateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe('translationRoutes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/translate', translationRoutes);
    app.use('/api/v1/translate', v1TranslateRoutes);
  });

  describe('POST /api/translate', () => {
    it('should reject missing text parameter', async () => {
      const res = await request(app)
        .post('/api/translate')
        .send({ targetLang: 'es' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('text must be a string');
    });

    it('should successfully translate text', async () => {
      vi.mocked(translationService.translate).mockResolvedValue({
        translatedText: 'Hola mundo',
        detectedSourceLanguage: 'en',
        sourceText: 'Hello world',
        targetLanguage: 'es',
        provider: 'libretranslate',
      });

      const res = await request(app)
        .post('/api/translate')
        .send({ text: 'Hello world', targetLang: 'es' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.translatedText).toBe('Hola mundo');
      expect(res.body.data.targetLanguage).toBe('es');
      expect(res.body.data.detectedSourceLanguage).toBe('en');
    });

    it('should handle service errors gracefully', async () => {
      vi.mocked(translationService.translate).mockRejectedValue(
        new Error('Translation service unavailable')
      );

      const res = await request(app)
        .post('/api/translate')
        .send({ text: 'Hello world', targetLang: 'es' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Translation service unavailable');
    });
  });

  describe('POST /api/v1/translate', () => {
    it('should reject missing or non-string text parameter', async () => {
      const res = await request(app)
        .post('/api/v1/translate')
        .send({ targetLang: 'es' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('text must be a string');
    });

    it('should translate through v1 endpoint', async () => {
      vi.mocked(translationService.translate).mockResolvedValue({
        translatedText: 'Bonjour',
        detectedSourceLanguage: 'en',
        sourceText: 'Hello',
        targetLanguage: 'fr',
        provider: 'deepl',
      });

      const res = await request(app)
        .post('/api/v1/translate')
        .send({ text: 'Hello', targetLang: 'fr' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.translatedText).toBe('Bonjour');
    });

    it('should handle service errors gracefully', async () => {
      vi.mocked(translationService.translate).mockRejectedValue(
        new Error('v1 translation backend failed')
      );

      const res = await request(app)
        .post('/api/v1/translate')
        .send({ text: 'Hello', targetLang: 'fr' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('v1 translation backend failed');
    });
  });

  describe('POST /api/translate/test', () => {
    it('should reject missing provider', async () => {
      const res = await request(app)
        .post('/api/translate/test')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('provider is required');
    });

    it('should reject non-string provider', async () => {
      const res = await request(app)
        .post('/api/translate/test')
        .send({ provider: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('provider is required');
    });

    it('should test configuration successfully', async () => {
      vi.mocked(translationService.testConfig).mockResolvedValue({
        translatedText: 'Hola',
        detectedSourceLanguage: 'en',
        sourceText: 'MeshMonitor test message for radio translation.',
        targetLanguage: 'es',
        provider: 'libretranslate',
      });

      const res = await request(app)
        .post('/api/translate/test')
        .send({
          provider: 'libretranslate',
          url: 'http://libretranslate:5000',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.translatedText).toBe('Hola');
      expect(translationService.testConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'libretranslate',
          url: 'http://libretranslate:5000',
        })
      );
    });

    it('should handle test configuration failures gracefully', async () => {
      vi.mocked(translationService.testConfig).mockRejectedValue(
        new Error('DeepL API error (403): Forbidden')
      );

      const res = await request(app)
        .post('/api/translate/test')
        .send({
          provider: 'deepl',
          apiKey: 'invalid-key',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('DeepL API error (403): Forbidden');
    });
  });


  describe('GET /api/translate/languages', () => {
    it('should return available languages', async () => {
      const res = await request(app).get('/api/translate/languages');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(3);
      expect(res.body.data[0].code).toBe('en');
    });
  });
});
