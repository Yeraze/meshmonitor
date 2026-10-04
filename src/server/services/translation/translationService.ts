/**
 * Translation Service
 *
 * Handles chat message translation orchestration using configurable providers:
 * - LibreTranslate (Self-hosted or hosted)
 * - OpenAI-Compatible Endpoints (Ollama, OpenRouter, OpenAI, etc.)
 * - DeepL (Free / Pro API)
 * - Google Cloud Translation API
 *
 * Integrates with ITranslationCache abstraction (NoOpTranslationCache by default).
 */

import databaseService from '../../../services/database.js';
import { isEmoji } from '../../../utils/text.js';
import { getTranslationCache } from './translationCache.js';
import { computeTranslationCacheKey, normalizeTargetLang } from './cacheKey.js';
import { logger } from '../../../utils/logger.js';
import { STANDARD_LANGUAGES, type TranslationLanguageOption } from '../../../types/translation.js';
import type { TranslationProvider } from '../../../types/translation.js';
import {
  DEFAULT_TRANSLATION_PROVIDER,
  buildTranslationProviderConfig,
  getTranslationProviderFields,
  isTranslationProvider,
  missingRequiredTranslationFields,
  TranslationConfigError,
  type TranslationProviderSettingKey,
} from '../../../types/translationProviders.js';
import {
  getTranslationProvider,
  buildServiceEndpoint,
  type ProviderConfig,
} from './providers/index.js';

export type { TranslationProvider };
export { TranslationConfigError };

export interface TranslationRequest {
  text: string;
  targetLang?: string;
  sourceLang?: string;
}

export type TranslationOptions = TranslationRequest;

export interface TranslateCallOptions {
  /**
   * Read and write the shared text cache. Off by default: only translations
   * of a STORED message (`translateMessage`) use the cache. Free text (the
   * composer, `/api/v1/translate`) bypasses it in both directions, so a
   * client can never probe whether a phrase was translated before (#5520 —
   * the cache is server-internal), and composer drafts never enter it.
   */
  useCache?: boolean;
}

export interface TranslateMessageRequest {
  sourceId: string;
  messageId: string;
  /** The STORED message text, loaded server-side — never client-supplied. */
  text: string;
  targetLang?: string;
  sourceLang?: string;
}

/**
 * A test-connection request. The provider fields are the tested provider's
 * `configKey`s; a field left `undefined` falls back to that provider's STORED
 * setting, and a field sent as a string (even blank) is used as sent.
 */
export interface TestTranslationConfig extends ProviderConfig {
  provider: TranslationProvider;
  sourceLanguage?: string;
  targetLanguage?: string;
  text?: string;
}

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
  sourceText: string;
  targetLanguage: string;
  cached?: boolean;
  provider: string;
  skipped?: boolean;
  skipReason?: string;
}

export type LanguageOption = TranslationLanguageOption;
export { STANDARD_LANGUAGES, buildServiceEndpoint };

/**
 * Filter out raw telemetry packets, standard radio tests, and emoji-only messages
 * to avoid unnecessary API calls and weird translation artifacts.
 */
export function isNonConversational(text: string): boolean {
  if (!text || !text.trim()) {
    return true;
  }

  const trimmed = text.trim();

  // Emoji only
  if (isEmoji(trimmed)) {
    return true;
  }

  // Standard radio / LoRa test words (case-insensitive, with optional trailing punctuation)
  const cleaned = trimmed.replace(/[!?.#]+$/, '');
  const radioPings = /^(?:ack|ping|pong|73|73s|test|testing|k|ok|cq|sos|rgr|roger|qsl)$/i;
  if (radioPings.test(cleaned)) {
    return true;
  }

  // JSON or raw telemetry structure (or arrays)
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return true;
  }

  // Common raw telemetry prefixes
  const telemetryPrefix = /^(?:bat:|seq:|temp:|hum:|baro:|lat:|lon:|pos:|gps:|snr:|rssi:)/i;
  if (telemetryPrefix.test(trimmed)) {
    return true;
  }

  return false;
}

export class TranslationService {
  /**
   * Retrieves current translation configuration from database settings.
   */
  async getSettings() {
    const enabledRaw = await databaseService.getSettingAsync('translationEnabled');
    const enabled = enabledRaw === 'true' || enabledRaw === '1';
    const storedProvider = await databaseService.getSettingAsync('translationProvider');
    const provider = isTranslationProvider(storedProvider) ? storedProvider : DEFAULT_TRANSLATION_PROVIDER;
    const defaultLanguage = (await databaseService.getSettingAsync('translationDefaultLanguage')) || 'en';
    const defaultOutgoingLanguage = (await databaseService.getSettingAsync('translationDefaultOutgoingLanguage')) || 'ja';

    return {
      enabled,
      provider,
      targetLanguage: defaultLanguage,
      defaultOutgoingLanguage,
      sourceLanguage: 'auto',
      autoIncoming: false,
    };
  }

  /**
   * The stored config of ONE provider. Reads that provider's own settings
   * keys and nothing else, so a key saved for one provider is never handed to
   * another (#5518).
   */
  async getStoredProviderConfig(provider: TranslationProvider): Promise<ProviderConfig> {
    const stored = new Map<TranslationProviderSettingKey, string>();
    for (const field of getTranslationProviderFields(provider)) {
      stored.set(field.settingKey, (await databaseService.getSettingAsync(field.settingKey)) || '');
    }
    return buildTranslationProviderConfig(provider, (key) => stored.get(key));
  }

  /**
   * Returns list of supported standard languages.
   */
  async getLanguages() {
    return STANDARD_LANGUAGES;
  }

  /**
   * Runtime translation for chat messages.
   * Enforces DB enablement gating, handles skips, checks and populates cache.
   */
  async translate(request: TranslationRequest, options: TranslateCallOptions = {}): Promise<TranslationResult> {
    const settings = await this.getSettings();

    if (!settings.enabled) {
      throw new Error('Translation is not enabled');
    }

    const { text } = request;

    if (!text || !text.trim()) {
      return {
        translatedText: '',
        sourceText: text || '',
        targetLanguage: request.targetLang || 'en',
        provider: 'none',
        skipped: true,
        skipReason: 'empty_text',
      };
    }

    if (text.length > 5000) {
      throw new Error('Message text exceeds maximum length of 5000 characters');
    }

    // Check if message is non-conversational (ping, telemetry, emoji)
    if (isNonConversational(text)) {
      return {
        translatedText: text,
        sourceText: text,
        targetLanguage: request.targetLang || 'en',
        provider: 'passthrough',
        skipped: true,
        skipReason: 'non_conversational',
      };
    }

    // Determine target language, source language, and provider strictly from settings / request
    const targetLang = (request.targetLang || settings.targetLanguage || 'en').trim();
    const sourceLang = (request.sourceLang || 'auto').trim();
    const provider = settings.provider;

    const useCache = options.useCache === true;
    const cache = getTranslationCache();
    const cacheKey = {
      text,
      targetLanguage: targetLang,
      sourceLanguage: sourceLang,
    };

    let cached = null;
    if (useCache) {
      try {
        cached = await cache.get(cacheKey);
      } catch (err) {
        logger.warn('Translation cache lookup failed; translating without it:', err);
      }
    }
    if (cached) {
      return {
        translatedText: cached.translatedText,
        detectedSourceLanguage: cached.detectedSourceLanguage,
        sourceText: text,
        targetLanguage: targetLang,
        cached: true,
        provider: cached.provider || provider,
      };
    }

    const providerConfig = await this.getStoredProviderConfig(provider);

    const result = await this.executeTranslation(text, sourceLang, targetLang, provider, providerConfig);

    if (useCache && result.translatedText) {
      try {
        await cache.set(cacheKey, {
          translatedText: result.translatedText,
          detectedSourceLanguage: result.detectedSourceLanguage,
          sourceText: text,
          targetLanguage: targetLang,
          provider,
          cachedAt: Date.now(),
        });
      } catch (err) {
        logger.warn('Failed to store translation in cache:', err);
      }
    }

    return result;
  }

  /**
   * Translate a stored message and link it to the shared cache entry so any
   * viewer who can read the message sees the translation without another
   * provider call (#5520). The caller has already loaded `text` from the DB
   * and checked the user may read the message. Skipped results
   * (non-conversational, empty) and provider errors are neither cached nor
   * linked.
   */
  async translateMessage(request: TranslateMessageRequest): Promise<TranslationResult> {
    const result = await this.translate(
      { text: request.text, targetLang: request.targetLang, sourceLang: request.sourceLang },
      { useCache: true },
    );

    if (!result.skipped && result.translatedText) {
      const sourceLang = (request.sourceLang || 'auto').trim();
      const key = computeTranslationCacheKey(request.text, result.targetLanguage, sourceLang);
      try {
        await databaseService.translations.linkMessage(
          request.sourceId,
          request.messageId,
          normalizeTargetLang(result.targetLanguage),
          key,
        );
      } catch (err) {
        // The user still gets their translation; it just isn't shared.
        logger.warn(`Failed to link translation to message ${request.messageId}:`, err);
      }
    }

    return result;
  }

  /**
   * Test a specific translation provider configuration directly (used by settings UI).
   * Bypasses enablement checks and caching.
   */
  async testConfig(config: TestTranslationConfig): Promise<TranslationResult> {
    const defaultSampleText = 'MeshMonitor test message for radio translation.';
    const testText = config.text && config.text.trim() && config.text.length <= 5000
      ? config.text
      : defaultSampleText;

    const sourceLang = (config.sourceLanguage || 'en').trim();
    const targetLang = (config.targetLanguage || 'es').trim();

    if (!isTranslationProvider(config.provider)) {
      throw new Error(`Unsupported translation provider: ${String(config.provider)}`);
    }

    // Only the tested provider's own fields are read — from the request when
    // sent, else from that provider's stored settings. A field that belongs
    // to another provider is ignored even if the caller sends it.
    const stored = await this.getStoredProviderConfig(config.provider);
    const providerConfig: ProviderConfig = {};
    for (const field of getTranslationProviderFields(config.provider)) {
      const sent = config[field.configKey];
      const value = typeof sent === 'string' ? sent : stored[field.configKey];
      if (typeof value === 'string') providerConfig[field.configKey] = value;
    }

    return this.executeTranslation(testText, sourceLang, targetLang, config.provider, providerConfig);
  }

  /**
   * Shared helper to invoke the provider instance and format the response.
   */
  private async executeTranslation(
    text: string,
    sourceLang: string,
    targetLang: string,
    provider: TranslationProvider,
    providerConfig: ProviderConfig
  ): Promise<TranslationResult> {
    // Reject an incomplete config before any request is sent (#5518).
    const missing = missingRequiredTranslationFields(provider, providerConfig);
    if (missing.length > 0) {
      throw new TranslationConfigError(provider, missing.map((field) => field.settingKey));
    }

    const providerInstance = getTranslationProvider(provider);
    const result = await providerInstance.translate(text, sourceLang, targetLang, providerConfig);

    return {
      translatedText: result.translatedText,
      detectedSourceLanguage: result.detectedSourceLanguage,
      sourceText: text,
      targetLanguage: targetLang,
      cached: false,
      provider,
    };
  }
}



export const translationService = new TranslationService();
export default translationService;
