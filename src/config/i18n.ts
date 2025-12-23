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
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'zh_Hans', name: 'Chinese (Simplified)', nativeName: '简体中文' },
];

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    load: 'currentOnly',
    preload: ['en'], // Always load English for fallback when translations are missing
    returnEmptyString: false, // Treat empty strings as missing translations (triggers fallback)
    debug: process.env.NODE_ENV === 'development',
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
