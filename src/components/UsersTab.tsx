/**
 * Users Tab Component
 *
 * Admin-only interface for managing users and permissions
 */

import React, { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { logger } from '../utils/logger';
import type { PermissionSet } from '../types/permission';
import { useToast } from './ToastContainer';

interface User {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  authProvider: 'local' | 'oidc';
  isAdmin: boolean;
  isActive: boolean;
  passwordLocked: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

const UsersTab: React.FC = () => {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const { showToast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<PermissionSet>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSetPasswordModal, setShowSetPasswordModal] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [userToDeactivate, setUserToDeactivate] = useState<User | null>(null);
  const [passwordForm, setPasswordForm] = useState({
    newPassword: '',
    confirmPassword: ''
  });
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    username: '',
    password: '',
    email: '',
    displayName: '',
    isAdmin: false
  });

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get<{ users: User[] }>('/api/users');
      setUsers(response.users);
    } catch (err) {
      logger.error('Failed to fetch users:', err);
      setError(t('users.failed_load'));
    } finally {
      setLoading(false);
    }
  };

  const handleSelectUser = async (user: User) => {
    try {
      setSelectedUser(user);
      const response = await api.get<{ permissions: PermissionSet }>(`/api/users/${user.id}/permissions`);

      // If user is admin and no permissions returned, set all permissions
      if (user.isAdmin && Object.keys(response.permissions).length === 0) {
        const allPermissions: PermissionSet = {
          dashboard: { read: true, write: true },
          nodes: { read: true, write: true },
          channel_0: { read: true, write: true },
          channel_1: { read: true, write: true },
          channel_2: { read: true, write: true },
          channel_3: { read: true, write: true },
          channel_4: { read: true, write: true },
          channel_5: { read: true, write: true },
          channel_6: { read: true, write: true },
          channel_7: { read: true, write: true },
          messages: { read: true, write: true },
          settings: { read: true, write: true },
          configuration: { read: true, write: true },
          info: { read: true, write: true },
          automation: { read: true, write: true },
          connection: { read: true, write: true },
          traceroute: { read: true, write: true },
          audit: { read: true, write: true },
          security: { read: true, write: true }
        };
        setPermissions(allPermissions);
      } else {
        setPermissions(response.permissions);
      }
    } catch (err) {
      logger.error('Failed to fetch user permissions:', err);
      setError(t('users.failed_load_permissions'));
    }
  };

  const handleUpdatePermissions = async () => {
    if (!selectedUser) return;

    try {
      // Filter out empty/undefined permissions and ensure valid structure
      const validPermissions: PermissionSet = {};
      (['dashboard', 'nodes', 'channel_0', 'channel_1', 'channel_2', 'channel_3', 'channel_4', 'channel_5', 'channel_6', 'channel_7', 'messages', 'settings', 'configuration', 'info', 'automation', 'connection', 'traceroute', 'audit', 'security'] as const).forEach(resource => {
        if (permissions[resource]) {
          validPermissions[resource] = {
            read: permissions[resource]?.read || false,
            write: permissions[resource]?.write || false
          };
        }
      });

      await api.put(`/api/users/${selectedUser.id}/permissions`, { permissions: validPermissions });
      setError(null);
      showToast(t('users.permissions_updated'), 'success');
    } catch (err) {
      logger.error('Failed to update permissions:', err);
      if (err && typeof err === 'object' && 'status' in err && err.status === 403) {
        showToast(t('users.insufficient_permissions_update'), 'error');
      } else {
        showToast(t('users.failed_update_permissions'), 'error');
      }
      setError(t('users.failed_update_permissions'));
    }
  };

  const handleToggleAdmin = async (user: User) => {
    try {
      await api.put(`/api/users/${user.id}/admin`, { isAdmin: !user.isAdmin });
      await fetchUsers();
      // Update selected user to reflect the change
      if (selectedUser && selectedUser.id === user.id) {
        setSelectedUser({ ...selectedUser, isAdmin: !user.isAdmin });
      }
      showToast(
        user.isAdmin ? t('users.admin_removed') : t('users.admin_granted'),
        'success'
      );
    } catch (err) {
      logger.error('Failed to update admin status:', err);
      showToast(t('users.failed_admin_status'), 'error');
      setError(t('users.failed_admin_status'));
    }
  };

  const handleTogglePasswordLocked = async (user: User) => {
    try {
      await api.put(`/api/users/${user.id}`, { passwordLocked: !user.passwordLocked });
      await fetchUsers();
      // Update selected user to reflect the change
      if (selectedUser && selectedUser.id === user.id) {
        setSelectedUser({ ...selectedUser, passwordLocked: !user.passwordLocked });
      }
      showToast(
        user.passwordLocked ? t('users.password_unlocked') : t('users.password_locked'),
        'success'
      );
    } catch (err) {
      logger.error('Failed to toggle password lock:', err);
      showToast(t('users.failed_password_lock'), 'error');
      setError(t('users.failed_password_lock'));
    }
  };

  const handleCloseSetPasswordModal = () => {
    setPasswordForm({ newPassword: '', confirmPassword: '' });
    setShowSetPasswordModal(false);
    setPasswordError(null);
  };

  const handleSetPassword = async () => {
    if (!selectedUser) return;

    // Clear any previous errors
    setPasswordError(null);

    // Validation
    if (!passwordForm.newPassword || !passwordForm.confirmPassword) {
      setPasswordError(t('users.password_fields_required'));
      return;
    }

    if (passwordForm.newPassword.length < 8) {
      setPasswordError(t('users.password_min_length'));
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordError(t('users.passwords_not_match'));
      return;
    }

    try {
      await api.post(`/api/users/${selectedUser.id}/set-password`, {
        newPassword: passwordForm.newPassword
      });

      // Reset form and close modal
      setPasswordForm({ newPassword: '', confirmPassword: '' });
      setShowSetPasswordModal(false);
      setPasswordError(null);
      showToast(t('users.password_updated'), 'success');
    } catch (err) {
      logger.error('Failed to set password:', err);
      if (err && typeof err === 'object' && 'status' in err && err.status === 403) {
        showToast(t('users.insufficient_permissions_password'), 'error');
      } else {
        showToast(err instanceof Error ? err.message : t('users.failed_set_password'), 'error');
      }
      setPasswordError(err instanceof Error ? err.message : t('users.failed_set_password'));
    }
  };

  const handleDeactivateUser = async (user: User) => {
    setUserToDeactivate(user);
    setShowDeactivateConfirm(true);
  };

  const confirmDeactivateUser = async () => {
    if (!userToDeactivate) return;

    try {
      await api.delete(`/api/users/${userToDeactivate.id}`);
      await fetchUsers();
      if (selectedUser?.id === userToDeactivate.id) {
        setSelectedUser(null);
      }
      showToast(t('users.user_deactivated', { username: userToDeactivate.username }), 'success');
      setShowDeactivateConfirm(false);
      setUserToDeactivate(null);
    } catch (err) {
      logger.error('Failed to deactivate user:', err);
      if (err && typeof err === 'object' && 'status' in err && err.status === 403) {
        showToast(t('users.insufficient_permissions_deactivate'), 'error');
      } else {
        showToast(t('users.failed_deactivate'), 'error');
      }
      setError(t('users.failed_deactivate'));
      setShowDeactivateConfirm(false);
      setUserToDeactivate(null);
    }
  };

  const togglePermission = (resource: keyof PermissionSet, action: 'read' | 'write') => {
    setPermissions(prev => ({
      ...prev,
      [resource]: {
        ...prev[resource],
        [action]: !prev[resource]?.[action]
      }
    }));
  };

  const handleCreateUser = async () => {
    try {
      // Clear any previous errors
      setCreateError(null);

      if (!createForm.username || !createForm.password) {
        setCreateError(t('users.username_password_required'));
        return;
      }

      if (createForm.password.length < 8) {
        setCreateError(t('users.password_min_length'));
        return;
      }

      await api.post('/api/users', createForm);

      // Reset form and close modal
      setCreateForm({
        username: '',
        password: '',
        email: '',
        displayName: '',
        isAdmin: false
      });
      setShowCreateModal(false);
      setCreateError(null);

      // Refresh user list
      await fetchUsers();
      showToast(t('users.user_created'), 'success');
    } catch (err) {
      logger.error('Failed to create user:', err);
      setCreateError(err instanceof Error ? err.message : t('users.failed_create'));
    }
  };

  // Only allow access for admins
  if (!authStatus?.user?.isAdmin) {
    return (
      <div className="users-tab">
        <div className="error-message">
          {t('users.access_denied')}
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="users-tab">{t('users.loading')}</div>;
  }

  return (
    <div className="users-tab">
      {error && <div className="error-message">{error}</div>}

      <div className="users-container">
        <div className="users-list">
          <div className="users-list-header">
            <h2>{t('users.title')}</h2>
            <button
              className="button button-primary"
              onClick={() => {
                setShowCreateModal(true);
                setCreateError(null);
              }}
            >
              {t('users.add_user')}
            </button>
          </div>

          {users.map(user => (
            <div
              key={user.id}
              className={`user-item ${selectedUser?.id === user.id ? 'selected' : ''}`}
              onClick={() => handleSelectUser(user)}
            >
              <div className="user-item-info">
                <div className="user-item-name">
                  {user.displayName || user.username}
                  {user.isAdmin && <span className="admin-badge">⭐</span>}
                </div>
                <div className="user-item-meta">
                  @{user.username} • {user.authProvider.toUpperCase()}
                </div>
              </div>
              {!user.isActive && <span className="inactive-badge">{t('users.inactive')}</span>}
            </div>
          ))}
        </div>

        {selectedUser && (
          <div className="user-details">
            <h2>{t('users.user_details')}</h2>

            <div className="user-info-grid">
              <div className="info-item">
                <label>{t('users.username_label')}</label>
                <div>
                  @{selectedUser.username}
                  {selectedUser.username === 'anonymous' && (
                    <span style={{ marginLeft: '8px', padding: '2px 6px', background: 'var(--ctp-surface2)', borderRadius: '4px', fontSize: '0.8em', color: 'var(--ctp-subtext0)' }}>
                      {t('users.special_user')}
                    </span>
                  )}
                </div>
              </div>
              <div className="info-item">
                <label>{t('users.display_name')}</label>
                <div>
                  {selectedUser.displayName || '-'}
                  {selectedUser.username === 'anonymous' && (
                    <div style={{ marginTop: '4px', fontSize: '0.9em', color: 'var(--ctp-subtext0)' }}>
                      💡 {t('users.anonymous_hint')}
                    </div>
                  )}
                </div>
              </div>
              <div className="info-item">
                <label>{t('users.email')}</label>
                <div>{selectedUser.email || '-'}</div>
              </div>
              <div className="info-item">
                <label>{t('users.auth_provider')}</label>
                <div>{selectedUser.authProvider.toUpperCase()}</div>
              </div>
              <div className="info-item">
                <label>{t('common.status')}</label>
                <div>{selectedUser.isActive ? t('users.active') : t('users.inactive')}</div>
              </div>
              <div className="info-item">
                <label>{t('users.administrator')}</label>
                <div>{selectedUser.isAdmin ? t('common.yes') : t('common.no')}</div>
              </div>
              {selectedUser.authProvider === 'local' && (
                <div className="info-item">
                  <label>{t('users.password_locked')}</label>
                  <div>
                    <input
                      type="checkbox"
                      checked={selectedUser.passwordLocked}
                      onChange={() => handleTogglePasswordLocked(selectedUser)}
                    />
                    {selectedUser.passwordLocked ? ` ${t('users.password_locked_yes')}` : ` ${t('common.no')}`}
                  </div>
                </div>
              )}
            </div>

            <div className="user-actions">
              <button
                className="button button-secondary"
                onClick={() => handleToggleAdmin(selectedUser)}
                disabled={selectedUser.id === authStatus.user?.id}
              >
                {selectedUser.isAdmin ? t('users.remove_admin') : t('users.make_admin')}
              </button>
              {selectedUser.authProvider === 'local' && (
                <button
                  className="button button-secondary"
                  onClick={() => setShowSetPasswordModal(true)}
                  disabled={selectedUser.passwordLocked}
                  title={selectedUser.passwordLocked ? t('users.password_locked_hint') : ''}
                >
                  {t('users.set_password')}
                </button>
              )}
              <button
                className="button button-secondary"
                onClick={() => handleDeactivateUser(selectedUser)}
                disabled={selectedUser.id === authStatus.user?.id || selectedUser.username === 'anonymous'}
                style={{ color: 'var(--ctp-red)' }}
                title={selectedUser.username === 'anonymous' ? t('users.cannot_deactivate_anonymous') : ''}
              >
                {t('users.deactivate_user')}
              </button>
            </div>

            <h3>{t('users.permissions')}</h3>
            <div className="permissions-grid">
              {(['dashboard', 'nodes', 'channel_0', 'channel_1', 'channel_2', 'channel_3', 'channel_4', 'channel_5', 'channel_6', 'channel_7', 'messages', 'settings', 'configuration', 'info', 'automation', 'connection', 'traceroute', 'audit', 'security'] as const).map(resource => {
                // Format the label for display
                let label = resource.charAt(0).toUpperCase() + resource.slice(1);
                if (resource.startsWith('channel_')) {
                  const channelNum = resource.split('_')[1];
                  label = channelNum === '0' ? t('users.channel_primary') : t('users.channel_n', { n: channelNum });
                }

                return (
                  <div key={resource} className="permission-item">
                    <div className="permission-label">{label}</div>
                    <div className="permission-actions">
                      {(resource === 'connection' || resource === 'traceroute') ? (
                        // Connection and traceroute permissions use a single checkbox
                        <label>
                          <input
                            type="checkbox"
                            checked={permissions[resource]?.write || false}
                            onChange={() => {
                              // For these permissions, both read and write are set together
                              const newValue = !permissions[resource]?.write;
                              setPermissions({
                                ...permissions,
                                [resource]: { read: newValue, write: newValue }
                              });
                            }}
                          />
                          {resource === 'connection' ? t('users.can_control_connection') : t('users.can_initiate_traceroutes')}
                        </label>
                      ) : (
                        // Other permissions use read/write checkboxes
                        <>
                          <label>
                            <input
                              type="checkbox"
                              checked={permissions[resource]?.read || false}
                              onChange={() => togglePermission(resource, 'read')}
                            />
                            {t('users.read')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={permissions[resource]?.write || false}
                              onChange={() => togglePermission(resource, 'write')}
                            />
                            {t('users.write')}
                          </label>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <button className="button button-primary" onClick={handleUpdatePermissions}>
              {t('users.save_permissions')}
            </button>
          </div>
        )}
      </div>

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => {
          setShowCreateModal(false);
          setCreateError(null);
        }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.create_new_user')}</h2>
              <button className="close-button" onClick={() => {
                setShowCreateModal(false);
                setCreateError(null);
              }}>×</button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>{t('users.username_label')} *</label>
                <input
                  type="text"
                  value={createForm.username}
                  onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                  placeholder="username"
                />
              </div>

              <div className="form-group">
                <label>{t('users.password_label')} *</label>
                <input
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                  placeholder={t('users.at_least_8_chars')}
                />
              </div>

              <div className="form-group">
                <label>{t('users.display_name')}</label>
                <input
                  type="text"
                  value={createForm.displayName}
                  onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
                  placeholder={t('users.full_name')}
                />
              </div>

              <div className="form-group">
                <label>{t('users.email')}</label>
                <input
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  placeholder="user@example.com"
                />
              </div>

              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={createForm.isAdmin}
                    onChange={(e) => setCreateForm({ ...createForm, isAdmin: e.target.checked })}
                  />
                  {' '}{t('users.administrator')}
                </label>
              </div>

              {createError && (
                <div className="error-message" style={{ marginTop: '16px' }}>
                  {createError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setShowCreateModal(false);
                    setCreateError(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="button button-primary"
                  onClick={handleCreateUser}
                >
                  {t('users.create_user')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Set Password Modal */}
      {showSetPasswordModal && selectedUser && (
        <div className="modal-overlay" onClick={handleCloseSetPasswordModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.set_password_for', { username: selectedUser.username })}</h2>
              <button className="close-button" onClick={handleCloseSetPasswordModal}>×</button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="new-password">{t('users.new_password')} *</label>
                <input
                  id="new-password"
                  type="password"
                  value={passwordForm.newPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                  placeholder={t('users.at_least_8_chars')}
                  autoComplete="new-password"
                  minLength={8}
                />
              </div>

              <div className="form-group">
                <label htmlFor="confirm-password">{t('users.confirm_password')} *</label>
                <input
                  id="confirm-password"
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                  placeholder={t('users.reenter_password')}
                  autoComplete="new-password"
                  minLength={8}
                />
              </div>

              {passwordError && (
                <div className="error-message">
                  {passwordError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setPasswordForm({ newPassword: '', confirmPassword: '' });
                    setShowSetPasswordModal(false);
                    setPasswordError(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="button button-primary"
                  onClick={handleSetPassword}
                  disabled={!passwordForm.newPassword || !passwordForm.confirmPassword}
                >
                  {t('users.set_password')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deactivate User Confirmation Modal */}
      {showDeactivateConfirm && userToDeactivate && (
        <div className="modal-overlay" onClick={() => setShowDeactivateConfirm(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.deactivate_confirm')}</h2>
              <button className="close-button" onClick={() => setShowDeactivateConfirm(false)}>×</button>
            </div>

            <div className="modal-body">
              <p><Trans i18nKey="users.deactivate_confirm_text" values={{ username: userToDeactivate.username }} components={{ strong: <strong /> }} /></p>
              <p style={{ color: 'var(--ctp-red)', marginTop: '1rem' }}>
                {t('users.deactivate_warning')}
              </p>

              <div className="modal-actions">
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setShowDeactivateConfirm(false);
                    setUserToDeactivate(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="button button-primary"
                  onClick={confirmDeactivateUser}
                  style={{ backgroundColor: 'var(--ctp-red)', borderColor: 'var(--ctp-red)' }}
                >
                  {t('users.deactivate_user')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UsersTab;
