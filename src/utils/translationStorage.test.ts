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
