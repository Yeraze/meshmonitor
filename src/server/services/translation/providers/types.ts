import type { TranslationProvider } from '../../../../types/translation.js';

export interface ProviderConfig {
  url?: string;
  deeplUrl?: string;
  apiKey?: string;
  model?: string;
  openAiBaseUrl?: string;
}

export interface TranslationProviderResult {
  /** The translated message text. */
  translatedText: string;
  /** Normalized lowercase language code detected by the provider, if available. */
  detectedSourceLanguage?: string;
}

/**
 * Interface for translation providers.
 *
 * ERROR HANDLING CONTRACT:
 * - On success: Implementations MUST resolve with a `TranslationProviderResult`.
 * - On failure: Implementations MUST throw a descriptive standard `Error` (or subclass).
 *   Do NOT return empty/falsy strings to indicate failure; throw an exception with actionable context
 *   (e.g., HTTP status code, API error message, missing configuration, timeout).
 *   Exceptions will be handled appropriately by orchestrators and route handlers.
 *
 * LANGUAGE CODE CONTRACT:
 * - Input language codes are canonical ISO 639-1 / IETF BCP 47 codes from `STANDARD_LANGUAGES` (e.g. 'nb', 'en', 'es').
 * - Providers are responsible for mapping canonical codes to provider-specific formats (e.g. DeepL's 'NB', 'EN-US', 'PT-PT').
 * - Provider-detected language codes returned in `detectedSourceLanguage` should be normalized to lowercase.
 */
export interface ITranslationProvider {
  /** Unique identifier matching TranslationProvider type. */
  readonly id: TranslationProvider;

  /**
   * Translates text from sourceLang to targetLang.
   *
   * @param text The input text to translate.
   * @param sourceLang The source language code (or 'auto' for automatic detection).
   * @param targetLang The canonical target language code.
   * @param config Provider configuration (URLs, API keys, models, etc.).
   * @returns Promise resolving to TranslationProviderResult.
   * @throws Error on any API error, network failure, timeout, or configuration issue.
   */
  translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: ProviderConfig
  ): Promise<TranslationProviderResult>;
}
