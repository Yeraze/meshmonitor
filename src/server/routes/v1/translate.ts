/**
 * v1 Translation Routes
 *
 * POST /api/v1/translate — translate message text using configured backend
 */
import express from 'express';
import { translationService } from '../../services/translation/translationService.js';
import { ok, fail } from '../../utils/apiResponse.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

router.post('/', async (req, res) => {
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
    logger.error('v1 translation error:', error);
    return fail(res, 500, 'TRANSLATION_FAILED', message || 'Failed to translate message');
  }
});

export default router;
