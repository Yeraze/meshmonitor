/**
 * Login Page Component
 *
 * Full-page login screen displayed when DISABLE_ANONYMOUS is enabled
 * Shows MeshMonitor logo, login form, version, and GitHub link
 * Supports two-step login when MFA is enabled
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { logger } from '../utils/logger';
import { version } from '../../package.json';
import './LoginPage.css';

const LoginPage: React.FC = () => {
  const { t } = useTranslation();
  const { login, verifyMfa, loginWithOIDC, authStatus } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // MFA state
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);

  const localAuthDisabled = authStatus?.localAuthDisabled ?? false;
  const oidcEnabled = authStatus?.oidcEnabled ?? false;

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await login(username, password);
      if (result.requireMfa) {
        // Show MFA input
        setMfaRequired(true);
        setLoading(false);
        return;
      }
      // After successful login, the auth status will update and the page will re-render
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
    <div className="login-page">
      <div className="login-container">
        {/* MeshMonitor Logo */}
        <div className="login-logo">
          <svg
            width="120"
            height="120"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"
              fill="currentColor"
            />
            <circle cx="7" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="7" r="1.5" fill="currentColor" />
            <circle cx="17" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="17" r="1.5" fill="currentColor" />
            <path
              d="M7 12L12 7M12 7L17 12M17 12L12 17M12 17L7 12"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
          <h1>MeshMonitor</h1>
        </div>

        {/* Login Form */}
        <div className="login-form-container">
          {mfaRequired ? (
            /* MFA Verification Step */
            <form onSubmit={handleMfaSubmit} className="login-form">
              <div className="mfa-prompt">
                <p>{useBackupCode ? t('mfa.backup_code_prompt') : t('mfa.login_prompt')}</p>
              </div>

              <div className="form-group">
                <label htmlFor="mfa-code">
                  {useBackupCode ? t('mfa.backup_code_label') : t('mfa.login_placeholder')}
                </label>
                <input
                  id="mfa-code"
                  type="text"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  disabled={loading}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode={useBackupCode ? 'text' : 'numeric'}
                  pattern={useBackupCode ? undefined : '[0-9]*'}
                  maxLength={useBackupCode ? 8 : 6}
                  placeholder={useBackupCode ? t('mfa.backup_code_placeholder') : '000000'}
                />
              </div>

              {error && (
                <div className="error-message">
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="button button-primary login-button"
                disabled={loading || !mfaCode}
              >
                {loading ? t('auth.logging_in') : t('mfa.verify_button')}
              </button>

              <div className="mfa-actions">
                <button
                  type="button"
                  className="button-link"
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
                  onClick={handleBackToLogin}
                >
                  {t('common.back')}
                </button>
              </div>
            </form>
          ) : (
            /* Normal Login Step */
            <>
              {!localAuthDisabled && (
                <form onSubmit={handleLocalLogin} className="login-form">
                  <div className="form-group">
                    <label htmlFor="username">{t('auth.username')}</label>
                    <input
                      id="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      disabled={loading}
                      required
                      autoComplete="username"
                      autoFocus
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
                    className="button button-primary login-button"
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
                    className="button button-secondary login-button"
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

        {/* Version and GitHub Link */}
        <div className="login-footer">
          <div className="version">{t('common.version')} {version}</div>
          <a
            href="https://github.com/yeraze/meshmonitor"
            target="_blank"
            rel="noopener noreferrer"
            className="github-link"
          >
            {t('common.view_on_github')}
          </a>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
