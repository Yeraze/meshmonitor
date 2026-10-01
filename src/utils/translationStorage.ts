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
