/**
 * Translation Routes
 *
 * POST /api/translate          — Translate message text (requireAuth / messages:read)
 * GET  /api/translate/stored   — Stored translations for visible messages (optionalAuth; no provider call)
 * POST /api/translate/test     — Test translation configuration (requireAdmin)
 * GET  /api/translate/languages — Get standard language list (public/optionalAuth)
 *
 * The router is mounted behind `optionalAuth()` and the global `apiLimiter`
 * (server.ts), so anonymous callers reach `/stored` as the `anonymous` user
 * and every read is rate limited without a second limiter here.
 */
import express from 'express';
import {
  translationService,
  STANDARD_LANGUAGES,
  type TestTranslationConfig,
} from '../services/translation/translationService.js';
import {
  TranslationConfigError,
  getTranslationProviderFields,
  isTranslationProvider,
} from '../../types/translationProviders.js';
import { isValidLangCode, normalizeTargetLang } from '../services/translation/cacheKey.js';
import databaseService from '../../services/database.js';
import type { DbMessage } from '../../db/types.js';
import { resolveMessageReadAccess, type MessageReadAccess } from '../utils/messageReadAccess.js';
import { ok, fail } from '../utils/apiResponse.js';
import { requireAuth, requirePermission, requireAdmin } from '../auth/authMiddleware.js';
import { translateLimiter } from '../middleware/rateLimiters.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/** Max message ids per `GET /stored` call. */
export const MAX_STORED_TRANSLATION_IDS = 200;
/** Matches `messages.id` (MySQL VARCHAR(64)). */
const MAX_MESSAGE_ID_LEN = 64;
const MAX_SOURCE_ID_LEN = 64;

function isNonEmptyString(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen;
}

/**
 * Load the messages with `ids` on `sourceId` that the caller may read, using the
 * SAME predicate as the message-list endpoints (`GET /api/messages`, via
 * `resolveMessageReadAccess`): DMs need `messages:read`, virtual channels
 * their per-entry `canRead`, physical channels `channel_0:read` +
 * `channel_N:read`, all scoped to `sourceId`. Missing and hidden ids are
 * indistinguishable to the caller.
 */
async function loadReadableMessages(
  access: MessageReadAccess,
  sourceId: string,
  ids: string[],
): Promise<DbMessage[]> {
  if (!access.canReadAny || ids.length === 0) return [];
  const rows = await databaseService.messages.getMessagesByIdsInSource(sourceId, ids);
  return rows.filter((msg) => access.canReadChannel(Number(msg.channel)));
}

/**
 * Translate a message.
 *
 * With `{ sourceId, messageId }` the STORED message text is translated (any
 * client `text` is ignored, which closes off cache poisoning), through the
 * shared cache, and the result is linked to the message so other viewers see
 * it. A message the caller cannot read is a 404 with no provider call.
 *
 * Without them (the composer, free text) the text is translated directly:
 * no cache read or write and no link.
 */
router.post(
  '/',
  requireAuth(),
  requirePermission('messages', 'read'),
  translateLimiter,
  async (req, res) => {
    try {
      const { text, targetLang, sourceLang, sourceId, messageId } = req.body || {};
      const target = typeof targetLang === 'string' && targetLang ? targetLang : undefined;
      const source = typeof sourceLang === 'string' && sourceLang ? sourceLang : undefined;

      if (sourceId !== undefined || messageId !== undefined) {
        if (!isNonEmptyString(sourceId, MAX_SOURCE_ID_LEN) || !isNonEmptyString(messageId, MAX_MESSAGE_ID_LEN)) {
          return fail(res, 400, 'INVALID_INPUT', 'sourceId and messageId must both be non-empty strings');
        }
        if (target !== undefined && !isValidLangCode(target)) {
          return fail(res, 400, 'INVALID_INPUT', 'targetLang is not a valid language code');
        }
        if (source !== undefined && source !== 'auto' && !isValidLangCode(source)) {
          return fail(res, 400, 'INVALID_INPUT', 'sourceLang is not a valid language code');
        }

        const access = await resolveMessageReadAccess(req.user, sourceId);
        const [message] = await loadReadableMessages(access, sourceId, [messageId]);
        if (!message) {
          return fail(res, 404, 'NOT_FOUND', 'Message not found');
        }

        const result = await translationService.translateMessage({
          sourceId,
          messageId,
          text: message.text,
          targetLang: target,
          sourceLang: source,
        });
        return ok(res, result);
      }

      if (typeof text !== 'string') {
        return fail(res, 400, 'INVALID_INPUT', 'text must be a string');
      }

      const result = await translationService.translate({
        text,
        targetLang: target,
        sourceLang: source,
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
 * Stored translations for messages the viewer can read.
 *
 * `GET /api/translate/stored?sourceId=…&lang=…&messageIds=a,b,c`
 * → `{ success: true, data: { [messageId]: { translatedText, detectedSourceLanguage, provider } } }`
 *
 * Read-only: never calls a provider and never accepts text. Each id goes
 * through the message-list visibility check; ids that are missing, hidden or
 * untranslated are silently omitted (no existence oracle). Anonymous viewers
 * resolve through the `anonymous` user's permissions like any other read.
 */
router.get('/stored', async (req, res) => {
  try {
    const { sourceId, lang, messageIds } = req.query;
    if (!isNonEmptyString(sourceId, MAX_SOURCE_ID_LEN)) {
      return fail(res, 400, 'INVALID_INPUT', 'sourceId is required');
    }
    if (!isValidLangCode(lang)) {
      return fail(res, 400, 'INVALID_INPUT', 'lang must be a valid language code');
    }
    if (typeof messageIds !== 'string') {
      return fail(res, 400, 'INVALID_INPUT', 'messageIds is required');
    }
    const ids = [...new Set(messageIds.split(',').map((id) => id.trim()).filter(Boolean))];
    if (ids.length > MAX_STORED_TRANSLATION_IDS) {
      return fail(res, 400, 'INVALID_INPUT', `At most ${MAX_STORED_TRANSLATION_IDS} messageIds per request`);
    }
    if (ids.some((id) => id.length > MAX_MESSAGE_ID_LEN)) {
      return fail(res, 400, 'INVALID_INPUT', 'messageId too long');
    }

    const settings = await translationService.getSettings();
    if (!settings.enabled) {
      return fail(res, 403, 'TRANSLATION_DISABLED', 'Translation is not enabled');
    }

    const access = await resolveMessageReadAccess(req.user, sourceId);
    if (!access.canReadAny) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const data: Record<string, { translatedText: string; detectedSourceLanguage: string | null; provider: string }> = {};
    if (ids.length === 0) return ok(res, data);

    const stored = await databaseService.translations.getStoredTranslations(sourceId, ids, normalizeTargetLang(lang));
    if (stored.length === 0) return ok(res, data);

    // Visibility is checked only for ids that actually have a translation,
    // and against the live message row, so a link whose message was deleted
    // is never served.
    const readable = await loadReadableMessages(access, sourceId, stored.map((s) => s.messageId));
    const readableIds = new Set(readable.map((m) => m.id));
    for (const row of stored) {
      if (!readableIds.has(row.messageId)) continue;
      data[row.messageId] = {
        translatedText: row.translatedText,
        detectedSourceLanguage: row.detectedSourceLanguage,
        provider: row.provider,
      };
    }
    return ok(res, data);
  } catch (error: unknown) {
    logger.error('Stored translation lookup error:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to load stored translations');
  }
});

/**
 * Test a translation configuration (used by settings UI).
 */
router.post('/test', requireAdmin(), translateLimiter, async (req, res) => {
  try {
    const body: Record<string, unknown> = req.body && typeof req.body === 'object' ? req.body : {};
    const { provider, sourceLanguage, targetLanguage } = body;

    if (!provider || typeof provider !== 'string') {
      return fail(res, 400, 'INVALID_INPUT', 'provider is required');
    }
    if (!isTranslationProvider(provider)) {
      return fail(res, 400, 'INVALID_INPUT', 'provider is not a supported translation provider');
    }
    for (const key of ['sourceLanguage', 'targetLanguage'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'string') {
        return fail(res, 400, 'INVALID_INPUT', `${key} must be a string`);
      }
    }

    // Take ONLY the tested provider's own fields from the request (#5518). A
    // field the request omits falls back to that provider's stored setting
    // inside testConfig; a key that belongs to another provider is dropped.
    const config: TestTranslationConfig = {
      provider,
      sourceLanguage: sourceLanguage as string | undefined,
      targetLanguage: targetLanguage as string | undefined,
    };
    for (const field of getTranslationProviderFields(provider)) {
      const value = body[field.configKey];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        return fail(res, 400, 'INVALID_INPUT', `${field.configKey} must be a string`);
      }
      config[field.configKey] = value;
    }

    // The result carries the translated sample only — never the config.
    const result = await translationService.testConfig(config);

    return ok(res, result);

  } catch (error: unknown) {
    if (error instanceof TranslationConfigError) {
      return fail(res, 400, 'TRANSLATION_CONFIG_INCOMPLETE', error.message, {
        missingFields: error.missingFields,
      });
    }
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
