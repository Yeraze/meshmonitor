/**
 * Everything a message view needs for inline translation (#5520): settings,
 * the viewer's target language, stored (shared) translations for the
 * messages in view, and the translate/dismiss actions.
 *
 * - Every viewer, anonymous included, sees stored translations without a
 *   click (read-only server path, no provider call).
 * - Only viewers with `canTranslate` may request new translations; the views
 *   hide the Translate button and the inline language switch otherwise.
 */
import { useMemo } from 'react';
import { STANDARD_LANGUAGES } from '../types/translation';
import { resolveViewerTargetLanguage } from '../utils/translationStorage';
import { useTranslationSettings } from './useTranslationSettings';
import { useStoredTranslations } from './useStoredTranslations';
import { useMessageTranslation } from './useMessageTranslation';

const SUPPORTED_CODES = STANDARD_LANGUAGES.map((l) => l.code);

export function useViewTranslations(sourceId: string | null | undefined, messageIds: string[]) {
  const translationSettings = useTranslationSettings();
  const viewerLang = useMemo(
    () => resolveViewerTargetLanguage(translationSettings.defaultLanguage, SUPPORTED_CODES),
    [translationSettings.defaultLanguage]
  );

  const storedTranslations = useStoredTranslations({
    sourceId,
    messageIds,
    lang: viewerLang,
    enabled: translationSettings.enabled,
  });

  const translation = useMessageTranslation({
    sourceId,
    storedTranslations,
    storedLang: viewerLang,
    defaultTargetLang: viewerLang,
  });

  return { translationSettings, viewerLang, ...translation };
}
