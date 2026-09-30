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
