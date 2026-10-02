import React from 'react';
import { useTranslation } from 'react-i18next';
import { STANDARD_LANGUAGES } from '../../types/translation';
import { UiIcon } from '../icons/index';
import styles from './TranslatedMessage.module.css';

export interface TranslatedMessageState {
  text?: string;
  loading: boolean;
  error?: string;
  detectedSourceLang?: string;
  targetLang?: string;
  provider?: string;
}

export interface TranslatedMessageProps {
  state: TranslatedMessageState;
  onDismiss: () => void;
  onRetry?: () => void;
  onChangeTargetLang?: (newTargetLang: string) => void;
}

export const TranslatedMessage: React.FC<TranslatedMessageProps> = ({
  state,
  onDismiss,
  onRetry,
  onChangeTargetLang,
}) => {
  const { t } = useTranslation();

  if (state.loading) {
    return (
      <div className={styles.translatedContainer}>
        <div className={styles.loadingRow}>
          <UiIcon name="translate" size={13} />
          <span>{t('messages.translating', 'Translating...')}</span>
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className={styles.translatedContainer}>
        <div className={styles.errorRow}>
          <span>{state.error}</span>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            {onRetry && (
              <button type="button" className={styles.retryBtn} onClick={onRetry}>
                {t('common.retry', 'Retry')}
              </button>
            )}
            <button
              type="button"
              className={styles.dismissBtn}
              onClick={onDismiss}
              aria-label={t('common.close', 'Close')}
            >
              <UiIcon name="close" size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!state.text) {
    return null;
  }

  return (
    <div className={styles.translatedContainer}>
      <div className={styles.translatedHeader}>
        <div className={styles.translatedHeaderLeft}>
          <UiIcon name="translate" size={12} />
          <span>{t('messages.translation_label', 'Translation')}</span>
          <div className={styles.langSelectorWrapper}>
            {state.detectedSourceLang && (
              <span className={styles.sourceLangTag}>
                {state.detectedSourceLang.toUpperCase()}
                <UiIcon name="forward" size={10} style={{ display: 'inline-block', verticalAlign: 'middle', margin: '0 3px' }} />
              </span>
            )}
            {onChangeTargetLang ? (
              <select
                className={styles.targetLangSelect}
                value={state.targetLang || 'en'}
                onChange={(e) => onChangeTargetLang(e.target.value)}
                title={t('messages.target_language', 'Change target language')}
                aria-label={t('messages.target_language', 'Change target language')}
                data-testid="inline-target-lang-select"
              >
                {STANDARD_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.code.toUpperCase()} ({lang.name})
                  </option>
                ))}
              </select>
            ) : (
              <span className={styles.targetLangTag}>
                {state.targetLang ? state.targetLang.toUpperCase() : ''}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={onDismiss}
          title={t('messages.dismiss_translation', 'Hide translation')}
          aria-label={t('messages.dismiss_translation', 'Hide translation')}
        >
          <UiIcon name="close" size={12} />
        </button>
      </div>
      <div className={styles.translatedText}>{state.text}</div>
    </div>
  );
};
