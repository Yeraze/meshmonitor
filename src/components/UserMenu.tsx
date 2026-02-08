/**
 * User Menu Component
 *
 * Displays user info and logout button in the header when authenticated
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { logger } from '../utils/logger';
import ChangePasswordModal from './ChangePasswordModal';
import APITokenManagement from './APITokenManagement';
import MFAManagement from './MFAManagement';

interface UserMenuProps {
  onLogout?: () => void;
}

const UserMenu: React.FC<UserMenuProps> = ({ onLogout }) => {
  const { t } = useTranslation();
  const { authStatus, logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showAPIToken, setShowAPIToken] = useState(false);
  const [showMFA, setShowMFA] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!authStatus?.authenticated || !authStatus.user) {
    return null;
  }

  const handleLogout = async () => {
    setLoading(true);
    try {
      await logout();
      setShowMenu(false);
      // Call the onLogout callback if provided
      if (onLogout) {
        onLogout();
      }
    } catch (error) {
      logger.error('Logout error:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = () => {
    setShowMenu(false);
    setShowChangePassword(true);
  };

  const handleAPIToken = () => {
    setShowMenu(false);
    setShowAPIToken(true);
  };

  const handleMFA = () => {
    setShowMenu(false);
    setShowMFA(true);
  };

  const displayName = authStatus.user.displayName || authStatus.user.username;
  const isAdmin = authStatus.user.isAdmin;
  const isLocalAuth = authStatus.user.authProvider === 'local';
  const canChangePassword = isLocalAuth && !authStatus.user.passwordLocked;

  return (
    <div className="user-menu">
      <button
        className="user-menu-button"
        onClick={() => setShowMenu(!showMenu)}
        title={t('user_menu.logged_in_as', { name: displayName })}
      >
        <span className="user-icon">👤</span>
        <span className="user-name">{displayName}</span>
        {isAdmin && <span className="admin-badge" title={t('user_menu.administrator')}>⭐</span>}
      </button>

      {showMenu && (
        <>
          <div className="menu-overlay" onClick={() => setShowMenu(false)} />
          <div className="user-menu-dropdown">
            <div className="user-menu-header">
              <div className="user-menu-name">{displayName}</div>
              <div className="user-menu-username">@{authStatus.user.username}</div>
              {authStatus.user.email && (
                <div className="user-menu-email">{authStatus.user.email}</div>
              )}
              <div className="user-menu-provider">
                {authStatus.user.authProvider === 'oidc' ? t('user_menu.oidc_account') : t('user_menu.local_account')}
              </div>
              {isAdmin && (
                <div className="user-menu-admin">{t('user_menu.administrator')}</div>
              )}
            </div>

            <div className="user-menu-divider" />

            {canChangePassword && (
              <button
                className="user-menu-item"
                onClick={handleChangePassword}
                disabled={loading}
              >
                {t('user_menu.change_password')}
              </button>
            )}

            {isLocalAuth && (
              <button
                className="user-menu-item"
                onClick={handleMFA}
                disabled={loading}
              >
                {t('user_menu.mfa')}
              </button>
            )}

            <button
              className="user-menu-item"
              onClick={handleAPIToken}
              disabled={loading}
            >
              {t('user_menu.api_token')}
            </button>

            <button
              className="user-menu-item"
              onClick={handleLogout}
              disabled={loading}
            >
              {loading ? t('user_menu.logging_out') : t('user_menu.logout')}
            </button>
          </div>
        </>
      )}

      <ChangePasswordModal
        isOpen={showChangePassword}
        onClose={() => setShowChangePassword(false)}
      />

      {showAPIToken && (
        <div className="modal-overlay" onClick={() => setShowAPIToken(false)}>
          <div className="modal-content api-token-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('user_menu.api_token_management')}</h2>
              <button className="modal-close" onClick={() => setShowAPIToken(false)}>×</button>
            </div>
            <div className="modal-body">
              <APITokenManagement />
            </div>
          </div>
        </div>
      )}

      {showMFA && (
        <div className="modal-overlay" onClick={() => setShowMFA(false)}>
          <div className="modal-content api-token-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('mfa.title')}</h2>
              <button className="modal-close" onClick={() => setShowMFA(false)}>×</button>
            </div>
            <div className="modal-body">
              <MFAManagement />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserMenu;
