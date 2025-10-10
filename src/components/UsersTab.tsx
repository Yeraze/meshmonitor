/**
 * Users Tab Component
 *
 * Admin-only interface for managing users and permissions
 */

import React, { useState, useEffect } from 'react';
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
  createdAt: number;
  lastLoginAt: number | null;
}

const UsersTab: React.FC = () => {
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
      setError('Failed to load users');
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
          channels: { read: true, write: true },
          messages: { read: true, write: true },
          settings: { read: true, write: true },
          configuration: { read: true, write: true },
          info: { read: true, write: true },
          automation: { read: true, write: true },
          connection: { read: true, write: true },
          traceroute: { read: true, write: true }
        };
        setPermissions(allPermissions);
      } else {
        setPermissions(response.permissions);
      }
    } catch (err) {
      logger.error('Failed to fetch user permissions:', err);
      setError('Failed to load permissions');
    }
  };

  const handleUpdatePermissions = async () => {
    if (!selectedUser) return;

    try {
      // Filter out empty/undefined permissions and ensure valid structure
      const validPermissions: PermissionSet = {};
      (['dashboard', 'nodes', 'channels', 'messages', 'settings', 'configuration', 'info', 'automation'] as const).forEach(resource => {
        if (permissions[resource]) {
          validPermissions[resource] = {
            read: permissions[resource]?.read || false,
            write: permissions[resource]?.write || false
          };
        }
      });

      await api.put(`/api/users/${selectedUser.id}/permissions`, { permissions: validPermissions });
      setError(null);
      showToast('Permissions updated successfully', 'success');
    } catch (err) {
      logger.error('Failed to update permissions:', err);
      if (err && typeof err === 'object' && 'status' in err && err.status === 403) {
        showToast('Insufficient permissions to update user permissions', 'error');
      } else {
        showToast('Failed to update permissions. Please try again.', 'error');
      }
      setError('Failed to update permissions');
    }
  };

  const handleToggleAdmin = async (user: User) => {
    try {
      await api.put(`/api/users/${user.id}/admin`, { isAdmin: !user.isAdmin });
      await fetchUsers();
    } catch (err) {
      logger.error('Failed to update admin status:', err);
      setError('Failed to update admin status');
    }
  };

  const handleSetPassword = async () => {
    if (!selectedUser) return;

    // Validation
    if (!passwordForm.newPassword || !passwordForm.confirmPassword) {
      setError('Both password fields are required');
      return;
    }

    if (passwordForm.newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    try {
      await api.post(`/api/users/${selectedUser.id}/set-password`, {
        newPassword: passwordForm.newPassword
      });

      // Reset form and close modal
      setPasswordForm({ newPassword: '', confirmPassword: '' });
      setShowSetPasswordModal(false);
      setError(null);
      showToast('Password updated successfully', 'success');
    } catch (err) {
      logger.error('Failed to set password:', err);
      if (err && typeof err === 'object' && 'status' in err && err.status === 403) {
        showToast('Insufficient permissions to set password', 'error');
      } else {
        showToast(err instanceof Error ? err.message : 'Failed to set password. Please try again.', 'error');
      }
      setError(err instanceof Error ? err.message : 'Failed to set password');
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
      showToast(`User ${userToDeactivate.username} deactivated successfully`, 'success');
      setShowDeactivateConfirm(false);
      setUserToDeactivate(null);
    } catch (err) {
      logger.error('Failed to deactivate user:', err);
      if (err && typeof err === 'object' && 'status' in err && err.status === 403) {
        showToast('Insufficient permissions to deactivate user', 'error');
      } else {
        showToast('Failed to deactivate user. Please try again.', 'error');
      }
      setError('Failed to deactivate user');
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
      if (!createForm.username || !createForm.password) {
        setError('Username and password are required');
        return;
      }

      if (createForm.password.length < 8) {
        setError('Password must be at least 8 characters');
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
      setError(null);

      // Refresh user list
      await fetchUsers();
    } catch (err) {
      logger.error('Failed to create user:', err);
      setError(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  // Only allow access for admins
  if (!authStatus?.user?.isAdmin) {
    return (
      <div className="users-tab">
        <div className="error-message">
          Access denied. Admin privileges required.
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="users-tab">Loading users...</div>;
  }

  return (
    <div className="users-tab">
      {error && <div className="error-message">{error}</div>}

      <div className="users-container">
        <div className="users-list">
          <div className="users-list-header">
            <h2>Users</h2>
            <button
              className="button button-primary"
              onClick={() => setShowCreateModal(true)}
            >
              Add User
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
              {!user.isActive && <span className="inactive-badge">Inactive</span>}
            </div>
          ))}
        </div>

        {selectedUser && (
          <div className="user-details">
            <h2>User Details</h2>

            <div className="user-info-grid">
              <div className="info-item">
                <label>Username</label>
                <div>
                  @{selectedUser.username}
                  {selectedUser.username === 'anonymous' && (
                    <span style={{ marginLeft: '8px', padding: '2px 6px', background: 'var(--ctp-surface2)', borderRadius: '4px', fontSize: '0.8em', color: 'var(--ctp-subtext0)' }}>
                      Special User
                    </span>
                  )}
                </div>
              </div>
              <div className="info-item">
                <label>Display Name</label>
                <div>
                  {selectedUser.displayName || '-'}
                  {selectedUser.username === 'anonymous' && (
                    <div style={{ marginTop: '4px', fontSize: '0.9em', color: 'var(--ctp-subtext0)' }}>
                      💡 Defines permissions for unauthenticated users
                    </div>
                  )}
                </div>
              </div>
              <div className="info-item">
                <label>Email</label>
                <div>{selectedUser.email || '-'}</div>
              </div>
              <div className="info-item">
                <label>Auth Provider</label>
                <div>{selectedUser.authProvider.toUpperCase()}</div>
              </div>
              <div className="info-item">
                <label>Status</label>
                <div>{selectedUser.isActive ? 'Active' : 'Inactive'}</div>
              </div>
              <div className="info-item">
                <label>Admin</label>
                <div>{selectedUser.isAdmin ? 'Yes' : 'No'}</div>
              </div>
            </div>

            <div className="user-actions">
              <button
                className="button button-secondary"
                onClick={() => handleToggleAdmin(selectedUser)}
                disabled={selectedUser.id === authStatus.user?.id}
              >
                {selectedUser.isAdmin ? 'Remove Admin' : 'Make Admin'}
              </button>
              {selectedUser.authProvider === 'local' && (
                <button
                  className="button button-secondary"
                  onClick={() => setShowSetPasswordModal(true)}
                >
                  Set Password
                </button>
              )}
              <button
                className="button button-secondary"
                onClick={() => handleDeactivateUser(selectedUser)}
                disabled={selectedUser.id === authStatus.user?.id || selectedUser.username === 'anonymous'}
                style={{ color: 'var(--ctp-red)' }}
                title={selectedUser.username === 'anonymous' ? 'Cannot deactivate anonymous user' : ''}
              >
                Deactivate User
              </button>
            </div>

            <h3>Permissions</h3>
            <div className="permissions-grid">
              {(['dashboard', 'nodes', 'channels', 'messages', 'settings', 'configuration', 'info', 'automation', 'connection', 'traceroute'] as const).map(resource => (
                <div key={resource} className="permission-item">
                  <div className="permission-label">{resource.charAt(0).toUpperCase() + resource.slice(1)}</div>
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
                        {resource === 'connection' ? 'Can Control Connection' : 'Can Initiate Traceroutes'}
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
                          Read
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={permissions[resource]?.write || false}
                            onChange={() => togglePermission(resource, 'write')}
                          />
                          Write
                        </label>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <button className="button button-primary" onClick={handleUpdatePermissions}>
              Save Permissions
            </button>
          </div>
        )}
      </div>

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Create New User</h2>
              <button className="close-button" onClick={() => setShowCreateModal(false)}>×</button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>Username *</label>
                <input
                  type="text"
                  value={createForm.username}
                  onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                  placeholder="username"
                />
              </div>

              <div className="form-group">
                <label>Password *</label>
                <input
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                  placeholder="At least 8 characters"
                />
              </div>

              <div className="form-group">
                <label>Display Name</label>
                <input
                  type="text"
                  value={createForm.displayName}
                  onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
                  placeholder="Full name"
                />
              </div>

              <div className="form-group">
                <label>Email</label>
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
                  {' '}Administrator
                </label>
              </div>

              <div className="modal-actions">
                <button
                  className="button button-secondary"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  onClick={handleCreateUser}
                >
                  Create User
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Set Password Modal */}
      {showSetPasswordModal && selectedUser && (
        <div className="modal-overlay" onClick={() => setShowSetPasswordModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Set Password for {selectedUser.username}</h2>
              <button className="close-button" onClick={() => setShowSetPasswordModal(false)}>×</button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="new-password">New Password *</label>
                <input
                  id="new-password"
                  type="password"
                  value={passwordForm.newPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  minLength={8}
                />
              </div>

              <div className="form-group">
                <label htmlFor="confirm-password">Confirm Password *</label>
                <input
                  id="confirm-password"
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                  placeholder="Re-enter password"
                  autoComplete="new-password"
                  minLength={8}
                />
              </div>

              <div className="modal-actions">
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setPasswordForm({ newPassword: '', confirmPassword: '' });
                    setShowSetPasswordModal(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  onClick={handleSetPassword}
                  disabled={!passwordForm.newPassword || !passwordForm.confirmPassword}
                >
                  Set Password
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
              <h2>Deactivate User?</h2>
              <button className="close-button" onClick={() => setShowDeactivateConfirm(false)}>×</button>
            </div>

            <div className="modal-body">
              <p>Are you sure you want to deactivate user <strong>{userToDeactivate.username}</strong>?</p>
              <p style={{ color: 'var(--ctp-red)', marginTop: '1rem' }}>
                This will revoke their access to MeshMonitor.
              </p>

              <div className="modal-actions">
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setShowDeactivateConfirm(false);
                    setUserToDeactivate(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  onClick={confirmDeactivateUser}
                  style={{ backgroundColor: 'var(--ctp-red)', borderColor: 'var(--ctp-red)' }}
                >
                  Deactivate User
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
