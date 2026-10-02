import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../services/api';
import { type TranslatedMessageState } from '../components/translation/TranslatedMessage';
import type { StoredTranslation } from '../types/translation';
import {
  getPreferredInboundLanguage,
  setPreferredInboundLanguage,
  extractTranslationError,
} from '../utils/translationStorage';

export interface UseMessageTranslationOptions {
  /**
   * Source the messages belong to. When set, translate calls send
   * `{ sourceId, messageId }` so the server translates (and shares) its stored
   * copy of the message (#5520). When null, calls fall back to free text.
   */
  sourceId?: string | null;
  /** Shared translations already stored for messages in view (#5520). */
  storedTranslations?: Record<string, StoredTranslation>;
  /** Language stored translations were fetched in. */
  storedLang?: string | null;
  /**
   * Target language for translate calls with no explicit language. Defaults
   * to the saved inbound preference (then the server default).
   */
  defaultTargetLang?: string | null;
}

export function useMessageTranslation(options: UseMessageTranslationOptions = {}) {
  const { sourceId, storedTranslations, storedLang, defaultTargetLang } = options;
  const { t } = useTranslation();
  const [liveTranslations, setLiveTranslations] = useState<Record<string, TranslatedMessageState>>({});
  // Stored translations the viewer hid this session.
  const [dismissed, setDismissed] = useState<Record<string, true>>({});

  const translateMessage = useCallback(async (msgKey: string, text: string, targetLang?: string) => {
    // If explicit targetLang requested, persist it as user's inbound preferred language
    if (targetLang && targetLang.trim()) {
      setPreferredInboundLanguage(targetLang.trim());
    }

    const effectiveTargetLang =
      (targetLang && targetLang.trim()) || defaultTargetLang || getPreferredInboundLanguage() || undefined;

    setDismissed((prev) => {
      if (!prev[msgKey]) return prev;
      const next = { ...prev };
      delete next[msgKey];
      return next;
    });

    // Set loading state
    setLiveTranslations((prev) => ({
      ...prev,
      [msgKey]: { loading: true },
    }));

    try {
      const res = await apiService.translateMessage(
        sourceId
          ? { text, targetLang: effectiveTargetLang, sourceId, messageId: msgKey }
          : { text, targetLang: effectiveTargetLang }
      );

      const errorMsg = extractTranslationError(res, t);
      if (errorMsg) {
        setLiveTranslations((prev) => ({
          ...prev,
          [msgKey]: {
            loading: false,
            error: errorMsg,
          },
        }));
      } else {
        setLiveTranslations((prev) => ({
          ...prev,
          [msgKey]: {
            loading: false,
            text: res.translatedText,
            detectedSourceLang: res.detectedSourceLanguage,
            targetLang: res.targetLanguage,
            provider: res.provider,
          },
        }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLiveTranslations((prev) => ({
        ...prev,
        [msgKey]: {
          loading: false,
          error: msg || 'Failed to translate message',
        },
      }));
    }
  }, [t, sourceId, defaultTargetLang]);

  const dismissTranslation = useCallback((msgKey: string) => {
    setLiveTranslations((prev) => {
      const next = { ...prev };
      delete next[msgKey];
      return next;
    });
    setDismissed((prev) => ({ ...prev, [msgKey]: true }));
  }, []);

  const clearTranslations = useCallback(() => {
    setLiveTranslations({});
  }, []);

  // Live (this session's) results win over stored ones; a dismissed stored
  // translation stays hidden until the viewer translates that message again.
  const translatedMessages = useMemo(() => {
    if (!storedTranslations || Object.keys(storedTranslations).length === 0) return liveTranslations;
    const merged: Record<string, TranslatedMessageState> = {};
    for (const [id, stored] of Object.entries(storedTranslations)) {
      if (dismissed[id]) continue;
      merged[id] = {
        loading: false,
        text: stored.translatedText,
        detectedSourceLang: stored.detectedSourceLanguage ?? undefined,
        targetLang: storedLang ?? undefined,
        provider: stored.provider,
      };
    }
    return { ...merged, ...liveTranslations };
  }, [storedTranslations, storedLang, dismissed, liveTranslations]);

  return {
    translatedMessages,
    translateMessage,
    dismissTranslation,
    clearTranslations,
  };
}
