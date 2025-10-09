/**
 * Users Tab Component
 *
 * Admin-only interface for managing users and permissions
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { logger } from '../utils/logger';

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

interface PermissionSet {
  dashboard?: { read: boolean; write: boolean };
  nodes?: { read: boolean; write: boolean };
  messages?: { read: boolean; write: boolean };
  settings?: { read: boolean; write: boolean };
  configuration?: { read: boolean; write: boolean };
  info?: { read: boolean; write: boolean };
  automation?: { read: boolean; write: boolean };
}

const UsersTab: React.FC = () => {
  const { authStatus } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<PermissionSet>({});

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

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get<{ users: User[] }>('/users');
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
      const response = await api.get<{ permissions: PermissionSet }>(`/users/${user.id}/permissions`);
      setPermissions(response.permissions);
    } catch (err) {
      logger.error('Failed to fetch user permissions:', err);
      setError('Failed to load permissions');
    }
  };

  const handleUpdatePermissions = async () => {
    if (!selectedUser) return;

    try {
      await api.put(`/users/${selectedUser.id}/permissions`, { permissions });
      setError(null);
      // Show success feedback
      alert('Permissions updated successfully');
    } catch (err) {
      logger.error('Failed to update permissions:', err);
      setError('Failed to update permissions');
    }
  };

  const handleToggleAdmin = async (user: User) => {
    try {
      await api.put(`/users/${user.id}/admin`, { isAdmin: !user.isAdmin });
      await fetchUsers();
    } catch (err) {
      logger.error('Failed to update admin status:', err);
      setError('Failed to update admin status');
    }
  };

  const handleResetPassword = async (user: User) => {
    if (!confirm(`Reset password for ${user.username}?`)) return;

    try {
      const response = await api.post<{ password: string; message: string }>(`/users/${user.id}/reset-password`, {});
      alert(`${response.message}\n\nNew password: ${response.password}`);
    } catch (err) {
      logger.error('Failed to reset password:', err);
      setError('Failed to reset password');
    }
  };

  const handleDeactivateUser = async (user: User) => {
    if (!confirm(`Deactivate user ${user.username}?`)) return;

    try {
      await api.delete(`/users/${user.id}`);
      await fetchUsers();
      if (selectedUser?.id === user.id) {
        setSelectedUser(null);
      }
    } catch (err) {
      logger.error('Failed to deactivate user:', err);
      setError('Failed to deactivate user');
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
                <div>@{selectedUser.username}</div>
              </div>
              <div className="info-item">
                <label>Display Name</label>
                <div>{selectedUser.displayName || '-'}</div>
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
                  onClick={() => handleResetPassword(selectedUser)}
                >
                  Reset Password
                </button>
              )}
              <button
                className="button button-secondary"
                onClick={() => handleDeactivateUser(selectedUser)}
                disabled={selectedUser.id === authStatus.user?.id}
                style={{ color: 'var(--ctp-red)' }}
              >
                Deactivate User
              </button>
            </div>

            <h3>Permissions</h3>
            <div className="permissions-grid">
              {(['dashboard', 'nodes', 'messages', 'settings', 'configuration', 'info', 'automation'] as const).map(resource => (
                <div key={resource} className="permission-item">
                  <div className="permission-label">{resource.charAt(0).toUpperCase() + resource.slice(1)}</div>
                  <div className="permission-actions">
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
    </div>
  );
};

export default UsersTab;
