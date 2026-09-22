/**
 * "Add node from URL" (#5317).
 *
 * A Meshtastic contact link (`https://meshtastic.org/v/#...`) carries a node's
 * identity — nodeNum, names, public key. Importing one is the only way to
 * message a node that has never been heard on this source: with no packet
 * there is no row, and with no row there is no conversation to open.
 *
 * The decode happens server-side (`POST /api/nodes/import-contact-url`), which
 * already owns the protobuf definitions and the per-source permission check.
 * This is the paste-and-confirm shell around it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import apiService from '../../services/api';
import type { DeviceInfo } from '../../types/device';
import styles from './ImportContactUrlModal.module.css';

export interface ImportContactUrlModalProps {
  sourceId: string;
  onClose: () => void;
  /** Called after a successful import so the caller can refresh its node list. */
  onImported?: (node: DeviceInfo | null, alreadyKnown: boolean) => void;
}

export const ImportContactUrlModal: React.FC<ImportContactUrlModalProps> = ({
  sourceId,
  onClose,
  onImported,
}) => {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    try {
      const result = await apiService.importMeshtasticContactUrl(trimmed, sourceId);
      onImported?.(result.node, result.alreadyKnown);
      onClose();
    } catch (e) {
      // The server explains *why* a link was refused (not base64url, not a
      // contact, no usable nodeNum); surface that rather than a generic error.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [url, busy, sourceId, onImported, onClose]);

  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('nodes.import_contact_title', 'Add node from URL')}
      >
        <div className={styles.header}>
          <span className={styles.title}>{t('nodes.import_contact_title', 'Add node from URL')}</span>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            <UiIcon name="close" size={16} />
          </button>
        </div>

        <p className={styles.help}>
          {t(
            'nodes.import_contact_help',
            'Paste a Meshtastic contact link. The node is added to this source so you can message it before it has been heard on the mesh.',
          )}
        </p>

        <textarea
          ref={inputRef}
          className={styles.input}
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter keeps the newline, since a pasted link
            // sometimes arrives wrapped.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="https://meshtastic.org/v/#..."
          rows={3}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />

        {error && <div className={styles.error} role="alert">{error}</div>}

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={busy}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={styles.submitBtn}
            onClick={() => void submit()}
            disabled={busy || url.trim().length === 0}
          >
            {busy
              ? t('nodes.import_contact_busy', 'Adding…')
              : t('nodes.import_contact_submit', 'Add node')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportContactUrlModal;
