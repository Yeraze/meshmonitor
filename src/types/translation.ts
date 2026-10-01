export type TranslationProvider = 'libretranslate' | 'openai' | 'deepl' | 'google';

export interface TranslationRequest {
  text: string;
  sourceLang?: string;
  targetLang?: string;
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
  url?: string;
  deeplUrl?: string;
  apiKey?: string;
  model?: string;
  openAiBaseUrl?: string;
}

export interface TranslationLanguageOption {
  code: string;
  name: string;
}

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
  { code: 'no', name: 'Norwegian (Norsk)' },
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
