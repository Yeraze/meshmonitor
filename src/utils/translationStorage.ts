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
