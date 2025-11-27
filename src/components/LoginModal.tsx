/**
 * Login Modal Component
 *
 * Provides login interface for both local and OIDC authentication
 */

import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { logger } from '../utils/logger';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose }) => {
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
        setError('Invalid username or password');
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
      setError('Failed to initiate OIDC login');
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Login</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Local Authentication */}
          {!localAuthDisabled && (
            <form onSubmit={handleLocalLogin}>
              <div className="form-group">
                <label htmlFor="username">Username</label>
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
                <label htmlFor="password">Password</label>
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
                {loading ? 'Logging in...' : 'Login'}
              </button>
            </form>
          )}

          {/* Divider between auth methods */}
          {!localAuthDisabled && oidcEnabled && (
            <div className="login-divider">
              <span>OR</span>
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
                Login with OIDC
              </button>
            </>
          )}

          {/* Show message if only OIDC is available */}
          {localAuthDisabled && !oidcEnabled && (
            <div className="error-message">
              Local authentication is disabled and OIDC is not configured.
              Please contact your administrator.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
