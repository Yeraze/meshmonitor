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
import { getTranslationCache, type TranslationCacheKey } from './translationCache.js';
import { STANDARD_LANGUAGES, type TranslationLanguageOption } from '../../../types/translation.js';
import {
  getTranslationProvider,
  buildServiceEndpoint,
  type ProviderConfig,
  type TranslationProviderResult,
} from './providers/index.js';

export type TranslationProvider = 'libretranslate' | 'openai' | 'deepl' | 'google';

export interface TranslationOptions {
  text: string;
  targetLang?: string;
  sourceLang?: string;
  provider?: TranslationProvider;
  url?: string;
  deeplUrl?: string;
  apiKey?: string;
  model?: string;
  openAiBaseUrl?: string;
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
    const provider = ((await databaseService.getSettingAsync('translationProvider')) as TranslationProvider) || 'libretranslate';
    const url = (await databaseService.getSettingAsync('translationUrl')) || '';
    const deeplUrl = (await databaseService.getSettingAsync('translationDeeplUrl')) || '';
    const apiKey = (await databaseService.getSettingAsync('translationApiKey')) || '';
    const model = (await databaseService.getSettingAsync('translationModel')) || '';
    const openAiBaseUrl = (await databaseService.getSettingAsync('translationOpenAiBaseUrl')) || '';
    const defaultLanguage = (await databaseService.getSettingAsync('translationDefaultLanguage')) || 'en';
    const defaultOutgoingLanguage = (await databaseService.getSettingAsync('translationDefaultOutgoingLanguage')) || 'ja';

    return {
      enabled,
      provider,
      url,
      deeplUrl,
      apiKey,
      model,
      openAiBaseUrl,
      targetLanguage: defaultLanguage,
      defaultOutgoingLanguage,
      sourceLanguage: 'auto',
      autoIncoming: false,
    };
  }

  /**
   * Returns list of supported standard languages.
   */
  async getLanguages() {
    return STANDARD_LANGUAGES;
  }

  /**
   * Tests a specific translation provider configuration.
   */
  async testConfig(config: {
    provider: TranslationProvider;
    url?: string;
    deeplUrl?: string;
    apiKey?: string;
    model?: string;
    openAiBaseUrl?: string;
    targetLanguage?: string;
    sourceLanguage?: string;
  }): Promise<{ success: boolean; message: string; translatedText?: string; detectedSourceLanguage?: string }> {
    const testText = 'Hello';
    try {
      const res = await this.translate({
        text: testText,
        sourceLang: config.sourceLanguage || 'en',
        targetLang: config.targetLanguage || 'es',
        provider: config.provider,
        url: config.url,
        deeplUrl: config.deeplUrl,
        apiKey: config.apiKey,
        model: config.model,
        openAiBaseUrl: config.openAiBaseUrl,
      });

      if (res.translatedText) {
        return {
          success: true,
          message: `Connection successful (${config.provider})`,
          translatedText: res.translatedText,
          detectedSourceLanguage: res.detectedSourceLanguage,
        };
      }
      return {
        success: false,
        message: res.skipReason || 'No translation returned',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: msg || 'Connection failed',
      };
    }
  }

  /**
   * Translates a message using configured provider or explicit options.
   */
  async translate(options: TranslationOptions): Promise<TranslationResult> {
    const { text } = options;

    if (!text || !text.trim()) {
      return {
        translatedText: '',
        sourceText: text || '',
        targetLanguage: options.targetLang || 'en',
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
        targetLanguage: options.targetLang || 'en',
        provider: 'passthrough',
        skipped: true,
        skipReason: 'non_conversational',
      };
    }

    // Resolve settings
    const settings = await this.getSettings();
    const isGlobalEnabled = settings.enabled;

    // Determine target language and provider
    let targetLang = (options.targetLang || settings.targetLanguage || 'en').trim();
    const sourceLang = (options.sourceLang || 'auto').trim();
    const provider = (options.provider || settings.provider || 'libretranslate') as TranslationProvider;

    const cacheKey: TranslationCacheKey = {
      text,
      targetLanguage: targetLang,
      sourceLanguage: sourceLang,
    };

    // Check cache
    const cache = getTranslationCache();
    const cached = await cache.get(cacheKey);
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

    // If translation is globally disabled and no explicit provider config passed (not a test call)
    if (!isGlobalEnabled && !options.provider && !options.url && !options.apiKey) {
      throw new Error('Translation is not enabled');
    }

    // Execute translation using provider implementation
    const providerInstance = getTranslationProvider(provider);
    const providerConfig: ProviderConfig = {
      url: options.url || settings.url,
      deeplUrl: options.deeplUrl || settings.deeplUrl,
      apiKey: options.apiKey || settings.apiKey,
      model: options.model || settings.model,
      openAiBaseUrl: options.openAiBaseUrl || settings.openAiBaseUrl,
    };

    const executeProvider = async (tLang: string, sLang: string): Promise<TranslationProviderResult> => {
      return providerInstance.translate(text, sLang, tLang, providerConfig);
    };

    let result = await executeProvider(targetLang, sourceLang);

    // If no explicit target was requested and detected source matches the primary target language,
    // automatically flip to the default outgoing/foreign language (e.g. English -> Japanese).
    if (
      !options.targetLang &&
      result.detectedSourceLanguage &&
      result.detectedSourceLanguage.toLowerCase() === targetLang.toLowerCase() &&
      settings.defaultOutgoingLanguage &&
      settings.defaultOutgoingLanguage.toLowerCase() !== targetLang.toLowerCase()
    ) {
      const altTarget = settings.defaultOutgoingLanguage.toLowerCase();
      const altResult = await executeProvider(altTarget, result.detectedSourceLanguage);
      if (altResult.translatedText) {
        result = altResult;
        targetLang = altTarget;
      }
    }

    // Store in cache
    await cache.set(cacheKey, {
      translatedText: result.translatedText,
      detectedSourceLanguage: result.detectedSourceLanguage,
      sourceText: text,
      targetLanguage: targetLang,
      provider,
      cachedAt: Date.now(),
    });

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
