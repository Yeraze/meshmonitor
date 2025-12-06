/**
 * Login Modal Component
 *
 * Provides login interface for both local and OIDC authentication
 */

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { logger } from '../utils/logger';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { login, loginWithOIDC, authStatus } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const usernameInputRef = useRef<HTMLInputElement>(null);

  const localAuthDisabled = authStatus?.localAuthDisabled ?? false;
  const oidcEnabled = authStatus?.oidcEnabled ?? false;

  // Auto-focus username field when modal opens
  useEffect(() => {
    if (isOpen && !localAuthDisabled && usernameInputRef.current) {
      usernameInputRef.current.focus();
    }
  }, [isOpen, localAuthDisabled]);

  if (!isOpen) return null;

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(username, password);
      onClose();
      setUsername('');
      setPassword('');
    } catch (err) {
      logger.error('Login error:', err);
      // Check if this is a cookie configuration error
      if (err instanceof Error && err.message.includes('Session cookie')) {
        setError(err.message);
      } else {
        setError(t('auth.invalid_credentials'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOIDCLogin = async () => {
    setError(null);
    setLoading(true);

    try {
      await loginWithOIDC();
      // User will be redirected to OIDC provider
    } catch (err) {
      logger.error('OIDC login error:', err);
      setError(t('auth.oidc_failed'));
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('auth.login')}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Local Authentication */}
          {!localAuthDisabled && (
            <form onSubmit={handleLocalLogin}>
              <div className="form-group">
                <label htmlFor="username">{t('auth.username')}</label>
                <input
                  ref={usernameInputRef}
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={loading}
                  required
                  autoComplete="username"
                />
              </div>

              <div className="form-group">
                <label htmlFor="password">{t('auth.password')}</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  required
                  autoComplete="current-password"
                />
              </div>

              {error && (
                <div className="error-message">
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="button button-primary"
                disabled={loading || !username || !password}
              >
                {loading ? t('auth.logging_in') : t('auth.login')}
              </button>
            </form>
          )}

          {/* Divider between auth methods */}
          {!localAuthDisabled && oidcEnabled && (
            <div className="login-divider">
              <span>{t('common.or')}</span>
            </div>
          )}

          {/* OIDC Authentication */}
          {oidcEnabled && (
            <>
              {error && localAuthDisabled && (
                <div className="error-message">
                  {error}
                </div>
              )}

              <button
                type="button"
                className="button button-secondary"
                onClick={handleOIDCLogin}
                disabled={loading}
              >
                {t('auth.login_with_oidc')}
              </button>
            </>
          )}

          {/* Show message if only OIDC is available */}
          {localAuthDisabled && !oidcEnabled && (
            <div className="error-message">
              {t('auth.local_disabled_no_oidc')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
