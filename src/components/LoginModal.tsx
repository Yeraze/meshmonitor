/**
 * Login Modal Component
 *
 * Provides login interface for both local and OIDC authentication
 * with two-step MFA verification support.
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
  const { login, verifyMfa, loginWithOIDC, authStatus } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const usernameInputRef = useRef<HTMLInputElement>(null);
  const mfaInputRef = useRef<HTMLInputElement>(null);

  // MFA state
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);

  const localAuthDisabled = authStatus?.localAuthDisabled ?? false;
  const oidcEnabled = authStatus?.oidcEnabled ?? false;

  // Auto-focus username field when modal opens, or MFA field when MFA step shows
  useEffect(() => {
    if (isOpen && mfaRequired && mfaInputRef.current) {
      mfaInputRef.current.focus();
    } else if (isOpen && !localAuthDisabled && usernameInputRef.current) {
      usernameInputRef.current.focus();
    }
  }, [isOpen, localAuthDisabled, mfaRequired]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setMfaRequired(false);
      setMfaCode('');
      setUseBackupCode(false);
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await login(username, password);
      if (result.requireMfa) {
        // Show MFA input step
        setMfaRequired(true);
        setLoading(false);
        return;
      }
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

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await verifyMfa(mfaCode, useBackupCode);
      // On success, page will reload via AuthContext
      onClose();
    } catch (err) {
      logger.error('MFA verification error:', err);
      setError(t('mfa.invalid_code'));
      setMfaCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleBackToLogin = () => {
    setMfaRequired(false);
    setMfaCode('');
    setUseBackupCode(false);
    setError(null);
    setPassword('');
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
          <h2>{mfaRequired ? t('mfa.login_title') : t('auth.login')}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {mfaRequired ? (
            /* MFA Verification Step */
            <form onSubmit={handleMfaSubmit}>
              <div className="mfa-prompt" style={{ textAlign: 'center', marginBottom: '8px' }}>
                <p style={{ color: '#4a5568', fontSize: '14px', margin: 0 }}>
                  {useBackupCode ? t('mfa.backup_code_prompt') : t('mfa.login_prompt')}
                </p>
              </div>

              <div className="form-group">
                <label htmlFor="mfa-code">
                  {useBackupCode ? t('mfa.backup_code_label') : t('mfa.code_label')}
                </label>
                <input
                  ref={mfaInputRef}
                  id="mfa-code"
                  type="text"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder={useBackupCode ? t('mfa.backup_code_placeholder') : t('mfa.login_placeholder')}
                  disabled={loading}
                  required
                  autoComplete="one-time-code"
                  maxLength={useBackupCode ? 8 : 6}
                  pattern={useBackupCode ? undefined : '[0-9]{6}'}
                  inputMode={useBackupCode ? undefined : 'numeric'}
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
                disabled={loading || !mfaCode}
              >
                {loading ? t('mfa.verifying') : t('mfa.verify_button')}
              </button>

              <div className="mfa-actions" style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginTop: '8px' }}>
                <button
                  type="button"
                  className="button-link"
                  style={{ background: 'none', border: 'none', color: '#667eea', cursor: 'pointer', fontSize: '13px', textDecoration: 'underline', padding: '4px' }}
                  onClick={() => {
                    setUseBackupCode(!useBackupCode);
                    setMfaCode('');
                    setError(null);
                  }}
                >
                  {useBackupCode ? t('mfa.use_totp_code') : t('mfa.use_backup_code')}
                </button>
                <button
                  type="button"
                  className="button-link"
                  style={{ background: 'none', border: 'none', color: '#667eea', cursor: 'pointer', fontSize: '13px', textDecoration: 'underline', padding: '4px' }}
                  onClick={handleBackToLogin}
                >
                  {t('mfa.back_to_login')}
                </button>
              </div>
            </form>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
