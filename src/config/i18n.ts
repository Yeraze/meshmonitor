/**
 * i18n Configuration for MeshMonitor
 *
 * Provides internationalization support using i18next.
 * Translations are loaded from /locales/{lng}.json files.
 * Language detection order: localStorage > browser navigator
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';
import { appBasename } from '../init';

/**
 * Available languages configuration.
 *
 * Hand-maintained on purpose — shipping a translation is an editorial call, not
 * an automatic consequence of a file existing. But it drifts: Weblate adds
 * locale files continuously and this list does not, so Traditional Chinese sat
 * at 99% translated and unselectable until a contributor noticed (#4742), and
 * Polish reached 89% the same way.
 *
 * `i18nLanguageCoverage.test.ts` now fails when a locale crosses the
 * readiness threshold without being listed here, so the next one surfaces in
 * CI instead of waiting for a user to report it.
 */
export const AVAILABLE_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'zh_Hans', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh_Hant', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
];

void i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    load: 'currentOnly',
    preload: ['en'], // Always load English for fallback when translations are missing
    debug: process.env.NODE_ENV === 'development',
    returnEmptyString: false, // Until all translations are available
    interpolation: {
      escapeValue: false, // React already escapes values
    },

    backend: {
      // Load translations from public/locales/{lng}.json
      loadPath: `${appBasename}/locales/{{lng}}.json`,
    },

    detection: {
      // Detection order: localStorage first, then browser language
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'language',
    },

    react: {
      useSuspense: true,
    },
  });

export default i18n;
