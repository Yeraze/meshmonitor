/**
 * "Sign in with a passkey" button for LoginPage and LoginModal (#5841).
 * Renders nothing without a secure context and WebAuthn (spec §5).
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { passkeysSupported } from '../services/passkeyClient';
import { passkeyLoginErrorMessage } from '../hooks/usePasskeyLogin';
import { UiIcon } from './icons';
import styles from './PasskeyLoginButton.module.css';

interface PasskeyLoginButtonProps {
  disabled?: boolean;
  /** Extra class for the button, e.g. the page's full-width login button class. */
  className?: string;
  /** Called with a message to show, or null to clear the current one. */
  onError: (message: string | null) => void;
}

const PasskeyLoginButton: React.FC<PasskeyLoginButtonProps> = ({ disabled, className, onError }) => {
  const { t } = useTranslation();
  const { loginWithPasskey } = useAuth();
  const [busy, setBusy] = useState(false);

  if (!passkeysSupported()) return null;

  const handleClick = async () => {
    onError(null);
    setBusy(true);
    try {
      await loginWithPasskey();
      // On success the page reloads.
    } catch (err) {
      onError(passkeyLoginErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`button button-secondary ${styles.button} ${className ?? ''}`}
      onClick={handleClick}
      disabled={disabled || busy}
    >
      <UiIcon name="key" size={16} />
      <span>{busy ? t('passkey.signing_in') : t('passkey.sign_in')}</span>
    </button>
  );
};

export default PasskeyLoginButton;
