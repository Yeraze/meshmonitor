import { useState, useCallback } from 'react';
import apiService from '../services/api';
import { type TranslatedMessageState } from '../components/translation/TranslatedMessage';
import { getPreferredInboundLanguage, setPreferredInboundLanguage } from '../utils/translationStorage';

export function useMessageTranslation() {
  const [translatedMessages, setTranslatedMessages] = useState<Record<string, TranslatedMessageState>>({});

  const translateMessage = useCallback(async (msgKey: string, text: string, targetLang?: string) => {
    // If explicit targetLang requested, persist it as user's inbound preferred language
    if (targetLang && targetLang.trim()) {
      setPreferredInboundLanguage(targetLang.trim());
    }

    const effectiveTargetLang = targetLang || getPreferredInboundLanguage() || undefined;

    // Set loading state
    setTranslatedMessages((prev) => ({
      ...prev,
      [msgKey]: { loading: true },
    }));

    try {
      const res = await apiService.translateMessage({
        text,
        targetLang: effectiveTargetLang,
      });

      if (res.translatedText) {
        setTranslatedMessages((prev) => ({
          ...prev,
          [msgKey]: {
            loading: false,
            text: res.translatedText,
            detectedSourceLang: res.detectedSourceLanguage,
            targetLang: res.targetLanguage,
            provider: res.provider,
          },
        }));
      } else {
        setTranslatedMessages((prev) => ({
          ...prev,
          [msgKey]: {
            loading: false,
            error: res.skipReason || 'Translation unavailable',
          },
        }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTranslatedMessages((prev) => ({
        ...prev,
        [msgKey]: {
          loading: false,
          error: msg || 'Failed to translate message',
        },
      }));
    }
  }, []);

  const dismissTranslation = useCallback((msgKey: string) => {
    setTranslatedMessages((prev) => {
      const next = { ...prev };
      delete next[msgKey];
      return next;
    });
  }, []);

  const clearTranslations = useCallback(() => {
    setTranslatedMessages({});
  }, []);

  return {
    translatedMessages,
    translateMessage,
    dismissTranslation,
    clearTranslations,
  };
}
