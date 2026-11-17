import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './SecurityDigestPreview.module.css';

/** What "Send now" would send for one source (POST /api/security/digest/preview, #6453). */
export interface DigestPreviewData {
  title: string;
  /** Null when the digest is suppressed because there are no issues. */
  body: string | null;
  format: 'text' | 'markdown';
  reportType: string;
  /** Characters in title + body as sent. */
  length: number;
  /** The daily digest folds this source into a combined message. */
  combined: boolean;
  /** An Apprise URL applies to this source. */
  configured: boolean;
}

/** Discord rejects a message longer than this. */
const DISCORD_MAX_CHARS = 2000;

interface SecurityDigestPreviewProps {
  preview: DigestPreviewData;
  /** The form has edits that are not saved yet. */
  dirty: boolean;
  onClose: () => void;
}

/**
 * The digest exactly as it would be sent, as plain text: no markdown is
 * rendered, so what you see is what Apprise receives.
 */
export const SecurityDigestPreview: React.FC<SecurityDigestPreviewProps> = ({ preview, dirty, onClose }) => {
  const { t } = useTranslation();
  const over = preview.length > DISCORD_MAX_CHARS;

  return (
    <div className={styles.preview} data-testid="digest-preview">
      <div className={styles.head}>
        <span className={styles.heading}>{t('security.digest_preview_heading', 'Digest preview')}</span>
        {preview.body !== null && (
          <span className={`${styles.count} ${over ? styles.countOver : ''}`}>
            {t('security.digest_preview_length', '{{count}} characters', { count: preview.length })}
          </span>
        )}
        <button type="button" className={styles.close} onClick={onClose}>
          <UiIcon name="close" size={14} /> {t('security.digest_preview_close', 'Close preview')}
        </button>
      </div>

      {dirty && (
        <p className={styles.note}>
          <UiIcon name="info" size={14} />
          {t('security.digest_preview_saved_only', 'Preview shows saved settings. Save to preview your changes.')}
        </p>
      )}
      {!preview.configured && (
        <p className={styles.note}>
          <UiIcon name="info" size={14} />
          {t('security.digest_preview_not_configured', 'No Apprise URL is set for this source, so Send Now would send nothing.')}
        </p>
      )}
      {preview.combined && (
        <p className={styles.note}>
          <UiIcon name="info" size={14} />
          {t('security.digest_preview_combined', 'The daily digest sends this source in one message with other sources that use the global Apprise URL, so it will be longer than this preview.')}
        </p>
      )}

      {preview.body === null ? (
        <p className={styles.note}>
          <UiIcon name="info" size={14} />
          {t('security.digest_preview_suppressed', 'No issues found. The digest is suppressed, so nothing would be sent.')}
        </p>
      ) : (
        <>
          {over && (
            <p className={styles.warning} role="alert">
              <UiIcon name="alert" size={14} />
              <span>
                {t('security.digest_preview_too_long', 'Discord rejects messages over 2,000 characters. Switch to the Summary report, or add ?overflow=split to the Apprise URL so Apprise splits the message.')}
              </span>
            </p>
          )}
          <pre className={styles.block}>
            <span className={styles.blockTitle}>{preview.title}</span>
            {'\n\n'}
            {preview.body}
          </pre>
        </>
      )}
    </div>
  );
};
