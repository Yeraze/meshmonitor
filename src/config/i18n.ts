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
 * Available languages configuration
 * Add new languages here as they become available via Weblate
 */
export const AVAILABLE_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English' },
  // Additional languages will be added as translations are contributed
  // { code: 'es', name: 'Spanish', nativeName: 'Espanol' },
  // { code: 'de', name: 'German', nativeName: 'Deutsch' },
  // { code: 'fr', name: 'French', nativeName: 'Francais' },
];

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    debug: import.meta.env.DEV,

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
