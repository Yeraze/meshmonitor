import { describe, it, expect } from 'vitest';
import {
  normalizeTranslationText,
  normalizeSourceLang,
  computeTranslationCacheKey,
  isValidLangCode,
} from './cacheKey.js';

describe('translation cache key (#5520)', () => {
  it('normalizes whitespace and Unicode form but keeps case', () => {
    expect(normalizeTranslationText('  Good\t\n  morning  ')).toBe('Good morning');
    // "é" composed (NFC) vs decomposed (NFD) normalize identically.
    expect(normalizeTranslationText('Café')).toBe(normalizeTranslationText('Café'));
    expect(normalizeTranslationText('Hi')).not.toBe(normalizeTranslationText('hi'));
  });

  it('treats auto / empty / missing source language as auto-detect', () => {
    expect(normalizeSourceLang('auto')).toBeNull();
    expect(normalizeSourceLang(' AUTO ')).toBeNull();
    expect(normalizeSourceLang('')).toBeNull();
    expect(normalizeSourceLang(undefined)).toBeNull();
    expect(normalizeSourceLang('JA')).toBe('ja');
  });

  it('is a stable sha256 hex that never contains the text', () => {
    const key = computeTranslationCacheKey('secret plans', 'en');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(computeTranslationCacheKey('  secret   plans ', 'EN', 'auto'));
    expect(key).not.toContain('secret');
  });

  it('differs by target language, explicit source language and case', () => {
    const base = computeTranslationCacheKey('Hello', 'en');
    expect(computeTranslationCacheKey('Hello', 'es')).not.toBe(base);
    expect(computeTranslationCacheKey('Hello', 'en', 'de')).not.toBe(base);
    expect(computeTranslationCacheKey('hello', 'en')).not.toBe(base);
  });

  it('does not let a text containing the separator collide with a language split', () => {
    expect(computeTranslationCacheKey('a\0en', 'es')).not.toBe(computeTranslationCacheKey('a', 'en', 'es'));
  });

  it('validates language codes', () => {
    for (const ok of ['en', 'pt-BR', 'zh-Hant', 'nb']) expect(isValidLangCode(ok)).toBe(true);
    for (const bad of ['', 'e', 'english-language-x', 'en;drop', 42, null, 'a'.repeat(17)]) {
      expect(isValidLangCode(bad)).toBe(false);
    }
  });
});
