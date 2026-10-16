/**
 * Change Password Modal Component
 *
 * Allows users with local authentication to change their password
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../services/api';
import { logger } from '../utils/logger';
import Modal from './common/Modal';
import { PasswordField } from './shared/config/PasswordField';

interface ChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The user signed in with a passkey recovery code (#5841) and must choose a
   * new password: no current-password field, and no way to dismiss it.
   */
  forced?: boolean;
}

const ChangePasswordModal: React.FC<ChangePasswordModalProps> = ({ isOpen, onClose, forced = false }) => {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    // Validation
    if ((!forced && !currentPassword) || !newPassword || !confirmPassword) {
      setError(t('change_password.all_fields_required'));
      return;
    }

    if (newPassword.length < 8) {
      setError(t('change_password.min_length'));
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(t('change_password.passwords_no_match'));
      return;
    }

    if (!forced && currentPassword === newPassword) {
      setError(t('change_password.must_be_different'));
      return;
    }

    setLoading(true);

    try {
      await api.post('/api/auth/change-password', forced ? { newPassword } : {
        currentPassword,
        newPassword
      });

      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      // Close modal after 2 seconds
      setTimeout(() => {
        onClose();
        setSuccess(false);
      }, 2000);
    } catch (err: any) {
      logger.error('Password change error:', err);
      setError(err.response?.data?.error || t('change_password.failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (forced && !success) return;
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setSuccess(false);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={forced ? t('change_password.forced_title') : t('change_password.title')}
      closeOnOverlayClick={!forced}
      closeOnEsc={!forced}
      showCloseButton={!forced}
    >
      <form onSubmit={handleSubmit}>
        {forced ? (
          <p className="form-hint">{t('change_password.forced_intro')}</p>
        ) : (
          <div className="form-group">
            <label htmlFor="current-password">{t('change_password.current_password')}</label>
            <PasswordField
              id="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={loading || success}
              required
              autoComplete="current-password"
            />
          </div>
        )}

        <div className="form-group">
          <label htmlFor="new-password">{t('change_password.new_password')}</label>
          <PasswordField
            id="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={loading || success}
            required
            autoComplete="new-password"
            minLength={8}
          />
          <small className="form-hint">{t('change_password.min_length_hint')}</small>
        </div>

        <div className="form-group">
          <label htmlFor="confirm-password">{t('change_password.confirm_password')}</label>
          <PasswordField
            id="confirm-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={loading || success}
            required
            autoComplete="new-password"
            minLength={8}
          />
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {success && (
          <div className="success-message">
            {t('change_password.success')}
          </div>
        )}

        <div className="modal-actions">
          {!forced && (
            <button
              type="button"
              className="button button-secondary"
              onClick={handleClose}
              disabled={loading}
            >
              {t('common.cancel')}
            </button>
          )}
          <button
            type="submit"
            className="button button-primary"
            disabled={loading || success || (!forced && !currentPassword) || !newPassword || !confirmPassword}
          >
            {loading ? t('change_password.changing') : t('change_password.title')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default ChangePasswordModal;
