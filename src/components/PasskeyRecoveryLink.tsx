/**
 * "Lost your passkey? Use a recovery code" on the login page and modal
 * (#5841, D2). Opens a small username + code form. On success the page
 * reloads signed in, and asks for a new password.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { ApiError } from '../services/api';
import { logger } from '../utils/logger';
import styles from './PasskeyRecoveryLink.module.css';

interface PasskeyRecoveryLinkProps {
  disabled?: boolean;
}

const PasskeyRecoveryLink: React.FC<PasskeyRecoveryLinkProps> = ({ disabled }) => {
  const { t } = useTranslation();
  const { recoverWithCode } = useAuth();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className={styles.link} onClick={() => setOpen(true)} disabled={disabled}>
        {t('passkey_only.lost_passkey')}
      </button>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await recoverWithCode(username.trim(), code.trim());
      // On success the page reloads.
    } catch (err) {
      logger.debug('Recovery-code sign-in failed:', err);
      if (err instanceof ApiError && err.status === 429) {
        const minutes = err.retryAfterSeconds ? Math.max(1, Math.ceil(err.retryAfterSeconds / 60)) : null;
        setError(minutes !== null ? t('auth.rate_limited', { minutes }) : t('auth.rate_limited_generic'));
      } else {
        setError(t('passkey_only.recover_failed'));
      }
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} aria-label={t('passkey_only.recover_title')}>
      <p className={styles.intro}>{t('passkey_only.recover_intro')}</p>
      <div className="form-group">
        <label htmlFor="recovery-username">{t('auth.username')}</label>
        <input
          id="recovery-username"
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
          required
          autoFocus
        />
      </div>
      <div className="form-group">
        <label htmlFor="recovery-code">{t('passkey_only.recovery_code')}</label>
        <input
          id="recovery-code"
          type="text"
          value={code}
          onChange={e => setCode(e.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          disabled={busy}
          required
        />
      </div>
      {error && <div className="error-message">{error}</div>}
      <div className={styles.actions}>
        <button type="submit" className="button button-primary" disabled={busy || !username || !code}>
          {busy ? t('auth.logging_in') : t('passkey_only.recover_submit')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setOpen(false);
            setError(null);
            setCode('');
          }}
          disabled={busy}
        >
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
};

export default PasskeyRecoveryLink;
