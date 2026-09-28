/**
 * @vitest-environment jsdom
 *
 * Browser language tags must reach the locales we ship. Our files use
 * underscore codes ("zh_Hans"); browsers report hyphenated tags ("zh-CN",
 * "zh-Hant"). Without a mapping a Chinese browser fell back to English.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { toShippedLanguage } from './languageTag';
import i18n, { AVAILABLE_LANGUAGES } from './i18n';

const SHIPPED = AVAILABLE_LANGUAGES.map((l) => l.code);

describe('toShippedLanguage', () => {
  it.each([
    ['zh-CN', 'zh_Hans'],
    ['zh-SG', 'zh_Hans'],
    ['zh-Hans', 'zh_Hans'],
    ['zh-Hans-CN', 'zh_Hans'],
    ['zh', 'zh_Hans'],
    ['zh-TW', 'zh_Hant'],
    ['zh-HK', 'zh_Hant'],
    ['zh-MO', 'zh_Hant'],
    ['zh-Hant', 'zh_Hant'],
    ['zh-Hant-TW', 'zh_Hant'],
  ])('maps %s to %s', (tag, expected) => {
    expect(toShippedLanguage(tag, SHIPPED)).toBe(expected);
  });

  it.each(SHIPPED)('returns the shipped code %s unchanged', (code) => {
    expect(toShippedLanguage(code, SHIPPED)).toBe(code);
  });

  it('maps a hyphenated region tag to a shipped underscore locale', () => {
    // pt_BR / nb_NO are not in AVAILABLE_LANGUAGES today; this covers the rule
    // for when a region-coded locale is shipped.
    const shipped = [...SHIPPED, 'pt_BR', 'nb_NO'];
    expect(toShippedLanguage('pt-BR', shipped)).toBe('pt_BR');
    expect(toShippedLanguage('nb-NO', shipped)).toBe('nb_NO');
    expect(toShippedLanguage('pt-br', shipped)).toBe('pt_BR');
  });

  it('leaves other tags for i18next to reduce to their base language', () => {
    expect(toShippedLanguage('en-US', SHIPPED)).toBe('en-US');
    expect(toShippedLanguage('pt-BR', SHIPPED)).toBe('pt-BR');
  });

  it('only maps Chinese onto a script it ships', () => {
    expect(toShippedLanguage('zh-TW', ['en', 'zh_Hans'])).toBe('zh-TW');
  });
});

describe('language detection', () => {
  const detector = () =>
    i18n.services.languageDetector as { detect: (order?: string[]) => string[] | string };
  const resolve = (order?: string[]) => {
    const detected = detector().detect(order);
    return i18n.services.languageUtils.getBestMatchFromCodes(
      Array.isArray(detected) ? detected : [detected],
    );
  };

  // Let i18next finish its own (deferred) init first, so its detection and
  // language switch cannot interleave with these assertions.
  beforeAll(async () => {
    if (i18n.isInitialized) return;
    await new Promise<void>((done) => {
      i18n.on('initialized', () => done());
      setTimeout(done, 2000);
    });
  });

  afterEach(() => {
    localStorage.removeItem('language');
    vi.restoreAllMocks();
  });

  it.each([
    [['zh-CN'], 'zh_Hans'],
    [['zh-TW', 'zh'], 'zh_Hant'],
    [['zh-Hant-HK'], 'zh_Hant'],
    [['en-US'], 'en'],
  ])('browser %j resolves to %s', (languages, expected) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
    // Navigator alone: i18next's own init writes its result to localStorage
    // asynchronously, which would otherwise race this test.
    const got = resolve(['navigator']);
    expect(got).toBe(expected);
  });

  it('a saved choice wins over the browser language', () => {
    localStorage.setItem('language', 'de');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN']);
    expect(resolve()).toBe('de');
  });

  it('a saved Chinese choice stays as saved', () => {
    localStorage.setItem('language', 'zh_Hant');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN']);
    expect(resolve()).toBe('zh_Hant');
  });
});
