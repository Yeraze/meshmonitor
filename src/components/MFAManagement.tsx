/**
 * MFA Management Component
 *
 * Allows users to enable, verify, and disable TOTP-based two-factor authentication.
 * Follows the same pattern as APITokenManagement.
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { logger } from '../utils/logger';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';

type MfaState = 'loading' | 'disabled' | 'setup' | 'enabled';

interface SetupData {
  qrCodeDataUrl: string;
  secret: string;
  backupCodes: string[];
}

const MFAManagement: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { refreshAuth } = useAuth();
  const [state, setState] = useState<MfaState>('loading');
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [useBackupCodeForDisable, setUseBackupCodeForDisable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [backupCodesCopied, setBackupCodesCopied] = useState(false);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      const data = await api.get<{ enabled: boolean }>('/api/mfa/status');
      setState(data.enabled ? 'enabled' : 'disabled');
    } catch (error) {
      logger.error('Failed to load MFA status:', error);
      setState('disabled');
    }
  };

  const handleStartSetup = async () => {
    try {
      setLoading(true);
      const data = await api.post<SetupData>('/api/mfa/setup');
      setSetupData(data);
      setState('setup');
      setBackupCodesCopied(false);
    } catch (error) {
      logger.error('Failed to start MFA setup:', error);
      showToast(t('mfa.error'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifySetup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      await api.post('/api/mfa/verify-setup', { token: verifyCode });
      setState('enabled');
      setSetupData(null);
      setVerifyCode('');
      showToast(t('mfa.enabled_success'), 'success');
      refreshAuth();
    } catch (error) {
      logger.error('Failed to verify MFA setup:', error);
      showToast(t('mfa.invalid_code'), 'error');
      setVerifyCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      const body = useBackupCodeForDisable
        ? { backupCode: disableCode }
        : { token: disableCode };
      await api.post('/api/mfa/disable', body);
      setState('disabled');
      setDisableCode('');
      setShowDisableConfirm(false);
      showToast(t('mfa.disabled_success'), 'success');
      refreshAuth();
    } catch (error) {
      logger.error('Failed to disable MFA:', error);
      showToast(t('mfa.invalid_code'), 'error');
      setDisableCode('');
    } finally {
      setLoading(false);
    }
  };

  const copyBackupCodes = () => {
    if (setupData) {
      navigator.clipboard.writeText(setupData.backupCodes.join('\n'));
      showToast(t('mfa.backup_codes_copied'), 'success');
      setBackupCodesCopied(true);
    }
  };

  if (state === 'loading') {
    return (
      <div className="mfa-section">
        <h3>{t('mfa.title')}</h3>
        <div className="mfa-loading">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="mfa-section">
      <h3>{t('mfa.title')}</h3>
      <p className="mfa-description">{t('mfa.description')}</p>

      {state === 'disabled' && (
        <div className="mfa-disabled-state">
          <p>{t('mfa.not_enabled')}</p>
          <button
            onClick={handleStartSetup}
            className="button button-primary"
            disabled={loading}
          >
            {loading ? t('common.loading') : t('mfa.enable')}
          </button>
        </div>
      )}

      {state === 'setup' && setupData && (
        <div className="mfa-setup">
          <div className="mfa-setup-step">
            <h4>{t('mfa.setup_step1')}</h4>
            <p>{t('mfa.setup_description')}</p>
            <div className="mfa-qr-container">
              <img src={setupData.qrCodeDataUrl} alt={t('mfa.qr_code')} className="mfa-qr-code" />
            </div>
            <div className="mfa-manual-entry">
              <p>{t('mfa.manual_entry')}</p>
              <code className="mfa-secret">{setupData.secret}</code>
            </div>
          </div>

          <div className="mfa-setup-step">
            <h4>{t('mfa.setup_step2')}</h4>
            <p className="mfa-backup-warning">{t('mfa.backup_codes_warning')}</p>
            <div className="mfa-backup-codes">
              {setupData.backupCodes.map((code, i) => (
                <code key={i} className="mfa-backup-code">{code}</code>
              ))}
            </div>
            <button
              onClick={copyBackupCodes}
              className="button button-secondary mfa-copy-btn"
            >
              {backupCodesCopied ? t('common.copied') : t('mfa.backup_codes_copy')}
            </button>
          </div>

          <div className="mfa-setup-step">
            <h4>{t('mfa.setup_step3')}</h4>
            <form onSubmit={handleVerifySetup} className="mfa-verify-form">
              <div className="form-group">
                <label htmlFor="mfa-verify">{t('mfa.verify_code')}</label>
                <input
                  id="mfa-verify"
                  type="text"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  placeholder={t('mfa.verify_placeholder')}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  disabled={loading}
                  required
                />
              </div>
              <button
                type="submit"
                className="button button-primary"
                disabled={loading || verifyCode.length < 6}
              >
                {loading ? t('common.loading') : t('mfa.verify_button')}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => { setState('disabled'); setSetupData(null); }}
                disabled={loading}
              >
                {t('common.cancel')}
              </button>
            </form>
          </div>
        </div>
      )}

      {state === 'enabled' && (
        <div className="mfa-enabled-state">
          <div className="mfa-status-badge">
            {t('mfa.status_enabled')}
          </div>

          {!showDisableConfirm ? (
            <button
              onClick={() => setShowDisableConfirm(true)}
              className="button button-danger"
            >
              {t('mfa.disable')}
            </button>
          ) : (
            <form onSubmit={handleDisable} className="mfa-disable-form">
              <p>{t('mfa.disable_confirm')}</p>
              <div className="form-group">
                <label htmlFor="mfa-disable-code">
                  {useBackupCodeForDisable ? t('mfa.backup_code_label') : t('mfa.verify_code')}
                </label>
                <input
                  id="mfa-disable-code"
                  type="text"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode={useBackupCodeForDisable ? 'text' : 'numeric'}
                  pattern={useBackupCodeForDisable ? undefined : '[0-9]*'}
                  maxLength={useBackupCodeForDisable ? 8 : 6}
                  disabled={loading}
                  required
                />
              </div>
              <div className="mfa-disable-actions">
                <button
                  type="submit"
                  className="button button-danger"
                  disabled={loading || !disableCode}
                >
                  {loading ? t('common.loading') : t('mfa.disable')}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setShowDisableConfirm(false);
                    setDisableCode('');
                  }}
                  disabled={loading}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="button-link"
                  onClick={() => {
                    setUseBackupCodeForDisable(!useBackupCodeForDisable);
                    setDisableCode('');
                  }}
                >
                  {useBackupCodeForDisable ? t('mfa.use_totp_code') : t('mfa.use_backup_code')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      <style>{`
        .mfa-section {
          background: var(--surface-color);
          padding: 1.5rem;
          border-radius: 8px;
        }

        .mfa-section h3 {
          margin-top: 0;
          margin-bottom: 0.5rem;
          color: var(--text-primary);
        }

        .mfa-description {
          color: var(--text-secondary);
          margin-bottom: 1rem;
        }

        .mfa-loading {
          text-align: center;
          color: var(--text-secondary);
          padding: 2rem;
        }

        .mfa-disabled-state {
          text-align: center;
          padding: 1rem;
        }

        .mfa-disabled-state p {
          color: var(--text-secondary);
          margin-bottom: 1rem;
        }

        .mfa-setup-step {
          background: var(--surface-elevated);
          border-radius: 4px;
          padding: 1rem;
          margin-bottom: 1rem;
        }

        .mfa-setup-step h4 {
          margin-top: 0;
          margin-bottom: 0.5rem;
          color: var(--text-primary);
        }

        .mfa-qr-container {
          text-align: center;
          margin: 1rem 0;
        }

        .mfa-qr-code {
          max-width: 200px;
          border-radius: 4px;
        }

        .mfa-manual-entry {
          text-align: center;
          margin-top: 0.5rem;
        }

        .mfa-manual-entry p {
          color: var(--text-secondary);
          font-size: 0.875rem;
          margin-bottom: 0.25rem;
        }

        .mfa-secret {
          display: inline-block;
          background: var(--surface-color);
          padding: 0.5rem 1rem;
          border-radius: 4px;
          font-family: 'Courier New', monospace;
          font-size: 0.875rem;
          letter-spacing: 0.1em;
          word-break: break-all;
          color: var(--text-primary);
        }

        .mfa-backup-warning {
          color: #856404;
          background: #fff3cd;
          padding: 0.75rem;
          border-radius: 4px;
          border: 1px solid #ffeaa7;
          margin-bottom: 0.75rem;
          font-size: 0.875rem;
        }

        .mfa-backup-codes {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
          gap: 0.5rem;
          margin-bottom: 0.75rem;
        }

        .mfa-backup-code {
          display: block;
          text-align: center;
          background: var(--surface-color);
          padding: 0.4rem 0.5rem;
          border-radius: 3px;
          font-family: 'Courier New', monospace;
          font-size: 0.875rem;
          color: var(--text-primary);
        }

        .mfa-copy-btn {
          margin-top: 0.25rem;
        }

        .mfa-verify-form {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          max-width: 300px;
        }

        .mfa-verify-form .form-group {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .mfa-verify-form input {
          padding: 0.5rem;
          border: 1px solid var(--border-color);
          border-radius: 4px;
          font-size: 1.25rem;
          text-align: center;
          letter-spacing: 0.3em;
          background: var(--surface-color);
          color: var(--text-primary);
        }

        .mfa-enabled-state {
          text-align: center;
          padding: 1rem;
        }

        .mfa-status-badge {
          display: inline-block;
          background: #d4edda;
          color: #155724;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          font-weight: 600;
          margin-bottom: 1rem;
        }

        .mfa-disable-form {
          text-align: left;
          max-width: 400px;
          margin: 0 auto;
        }

        .mfa-disable-form p {
          color: var(--text-secondary);
          margin-bottom: 0.75rem;
        }

        .mfa-disable-form .form-group {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          margin-bottom: 0.75rem;
        }

        .mfa-disable-form input {
          padding: 0.5rem;
          border: 1px solid var(--border-color);
          border-radius: 4px;
          font-size: 1rem;
          background: var(--surface-color);
          color: var(--text-primary);
        }

        .mfa-disable-actions {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
          align-items: center;
        }

        .button-link {
          background: none;
          border: none;
          color: var(--accent-color);
          cursor: pointer;
          text-decoration: underline;
          font-size: 0.875rem;
          padding: 0.25rem;
        }

        .button-link:hover {
          opacity: 0.8;
        }

        .button-danger {
          background: #dc3545;
          color: white;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
        }

        .button-danger:hover:not(:disabled) {
          opacity: 0.9;
        }

        .button-danger:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
};

export default MFAManagement;
