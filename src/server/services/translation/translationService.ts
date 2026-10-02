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
import { STANDARD_LANGUAGES, type TranslationLanguageOption } from '../../../types/translation.js';
import {
  getTranslationProvider,
  buildServiceEndpoint,
  type ProviderConfig,
} from './providers/index.js';

export type TranslationProvider = 'libretranslate' | 'openai' | 'deepl' | 'google';

export interface TranslationRequest {
  text: string;
  targetLang?: string;
  sourceLang?: string;
}

export type TranslationOptions = TranslationRequest;

export interface TestTranslationConfig {
  provider: TranslationProvider;
  url?: string;
  deeplUrl?: string;
  apiKey?: string;
  model?: string;
  openAiBaseUrl?: string;
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
   * Runtime translation for chat messages.
   * Enforces DB enablement gating, handles skips, checks and populates cache.
   */
  async translate(request: TranslationRequest): Promise<TranslationResult> {
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
    const provider = (settings.provider || 'libretranslate') as TranslationProvider;

    const cache = getTranslationCache();
    const cacheKey = {
      text,
      targetLanguage: targetLang,
      sourceLanguage: sourceLang,
    };

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

    const providerConfig: ProviderConfig = {
      url: settings.url,
      deeplUrl: settings.deeplUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      openAiBaseUrl: settings.openAiBaseUrl,
    };

    const result = await this.executeTranslation(text, sourceLang, targetLang, provider, providerConfig);

    await cache.set(cacheKey, {
      translatedText: result.translatedText,
      detectedSourceLanguage: result.detectedSourceLanguage,
      sourceText: text,
      targetLanguage: targetLang,
      provider,
      cachedAt: Date.now(),
    });

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

    const providerConfig: ProviderConfig = {
      url: config.url,
      deeplUrl: config.deeplUrl,
      apiKey: config.apiKey,
      model: config.model,
      openAiBaseUrl: config.openAiBaseUrl,
    };

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


