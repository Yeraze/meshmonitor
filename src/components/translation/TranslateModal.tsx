import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { STANDARD_LANGUAGES } from '../../types/translation';
import { getUtf8ByteLength } from '../../utils/text';
import {
  getPreferredOutboundLanguage,
  setPreferredOutboundLanguage,
  extractTranslationError,
} from '../../utils/translationStorage';
import { UiIcon } from '../icons/index';
import styles from './TranslateModal.module.css';

export interface TranslateModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialText: string;
  onApply: (translatedText: string) => void;
  defaultTargetLanguage?: string;
  defaultSourceLanguage?: string;
}

export const LORA_PACKET_MAX_BYTES = 200;

export const TranslateModal: React.FC<TranslateModalProps> = ({
  isOpen,
  onClose,
  initialText,
  onApply,
  defaultTargetLanguage = 'ja',
  defaultSourceLanguage = 'auto',
}) => {
  const { t } = useTranslation();
  const [sourceText, setSourceText] = useState(initialText);
  const [sourceLang, setSourceLang] = useState(defaultSourceLanguage);
  const [targetLang, setTargetLang] = useState(() => getPreferredOutboundLanguage() || defaultTargetLanguage);
  const [translatedText, setTranslatedText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync initialText when modal opens
  useEffect(() => {
    if (isOpen) {
      setSourceText(initialText);
      setTranslatedText('');
      setError(null);
      const preferred = getPreferredOutboundLanguage();
      setTargetLang(preferred || defaultTargetLanguage || 'ja');
    }
  }, [isOpen, initialText, defaultTargetLanguage]);

  // Byte calculations
  const sourceBytes = useMemo(() => getUtf8ByteLength(sourceText), [sourceText]);
  const sourceChars = sourceText.length;

  const translatedBytes = useMemo(() => getUtf8ByteLength(translatedText), [translatedText]);
  const translatedChars = translatedText.length;

  const isTranslatedOverLimit = translatedBytes > LORA_PACKET_MAX_BYTES;

  if (!isOpen) return null;

  const handleTranslate = async () => {
    if (!sourceText.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await apiService.translateMessage({
        text: sourceText,
        sourceLang: sourceLang === 'auto' ? undefined : sourceLang,
        targetLang,
      });

      const errorMsg = extractTranslationError(res, t);
      if (errorMsg) {
        setError(errorMsg);
      } else {
        setTranslatedText(res.translatedText);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || t('messages.failed_to_translate', 'Translation failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (translatedText.trim()) {
      onApply(translatedText);
      onClose();
    }
  };

  const handleSwapLanguages = () => {
    if (sourceLang !== 'auto') {
      const oldSource = sourceLang;
      const oldTarget = targetLang;
      setSourceLang(oldTarget);
      setTargetLang(oldSource);
      if (translatedText) {
        setSourceText(translatedText);
        setTranslatedText(sourceText);
      }
    }
  };

  const getByteCounterClass = (bytes: number) => {
    if (bytes > LORA_PACKET_MAX_BYTES) return `${styles.byteCounter} ${styles.byteCounterOver}`;
    if (bytes > LORA_PACKET_MAX_BYTES * 0.9) return `${styles.byteCounter} ${styles.byteCounterWarning}`;
    return styles.byteCounter;
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3>
            <UiIcon name="translate" size={18} />
            {t('messages.translate_modal_title', 'Translate Outgoing Message')}
          </h3>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            <UiIcon name="close" size={14} />
          </button>
        </div>

        <div className={styles.modalBody}>
          <div className={styles.langControlsRow}>
            <div className={styles.langSelectorGroup}>
              <label htmlFor="source-lang-select">{t('messages.source_language', 'Source Language')}</label>
              <select
                id="source-lang-select"
                className={styles.langSelect}
                value={sourceLang}
                onChange={(e) => setSourceLang(e.target.value)}
              >
                <option value="auto">{t('messages.auto_detect', 'Auto-detect')}</option>
                {STANDARD_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              className={styles.swapButton}
              onClick={handleSwapLanguages}
              disabled={sourceLang === 'auto'}
              title={t('messages.swap_languages', 'Swap languages')}
              aria-label={t('messages.swap_languages', 'Swap languages')}
            >
              <UiIcon name="bidirectional" size={14} />
            </button>

            <div className={styles.langSelectorGroup}>
              <label htmlFor="target-lang-select">{t('messages.target_language', 'Target Language')}</label>
              <select
                id="target-lang-select"
                className={styles.langSelect}
                value={targetLang}
                onChange={(e) => {
                  const val = e.target.value;
                  setTargetLang(val);
                  setPreferredOutboundLanguage(val);
                }}
              >
                {STANDARD_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Source Text Area */}
          <div className={styles.sectionGroup}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>{t('messages.original_text', 'Original Text')}</span>
              <span className={getByteCounterClass(sourceBytes)}>
                {sourceChars} chars • {sourceBytes} / {LORA_PACKET_MAX_BYTES} bytes
              </span>
            </div>
            <textarea
              className={styles.textarea}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder={t('messages.enter_text_placeholder', 'Enter text to translate...')}
              rows={3}
            />
          </div>

          <div className={styles.translateActionRow}>
            <button
              type="button"
              className={styles.translateButton}
              onClick={handleTranslate}
              disabled={loading || !sourceText.trim()}
            >
              <UiIcon name="translate" size={14} />
              {loading ? t('messages.translating', 'Translating...') : t('messages.translate_btn', 'Translate')}
            </button>
          </div>

          {/* Error Message */}
          {error && <div className={styles.errorMessage}>{error}</div>}

          {/* Translated Text Box */}
          <div className={styles.sectionGroup}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>{t('messages.translated_text', 'Translated Text')}</span>
              {translatedText ? (
                <span className={getByteCounterClass(translatedBytes)}>
                  {translatedChars} chars • {translatedBytes} / {LORA_PACKET_MAX_BYTES} bytes
                </span>
              ) : null}
            </div>
            <div className={styles.translatedBox}>
              {translatedText || (
                <span className={styles.translatedEmpty}>
                  {t('messages.preview_empty', 'Click Translate to generate translation...')}
                </span>
              )}
            </div>
          </div>

          {/* Packet Size Warning */}
          {isTranslatedOverLimit && (
            <div className={styles.packetWarning}>
              <UiIcon name="alert" size={16} />
              <div>
                <strong>{t('messages.packet_limit_warning_title', 'LoRa Packet Payload Warning')}:</strong>{' '}
                {t(
                  'messages.bytes_warning',
                  'Warning: Translated message is {{bytes}} bytes (LoRa limit is ~200-220 bytes)',
                  { bytes: translatedBytes }
                )}
              </div>
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={styles.applyBtn}
            onClick={handleApply}
            disabled={loading || !translatedText.trim()}
            title={
              !translatedText.trim()
                ? t('messages.translate_first_tooltip', 'Translate message first to replace in draft')
                : t('messages.replace_in_draft', 'Replace in Draft')
            }
            aria-label={t('messages.replace_in_draft', 'Replace in Draft')}
          >
            {t('messages.replace_in_draft', 'Replace in Draft')}
          </button>
        </div>
      </div>
    </div>
  );
};
