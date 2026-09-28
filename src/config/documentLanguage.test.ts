/**
 * @vitest-environment jsdom
 *
 * `<html lang>` stayed "en" after the UI switched to German.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance } from 'i18next';
import { bindDocumentLanguage, toBcp47 } from './documentLanguage';

const resources = { en: { translation: {} }, de: { translation: {} }, pl: { translation: {} } };

describe('html lang follows the UI language', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
  });

  it('updates on languageChanged', async () => {
    const i18n = createInstance();
    const unbind = bindDocumentLanguage(i18n);
    await i18n.init({ lng: 'en', fallbackLng: 'en', resources });
    expect(document.documentElement.lang).toBe('en');

    await i18n.changeLanguage('de');
    expect(document.documentElement.lang).toBe('de');
    expect(document.documentElement.dir).toBe('ltr');

    unbind();
    await i18n.changeLanguage('en');
    expect(document.documentElement.lang).toBe('de');
  });

  it('applies the saved language during init', async () => {
    const i18n = createInstance();
    bindDocumentLanguage(i18n);
    // The browser detector restores the saved choice into `lng` during init.
    await i18n.init({ lng: 'pl', fallbackLng: 'en', resources });
    expect(document.documentElement.lang).toBe('pl');
  });

  it('applies an already-initialised language immediately', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'de', fallbackLng: 'en', resources });
    bindDocumentLanguage(i18n);
    expect(document.documentElement.lang).toBe('de');
  });

  it('sets dir for right-to-left languages', async () => {
    const i18n = createInstance();
    bindDocumentLanguage(i18n);
    await i18n.init({ lng: 'en', fallbackLng: 'en', resources });
    await i18n.changeLanguage('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('writes locale-file codes as BCP 47 tags', () => {
    expect(toBcp47('zh_Hans')).toBe('zh-Hans');
    expect(toBcp47('nb_NO')).toBe('nb-NO');
    expect(toBcp47('de')).toBe('de');
  });

  it('the app i18n setup binds before init', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'i18n.ts'), 'utf8');
    const bind = src.indexOf('bindDocumentLanguage(i18n)');
    expect(bind).toBeGreaterThan(0);
    expect(bind).toBeLessThan(src.indexOf('.init('));
  });
});
