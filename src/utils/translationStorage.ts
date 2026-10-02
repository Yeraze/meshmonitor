/**
 * Helper utilities for persisting client-side translation preferences to localStorage.
 */

export const STORAGE_KEY_OUTBOUND_LANG = 'meshmonitor_translation_outbound_lang';
export const STORAGE_KEY_INBOUND_LANG = 'meshmonitor_translation_inbound_lang';

export function getPreferredOutboundLanguage(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return localStorage.getItem(STORAGE_KEY_OUTBOUND_LANG);
  } catch {
    return null;
  }
}

export function setPreferredOutboundLanguage(lang: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (lang && lang.trim()) {
      localStorage.setItem(STORAGE_KEY_OUTBOUND_LANG, lang.trim());
    }
  } catch {
    // Ignore storage quota or disabled errors
  }
}

export function getPreferredInboundLanguage(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return localStorage.getItem(STORAGE_KEY_INBOUND_LANG);
  } catch {
    return null;
  }
}

export function setPreferredInboundLanguage(lang: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (lang && lang.trim()) {
      localStorage.setItem(STORAGE_KEY_INBOUND_LANG, lang.trim());
    }
  } catch {
    // Ignore storage quota or disabled errors
  }
}

/**
 * Map a browser language tag (`en-US`, `pt-BR`, `no`) to a supported
 * translation target code, or null when none matches.
 */
export function matchSupportedLanguage(tag: string | null | undefined, supported: readonly string[]): string | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase();
  if (!lower) return null;
  if (supported.includes(lower)) return lower;
  let primary = lower.split(/[-_]/)[0];
  // Norwegian: the generic and Nynorsk tags fall back to Bokmål.
  if (primary === 'no' || primary === 'nn') primary = 'nb';
  return supported.includes(primary) ? primary : null;
}

/**
 * The language a viewer reads translations in (#5520): their saved inbound
 * preference, else the first supported browser language, else the server
 * default. Used for BOTH fetching stored translations and new translate
 * calls, so a translation a user requests is the one they see on reload.
 */
export function resolveViewerTargetLanguage(serverDefault: string, supported: readonly string[]): string {
  const preferred = getPreferredInboundLanguage();
  if (preferred && preferred.trim()) return preferred.trim();
  try {
    if (typeof navigator !== 'undefined') {
      const tags = navigator.languages && navigator.languages.length > 0 ? navigator.languages : [navigator.language];
      for (const tag of tags) {
        const match = matchSupportedLanguage(tag, supported);
        if (match) return match;
      }
    }
  } catch {
    // Ignore — fall through to the server default.
  }
  return serverDefault;
}

export interface TranslationErrorInput {
  skipped?: boolean;
  skipReason?: string;
  translatedText?: string;
}

/**
 * Extracts a user-facing error or skip message from a translation response if
 * the translation was skipped or empty. Returns null if translation succeeded.
 */
export function extractTranslationError(
  res: TranslationErrorInput,
  t?: (key: string, defaultValue: string) => string
): string | null {
  if (res.skipped) {
    if (res.skipReason === 'non_conversational') {
      return t
        ? t('messages.translation_skipped_non_conversational', 'Message not translated (telemetry, test ping, or emoji)')
        : 'Message not translated (telemetry, test ping, or emoji)';
    }
    if (res.skipReason === 'empty_text') {
      return t
        ? t('messages.translation_skipped_empty', 'Empty message text')
        : 'Empty message text';
    }
    return res.skipReason || (t ? t('messages.failed_to_translate', 'Translation unavailable') : 'Translation unavailable');
  }

  if (!res.translatedText && res.translatedText !== '') {
    return t ? t('messages.failed_to_translate', 'No translation returned') : 'No translation returned';
  }

  return null;
}
