export type TranslationProvider = 'libretranslate' | 'openai' | 'deepl' | 'google';

export interface TranslationRequest {
  text: string;
  sourceLang?: string;
  targetLang?: string;
  /**
   * Set both when translating a stored message (#5520): the server translates
   * its own copy of the message text, caches it, and shares the result with
   * every viewer who can read the message. Omit for composer drafts.
   */
  sourceId?: string;
  messageId?: string;
}

/** A stored (shared) translation of one message, from `GET /api/translate/stored`. */
export interface StoredTranslation {
  translatedText: string;
  detectedSourceLanguage: string | null;
  provider: string;
}

export interface TranslationResponse {
  translatedText: string;
  detectedSourceLanguage?: string;
  sourceText: string;
  targetLanguage: string;
  cached?: boolean;
  provider?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface TranslationConfig {
  enabled: boolean;
  provider: TranslationProvider;
  sourceLanguage: string;
  targetLanguage: string;
  autoIncoming: boolean;
}

export interface TranslationLanguageOption {
  code: string;
  name: string;
}

/**
 * Canonical list of standard supported languages.
 *
 * Language codes are sourced from the ISO 639-1 standard (Alpha-2 codes) and IETF BCP 47 language subtag registry:
 * - https://www.loc.gov/standards/iso639-2/php/code_list.php
 * - https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry
 *
 * Note on Norwegian:
 * - `nb` (Norwegian Bokmål) is the standardized ISO 639-1 code expected by translation services (DeepL, LibreTranslate).
 * - `no` is the overarching macrolanguage code.
 */
export const STANDARD_LANGUAGES: TranslationLanguageOption[] = [
  { code: 'ar', name: 'Arabic (العربية)' },
  { code: 'zh', name: 'Chinese (中文)' },
  { code: 'cs', name: 'Czech (Čeština)' },
  { code: 'nl', name: 'Dutch (Nederlands)' },
  { code: 'en', name: 'English' },
  { code: 'fi', name: 'Finnish (Suomi)' },
  { code: 'fr', name: 'French (Français)' },
  { code: 'de', name: 'German (Deutsch)' },
  { code: 'el', name: 'Greek (Ελληνικά)' },
  { code: 'he', name: 'Hebrew (עברית)' },
  { code: 'hi', name: 'Hindi (हिन्दी)' },
  { code: 'it', name: 'Italian (Italiano)' },
  { code: 'ja', name: 'Japanese (日本語)' },
  { code: 'ko', name: 'Korean (한국어)' },
  { code: 'nb', name: 'Norwegian (Norsk)' },
  { code: 'pl', name: 'Polish (Polski)' },
  { code: 'pt', name: 'Portuguese (Português)' },
  { code: 'ru', name: 'Russian (Русский)' },
  { code: 'es', name: 'Spanish (Español)' },
  { code: 'sv', name: 'Swedish (Svenska)' },
  { code: 'th', name: 'Thai (ไทย)' },
  { code: 'tr', name: 'Turkish (Türkçe)' },
  { code: 'uk', name: 'Ukrainian (Українська)' },
  { code: 'vi', name: 'Vietnamese (Tiếng Việt)' },
];

