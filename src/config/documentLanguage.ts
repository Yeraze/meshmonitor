/**
 * Keep `<html lang>` and `<html dir>` in step with the i18next UI language.
 *
 * index.html ships `lang="en"`, and nothing updated it, so a German UI still
 * told screen readers, spell checkers, hyphenation and browser translation
 * that the page was English.
 */
import type { i18n as I18nInstance } from 'i18next';

/** Locale file codes use `_` (`zh_Hans`, `nb_NO`); BCP 47 wants `-`. */
export function toBcp47(lng: string): string {
  return lng.replace(/_/g, '-');
}

export function syncDocumentLanguage(
  lng: string | undefined,
  dir: 'ltr' | 'rtl' = 'ltr',
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): void {
  if (!doc || !lng || lng === 'cimode') return;
  doc.documentElement.lang = toBcp47(lng);
  doc.documentElement.dir = dir;
}

/**
 * Follow every language change, and apply the current language right away.
 * Call it before `init()`: init fires `languageChanged` with the language the
 * detector restored from localStorage, so the saved choice is applied on load.
 * Returns an unsubscribe function.
 */
export function bindDocumentLanguage(instance: I18nInstance): () => void {
  const apply = (lng: string) => syncDocumentLanguage(lng, instance.dir(lng));
  instance.on('languageChanged', apply);
  if (instance.language) apply(instance.language);
  return () => instance.off('languageChanged', apply);
}
