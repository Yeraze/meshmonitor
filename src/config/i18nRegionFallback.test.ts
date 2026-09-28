/**
 * @vitest-environment jsdom
 *
 * A browser reporting "en-US" made i18next request /locales/en-US.json, which
 * does not exist, so every page load logged a 404 before falling back to en.
 * `supportedLngs` limits resolution to the locales we ship: regional variants
 * resolve to their base language, and underscore codes like zh_Hans still
 * match exactly.
 */
import { describe, it, expect } from 'vitest';
import i18n, { AVAILABLE_LANGUAGES } from './i18n';

const bestMatch = (codes: string[]) => i18n.services.languageUtils.getBestMatchFromCodes(codes);

describe('i18n language resolution', () => {
  it('limits supported languages to the shipped list', () => {
    const supported = i18n.options.supportedLngs as string[];
    for (const { code } of AVAILABLE_LANGUAGES) expect(supported).toContain(code);
  });

  it.each([
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['de-AT', 'de'],
    ['es-MX', 'es'],
    ['pt-BR', 'en'], // not shipped: English, not a 404 for pt-BR.json
    ['ja-JP', 'en'],
  ])('resolves browser language %s to %s', (detected, expected) => {
    expect(bestMatch([detected])).toBe(expected);
  });

  it.each(AVAILABLE_LANGUAGES.map((l) => l.code))('keeps the shipped code %s as-is', (code) => {
    expect(bestMatch([code])).toBe(code);
  });

  it('never asks the backend for a regional file', () => {
    // toResolveHierarchy is the list of codes the backend loads for a language.
    for (const lng of [bestMatch(['en-US']), bestMatch(['zh_Hans'])]) {
      const files = i18n.services.languageUtils.toResolveHierarchy(lng);
      expect(files.every((c: string) => !c.includes('-'))).toBe(true);
    }
  });
});
