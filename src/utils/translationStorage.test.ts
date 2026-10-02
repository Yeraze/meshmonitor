/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPreferredOutboundLanguage,
  setPreferredOutboundLanguage,
  getPreferredInboundLanguage,
  setPreferredInboundLanguage,
  STORAGE_KEY_OUTBOUND_LANG,
  STORAGE_KEY_INBOUND_LANG,
} from './translationStorage';

describe('translationStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should return null when outbound/inbound language is not set', () => {
    expect(getPreferredOutboundLanguage()).toBeNull();
    expect(getPreferredInboundLanguage()).toBeNull();
  });

  it('should persist and retrieve outbound language', () => {
    setPreferredOutboundLanguage('ja');
    expect(localStorage.getItem(STORAGE_KEY_OUTBOUND_LANG)).toBe('ja');
    expect(getPreferredOutboundLanguage()).toBe('ja');
  });

  it('should persist and retrieve inbound language', () => {
    setPreferredInboundLanguage('es');
    expect(localStorage.getItem(STORAGE_KEY_INBOUND_LANG)).toBe('es');
    expect(getPreferredInboundLanguage()).toBe('es');
  });

  it('should trim whitespace when setting language', () => {
    setPreferredOutboundLanguage('  fr  ');
    expect(getPreferredOutboundLanguage()).toBe('fr');
  });
});

describe('extractTranslationError', () => {
  it('should return null on successful translation', async () => {
    const { extractTranslationError } = await import('./translationStorage');
    expect(extractTranslationError({ translatedText: 'Hola', skipped: false })).toBeNull();
  });

  it('should return appropriate message when skipped with non_conversational', async () => {
    const { extractTranslationError } = await import('./translationStorage');
    const result = extractTranslationError({
      translatedText: '73',
      skipped: true,
      skipReason: 'non_conversational',
    });
    expect(result).toBe('Message not translated (telemetry, test ping, or emoji)');
  });

  it('should support i18n translation function', async () => {
    const { extractTranslationError } = await import('./translationStorage');
    const mockT = vi.fn((key, defaultVal) => `translated:${defaultVal}`);
    const result = extractTranslationError(
      {
        translatedText: 'ok',
        skipped: true,
        skipReason: 'non_conversational',
      },
      mockT
    );
    expect(result).toBe('translated:Message not translated (telemetry, test ping, or emoji)');
    expect(mockT).toHaveBeenCalledWith(
      'messages.translation_skipped_non_conversational',
      'Message not translated (telemetry, test ping, or emoji)'
    );
  });

  it('should handle custom skipReason or missing translatedText', async () => {
    const { extractTranslationError } = await import('./translationStorage');
    expect(extractTranslationError({ skipped: true, skipReason: 'custom_reason' })).toBe('custom_reason');
    expect(extractTranslationError({})).toBe('No translation returned');
  });
});

describe('viewer target language (#5520)', () => {
  const SUPPORTED = ['en', 'de', 'nb', 'pt'];

  beforeEach(() => {
    localStorage.clear();
  });

  it('maps browser tags to supported codes', async () => {
    const { matchSupportedLanguage } = await import('./translationStorage');
    expect(matchSupportedLanguage('en-US', SUPPORTED)).toBe('en');
    expect(matchSupportedLanguage('pt_BR', SUPPORTED)).toBe('pt');
    expect(matchSupportedLanguage('no', SUPPORTED)).toBe('nb');
    expect(matchSupportedLanguage('nn-NO', SUPPORTED)).toBe('nb');
    expect(matchSupportedLanguage('xx', SUPPORTED)).toBeNull();
    expect(matchSupportedLanguage('', SUPPORTED)).toBeNull();
  });

  it('prefers the saved inbound language, then the browser, then the server default', async () => {
    const { resolveViewerTargetLanguage, setPreferredInboundLanguage } = await import('./translationStorage');
    const langs = Object.getOwnPropertyDescriptor(window.navigator, 'languages');
    Object.defineProperty(window.navigator, 'languages', { value: ['xx-XX', 'de-AT'], configurable: true });
    try {
      expect(resolveViewerTargetLanguage('en', SUPPORTED)).toBe('de');
      setPreferredInboundLanguage('pt');
      expect(resolveViewerTargetLanguage('en', SUPPORTED)).toBe('pt');
      localStorage.clear();
      Object.defineProperty(window.navigator, 'languages', { value: ['xx'], configurable: true });
      Object.defineProperty(window.navigator, 'language', { value: 'xx', configurable: true });
      expect(resolveViewerTargetLanguage('en', SUPPORTED)).toBe('en');
    } finally {
      if (langs) Object.defineProperty(window.navigator, 'languages', langs);
      else delete (window.navigator as unknown as Record<string, unknown>).languages;
      delete (window.navigator as unknown as Record<string, unknown>).language;
    }
  });
});
