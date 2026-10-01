/**
 * Translation Routes
 *
 * POST /api/translate       — Translate message text (requireAuth / messages:read)
 * POST /api/translate/test  — Test translation configuration (requireAdmin)
 * GET  /api/translate/languages — Get standard language list (public/optionalAuth)
 */
import express from 'express';
import { translationService, STANDARD_LANGUAGES, type TranslationProvider } from '../services/translation/translationService.js';
import { ok, fail } from '../utils/apiResponse.js';
import { requireAuth, requirePermission, requireAdmin } from '../auth/authMiddleware.js';
import { translateLimiter } from '../middleware/rateLimiters.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * Translate a message.
 */
router.post(
  '/',
  requireAuth(),
  requirePermission('messages', 'read'),
  translateLimiter,
  async (req, res) => {
    try {
      const { text, targetLang, sourceLang } = req.body || {};

      if (typeof text !== 'string') {
        return fail(res, 400, 'INVALID_INPUT', 'text must be a string');
      }

      const result = await translationService.translate({
        text,
        targetLang: typeof targetLang === 'string' ? targetLang : undefined,
        sourceLang: typeof sourceLang === 'string' ? sourceLang : undefined,
      });

      return ok(res, result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Translation error:', error);
      return fail(res, 500, 'TRANSLATION_FAILED', message || 'Failed to translate message');
    }
  }
);

/**
 * Test a translation configuration (used by settings UI).
 */
router.post('/test', requireAdmin(), translateLimiter, async (req, res) => {
  try {
    const { provider, url, apiKey, model, openAiBaseUrl, sourceLanguage, targetLanguage } = req.body || {};

    if (!provider || typeof provider !== 'string') {
      return fail(res, 400, 'INVALID_INPUT', 'provider is required');
    }

    const testText = 'MeshMonitor test message for radio translation.';
    const result = await translationService.translate({
      text: testText,
      provider: provider as TranslationProvider,
      url,
      apiKey,
      model,
      openAiBaseUrl,
      sourceLang: sourceLanguage || 'en',
      targetLang: targetLanguage || 'es',
    });

    return ok(res, {
      ...result,
      sampleSourceText: testText,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Translation test error:', error);
    return fail(res, 400, 'TRANSLATION_TEST_FAILED', message || 'Failed to test translation backend');
  }
});

/**
 * Get standard supported languages.
 */
router.get('/languages', (_req, res) => {
  return ok(res, STANDARD_LANGUAGES);
});

export default router;
