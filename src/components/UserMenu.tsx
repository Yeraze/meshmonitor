/**
 * User Menu Component
 *
 * Displays user info and logout button in the header when authenticated
 */

import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { logger } from '../utils/logger';

const UserMenu: React.FC = () => {
  const { authStatus, logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!authStatus?.authenticated || !authStatus.user) {
    return null;
  }

  const handleLogout = async () => {
    setLoading(true);
    try {
      await logout();
      setShowMenu(false);
    } catch (error) {
      logger.error('Logout error:', error);
    } finally {
      setLoading(false);
    }
  };

  const displayName = authStatus.user.displayName || authStatus.user.username;
  const isAdmin = authStatus.user.isAdmin;

  return (
    <div className="user-menu">
      <button
        className="user-menu-button"
        onClick={() => setShowMenu(!showMenu)}
        title={`Logged in as ${displayName}`}
      >
        <span className="user-icon">👤</span>
        <span className="user-name">{displayName}</span>
        {isAdmin && <span className="admin-badge" title="Administrator">⭐</span>}
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
                {authStatus.user.authProvider === 'oidc' ? 'OIDC' : 'Local'} account
              </div>
              {isAdmin && (
                <div className="user-menu-admin">Administrator</div>
              )}
            </div>

            <div className="user-menu-divider" />

            <button
              className="user-menu-item"
              onClick={handleLogout}
              disabled={loading}
            >
              {loading ? 'Logging out...' : 'Logout'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default UserMenu;
