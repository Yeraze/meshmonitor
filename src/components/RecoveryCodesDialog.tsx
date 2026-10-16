/**
 * Shows passkey recovery codes once, right after password sign-in is turned
 * off (#5841, D2). The dialog cannot close until the user ticks "I saved
 * these": the server keeps only hashes, so a closed dialog loses the codes.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './common/Modal';
import { UiIcon } from './icons';
import { logger } from '../utils/logger';
import styles from './PasskeyManagement.module.css';

interface RecoveryCodesDialogProps {
  codes: string[];
  username: string;
  onClose: () => void;
}

const RecoveryCodesDialog: React.FC<RecoveryCodesDialogProps> = ({ codes, username, onClose }) => {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const text = codes.join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      logger.error('Could not copy recovery codes:', err);
    }
  };

  const handleDownload = () => {
    const body = `${t('passkey_only.codes_file_heading', { username })}\n\n${text}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'meshmonitor-recovery-codes.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  // Every close path (X, Esc, overlay) goes through here.
  const tryClose = () => {
    if (saved) onClose();
  };

  return (
    <Modal
      isOpen
      onClose={tryClose}
      title={t('passkey_only.codes_title')}
      closeOnOverlayClick={false}
      closeOnEsc={saved}
    >
      <div className={styles.section}>
        <p className={styles.description}>{t('passkey_only.codes_intro')}</p>
        <ol className={styles.codes} aria-label={t('passkey_only.codes_title')}>
          {codes.map(code => (
            <li key={code} className={styles.code}>{code}</li>
          ))}
        </ol>
        <div className={styles.actions}>
          <button type="button" className="button" onClick={handleCopy}>
            <UiIcon name={copied ? 'check' : 'copy'} size={16} />
            {copied ? t('passkey_only.copied') : t('passkey_only.copy')}
          </button>
          <button type="button" className="button" onClick={handleDownload}>
            <UiIcon name="download" size={16} />
            {t('passkey_only.download')}
          </button>
        </div>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />
          {t('passkey_only.codes_saved')}
        </label>
        <div className={styles.actions}>
          <button type="button" className="button button-primary" onClick={onClose} disabled={!saved}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default RecoveryCodesDialog;
