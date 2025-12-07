/**
 * API Token Management Component
 *
 * Allows users to generate, view, and revoke their API tokens for v1 API access
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { logger } from '../utils/logger';
import api from '../services/api';

interface APITokenInfo {
  id: number;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  isActive: boolean;
}

interface APITokenState {
  hasToken: boolean;
  token: APITokenInfo | null;
}

const APITokenManagement: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [tokenState, setTokenState] = useState<APITokenState>({ hasToken: false, token: null });
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [showConfirmRevoke, setShowConfirmRevoke] = useState(false);

  useEffect(() => {
    loadTokenInfo();
  }, []);

  const loadTokenInfo = async () => {
    try {
      setLoading(true);
      const data = await api.get<APITokenState>('/api/token');
      setTokenState(data);
    } catch (error) {
      logger.error('Failed to load API token info:', error);
      showToast(t('api_token.load_failed'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateToken = async () => {
    try {
      setIsGenerating(true);
      const data = await api.post<{ token: string; tokenInfo: APITokenInfo }>('/api/token/generate');
      setGeneratedToken(data.token);
      setTokenState({
        hasToken: true,
        token: data.tokenInfo
      });
      showToast(t('api_token.generated_success'), 'success');
    } catch (error) {
      logger.error('Failed to generate API token:', error);
      showToast(error instanceof Error ? error.message : t('api_token.generate_failed'), 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRevokeToken = async () => {
    try {
      setIsRevoking(true);
      await api.delete('/api/token');
      setTokenState({ hasToken: false, token: null });
      setGeneratedToken(null);
      setShowConfirmRevoke(false);
      showToast(t('api_token.revoked_success'), 'success');
    } catch (error) {
      logger.error('Failed to revoke API token:', error);
      showToast(error instanceof Error ? error.message : t('api_token.revoke_failed'), 'error');
    } finally {
      setIsRevoking(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showToast(t('api_token.copied'), 'success');
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  if (loading) {
    return (
      <div className="api-token-section">
        <h3>{t('api_token.title')}</h3>
        <div className="loading">{t('api_token.loading')}</div>
      </div>
    );
  }

  return (
    <div className="api-token-section">
      <h3>{t('api_token.title')}</h3>
      <p className="description">
        {t('api_token.description')}{' '}
        <a href="/api/v1/docs" target="_blank" rel="noopener noreferrer">{t('api_token.view_docs')}</a>
      </p>

      {generatedToken && (
        <div className="token-generated-alert">
          <div className="alert-header">
            <strong>{t('api_token.token_generated')}</strong>
          </div>
          <p className="alert-message">
            {t('api_token.save_warning')}
          </p>
          <div className="token-display">
            <code>{generatedToken}</code>
            <button
              onClick={() => copyToClipboard(generatedToken)}
              className="copy-btn"
              title={t('common.copy_to_clipboard')}
            >
              {t('common.copy')}
            </button>
          </div>
          <button
            onClick={() => setGeneratedToken(null)}
            className="dismiss-btn"
          >
            {t('common.dismiss')}
          </button>
        </div>
      )}

      {tokenState.hasToken && tokenState.token ? (
        <div className="token-info">
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">{t('api_token.prefix')}:</span>
              <span className="info-value"><code>{tokenState.token.prefix}...</code></span>
            </div>
            <div className="info-item">
              <span className="info-label">{t('api_token.created')}:</span>
              <span className="info-value">{formatDate(tokenState.token.createdAt)}</span>
            </div>
            <div className="info-item">
              <span className="info-label">{t('api_token.last_used')}:</span>
              <span className="info-value">
                {tokenState.token.lastUsedAt
                  ? formatDate(tokenState.token.lastUsedAt)
                  : t('time.never')}
              </span>
            </div>
            <div className="info-item">
              <span className="info-label">{t('api_token.status')}:</span>
              <span className="info-value status-active">{t('api_token.status_active')}</span>
            </div>
          </div>

          {!showConfirmRevoke ? (
            <div className="token-actions">
              <button
                onClick={() => setShowConfirmRevoke(true)}
                className="revoke-btn"
                disabled={isRevoking}
              >
                {t('api_token.revoke')}
              </button>
            </div>
          ) : (
            <div className="confirm-revoke">
              <p className="confirm-message">
                {t('api_token.revoke_confirm')}
              </p>
              <div className="confirm-actions">
                <button
                  onClick={handleRevokeToken}
                  className="confirm-btn"
                  disabled={isRevoking}
                >
                  {isRevoking ? t('api_token.revoking') : t('api_token.yes_revoke')}
                </button>
                <button
                  onClick={() => setShowConfirmRevoke(false)}
                  className="cancel-btn"
                  disabled={isRevoking}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="no-token">
          <p>{t('api_token.no_token')}</p>
          <button
            onClick={handleGenerateToken}
            className="generate-btn"
            disabled={isGenerating}
          >
            {isGenerating ? t('api_token.generating') : t('api_token.generate')}
          </button>
        </div>
      )}

      <div className="api-token-help">
        <h4>{t('api_token.usage_title')}</h4>
        <p>{t('api_token.usage_instruction')}</p>
        <pre><code>Authorization: Bearer YOUR_TOKEN_HERE</code></pre>
        <p>
          <a href="/api/v1/docs" target="_blank" rel="noopener noreferrer">
            {t('api_token.view_api_docs')}
          </a>
        </p>
      </div>

      <style>{`
        .api-token-section {
          background: var(--surface-color);
          padding: 1.5rem;
          border-radius: 8px;
          margin-bottom: 1.5rem;
        }

        .api-token-section h3 {
          margin-top: 0;
          margin-bottom: 0.5rem;
          color: var(--text-primary);
        }

        .api-token-section .description {
          color: var(--text-secondary);
          margin-bottom: 1rem;
        }

        .api-token-section .description a {
          color: var(--accent-color);
          text-decoration: none;
        }

        .api-token-section .description a:hover {
          text-decoration: underline;
        }

        .token-generated-alert {
          background: #d4edda;
          border: 1px solid #c3e6cb;
          border-radius: 4px;
          padding: 1rem;
          margin-bottom: 1rem;
        }

        .alert-header {
          color: #155724;
          margin-bottom: 0.5rem;
        }

        .alert-message {
          color: #155724;
          margin: 0.5rem 0;
        }

        .token-display {
          display: flex;
          gap: 0.5rem;
          margin: 1rem 0;
        }

        .token-display code {
          flex: 1;
          background: white;
          padding: 0.75rem;
          border-radius: 4px;
          font-family: 'Courier New', monospace;
          word-break: break-all;
          color: #333;
        }

        .copy-btn,
        .dismiss-btn,
        .generate-btn,
        .revoke-btn,
        .confirm-btn,
        .cancel-btn {
          padding: 0.5rem 1rem;
          border-radius: 4px;
          border: none;
          cursor: pointer;
          font-weight: 500;
          transition: opacity 0.2s;
        }

        .copy-btn {
          background: #007bff;
          color: white;
        }

        .copy-btn:hover {
          opacity: 0.9;
        }

        .dismiss-btn {
          background: #6c757d;
          color: white;
        }

        .dismiss-btn:hover {
          opacity: 0.9;
        }

        .token-info {
          background: var(--surface-elevated);
          border-radius: 4px;
          padding: 1rem;
          margin-bottom: 1rem;
        }

        .info-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .info-item {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .info-label {
          font-weight: 600;
          color: var(--text-secondary);
          font-size: 0.875rem;
        }

        .info-value {
          color: var(--text-primary);
        }

        .info-value code {
          background: var(--surface-color);
          padding: 0.25rem 0.5rem;
          border-radius: 3px;
          font-size: 0.875rem;
        }

        .status-active {
          color: #28a745;
          font-weight: 600;
        }

        .token-actions {
          margin-top: 1rem;
        }

        .generate-btn {
          background: #28a745;
          color: white;
        }

        .generate-btn:hover:not(:disabled) {
          opacity: 0.9;
        }

        .generate-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .revoke-btn {
          background: #dc3545;
          color: white;
        }

        .revoke-btn:hover:not(:disabled) {
          opacity: 0.9;
        }

        .revoke-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .confirm-revoke {
          background: #fff3cd;
          border: 1px solid #ffeaa7;
          border-radius: 4px;
          padding: 1rem;
          margin-top: 1rem;
        }

        .confirm-message {
          color: #856404;
          margin-bottom: 1rem;
        }

        .confirm-actions {
          display: flex;
          gap: 0.5rem;
        }

        .confirm-btn {
          background: #dc3545;
          color: white;
        }

        .confirm-btn:hover:not(:disabled) {
          opacity: 0.9;
        }

        .cancel-btn {
          background: #6c757d;
          color: white;
        }

        .cancel-btn:hover:not(:disabled) {
          opacity: 0.9;
        }

        .confirm-btn:disabled,
        .cancel-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .no-token {
          background: var(--surface-elevated);
          border-radius: 4px;
          padding: 1.5rem;
          text-align: center;
          margin-bottom: 1rem;
        }

        .no-token p {
          color: var(--text-secondary);
          margin-bottom: 1rem;
        }

        .api-token-help {
          background: var(--surface-elevated);
          border-radius: 4px;
          padding: 1rem;
          margin-top: 1rem;
        }

        .api-token-help h4 {
          margin-top: 0;
          margin-bottom: 0.5rem;
          color: var(--text-primary);
        }

        .api-token-help p {
          color: var(--text-secondary);
          margin: 0.5rem 0;
        }

        .api-token-help pre {
          background: var(--surface-color);
          padding: 0.75rem;
          border-radius: 4px;
          overflow-x: auto;
          margin: 0.5rem 0;
        }

        .api-token-help code {
          font-family: 'Courier New', monospace;
          color: var(--text-primary);
        }

        .api-token-help a {
          color: var(--accent-color);
          text-decoration: none;
        }

        .api-token-help a:hover {
          text-decoration: underline;
        }

        .loading {
          text-align: center;
          color: var(--text-secondary);
          padding: 2rem;
        }
      `}</style>
    </div>
  );
};

export default APITokenManagement;
