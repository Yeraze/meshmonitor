/**
 * Users Tab Component
 *
 * Admin-only interface for managing users and permissions
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import '../styles/users.css';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { logger } from '../utils/logger';
import type { PermissionSet, ResourceType } from '../types/permission';
import { RESOURCES, SOURCEY_RESOURCES } from '../types/permission';
import { useToast } from './ToastContainer';

interface Source {
  id: string;
  name: string;
  type: string;
}

interface User {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  authProvider: 'local' | 'oidc' | 'proxy';
  isAdmin: boolean;
  isActive: boolean;
  passwordLocked: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface ChannelDatabaseEntry {
  id: number;
  name: string;
  description: string | null;
  isEnabled: boolean;
}

interface ChannelDatabasePermission {
  channelDatabaseId: number;
  canViewOnMap: boolean;
  canRead: boolean;
  /**
   * PR-C: write capability on individual channel-database entries. The
   * server-side schema for `channel_database_permissions` does not yet
   * carry a canWrite column — PR-B is expected to land that migration in
   * parallel. Until then the UI sends the field and the server ignores it
   * (or accepts and persists it once the schema catches up).
   */
  canWrite?: boolean;
}

const PERMISSION_KEYS = [
  'dashboard', 'nodes', 'channel_0', 'channel_1', 'channel_2', 'channel_3',
  'channel_4', 'channel_5', 'channel_6', 'channel_7', 'messages', 'settings',
  'configuration', 'info', 'automation', 'connection', 'traceroute', 'audit',
  'security', 'nodes_private', 'packetmonitor', 'waypoints'
] as const;

// PR-C: Global (non-sourcey) resources that surface above the per-source
// grid. Derived from RESOURCES \ SOURCEY_RESOURCES so new globals (e.g.
// `channel_database`, registered for migration 064 in PR-A) appear here
// automatically. The source-scope dropdown does not affect these grants —
// they are stored against sourceId=null.
const GLOBAL_PERMISSION_RESOURCES = RESOURCES.filter(
  (r) => !SOURCEY_RESOURCES.includes(r.id)
).map((r) => r.id);

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
  const [showPermanentDeleteConfirm, setShowPermanentDeleteConfirm] = useState(false);
  const [userToPermanentlyDelete, setUserToPermanentlyDelete] = useState<User | null>(null);
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

  // Virtual channel (channel database) permissions
  const [channelDatabaseEntries, setChannelDatabaseEntries] = useState<ChannelDatabaseEntry[]>([]);
  const [channelDbPermissions, setChannelDbPermissions] = useState<ChannelDatabasePermission[]>([]);

  // Source scope for permissions — all permissions are per-source
  const [sources, setSources] = useState<Source[]>([]);
  const [permissionScope, setPermissionScope] = useState<string | null>(null);
  const [channelNames, setChannelNames] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    fetchUsers();
    fetchChannelDatabaseEntries();
    fetchSources();
  }, []);

  const fetchSources = async () => {
    try {
      const response = await api.get<Source[]>('/api/sources');
      const list = Array.isArray(response) ? response : [];
      setSources(list);
      // Auto-select first source if none selected yet
      if (list.length > 0 && permissionScope === null) {
        setPermissionScope(list[0].id);
        await fetchChannelNames(list[0].id);
      }
    } catch (err) {
      logger.debug('Failed to fetch sources:', err);
    }
  };

  // Fetch channel database entries (virtual channels) - admin only
  const fetchChannelDatabaseEntries = async () => {
    try {
      const response = await api.get<{ data: ChannelDatabaseEntry[] }>('/api/channel-database');
      setChannelDatabaseEntries(response.data || []);
    } catch (err) {
      // This may fail for non-admins, which is fine
      logger.debug('Failed to fetch channel database entries (may be non-admin):', err);
      setChannelDatabaseEntries([]);
    }
  };

  // Fetch channel database permissions for a user
  const fetchChannelDbPermissions = async (userId: number) => {
    try {
      const response = await api.get<{ data: Array<ChannelDatabasePermission & { canWrite?: boolean }> }>(`/api/users/${userId}/channel-database-permissions`);
      // Normalize canWrite. The current server payload omits it; PR-B will
      // start including it once the column lands.
      const list = (response.data || []).map(p => ({
        channelDatabaseId: p.channelDatabaseId,
        canViewOnMap: p.canViewOnMap,
        canRead: p.canRead,
        canWrite: p.canWrite ?? false,
      }));
      setChannelDbPermissions(list);
    } catch (err) {
      logger.error('Failed to fetch channel database permissions:', err);
      setChannelDbPermissions([]);
    }
  };

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

  const loadPermissionsForUser = useCallback(async (user: User, scopeId: string | null) => {
    try {
      const url = scopeId
        ? `/api/users/${user.id}/permissions?sourceId=${scopeId}`
        : `/api/users/${user.id}/permissions`;
      const response = await api.get<{ permissions: PermissionSet }>(url);

      // If user is admin and no permissions returned, set all permissions
      // (including the global resources rendered in the Global Resources
      // section — see GLOBAL_PERMISSION_RESOURCES).
      if (user.isAdmin && Object.keys(response.permissions).length === 0) {
        const allPermissions: PermissionSet = {};
        PERMISSION_KEYS.forEach(resource => {
          if (resource.startsWith('channel_')) {
            allPermissions[resource] = { viewOnMap: true, read: true, write: true };
          } else {
            allPermissions[resource] = { read: true, write: true };
          }
        });
        GLOBAL_PERMISSION_RESOURCES.forEach(resource => {
          allPermissions[resource] = { read: true, write: true };
        });
        setPermissions(allPermissions);
      } else {
        setPermissions(response.permissions);
      }
    } catch (err) {
      logger.error('Failed to fetch user permissions:', err);
      setError(t('users.failed_load_permissions'));
    }
  }, [t]);

  const handleSelectUser = async (user: User) => {
    setSelectedUser(user);
    await loadPermissionsForUser(user, permissionScope);
    // Also fetch channel database permissions
    await fetchChannelDbPermissions(user.id);
  };

  const fetchChannelNames = async (sourceId: string | null) => {
    if (!sourceId) { setChannelNames(new Map()); return; }
    try {
      const channels = await api.get<{ id: number; name: string }[]>(`/api/channels/all?sourceId=${encodeURIComponent(sourceId)}`);
      const map = new Map<number, string>();
      if (Array.isArray(channels)) {
        channels.forEach(ch => { if (ch.name) map.set(ch.id, ch.name); });
      }
      setChannelNames(map);
    } catch {
      setChannelNames(new Map());
    }
  };

  const handlePermissionScopeChange = async (scopeId: string | null) => {
    setPermissionScope(scopeId);
    await fetchChannelNames(scopeId);
    if (selectedUser) {
      await loadPermissionsForUser(selectedUser, scopeId);
    }
  };

  const handleUpdatePermissions = async () => {
    if (!selectedUser) return;

    try {
      // Filter out empty/undefined permissions and ensure valid structure.
      // PR-C: also include any global (non-sourcey) resources the admin
      // edited via the Global Resources section. The server PUT splits the
      // payload by resource type and routes globals to sourceId=null,
      // sourcey rows to the in-scope sourceId.
      const validPermissions: PermissionSet = {};
      const allKeys: ResourceType[] = [...PERMISSION_KEYS, ...GLOBAL_PERMISSION_RESOURCES];
      allKeys.forEach(resource => {
        if (!permissions[resource]) return;
        if (resource.startsWith('channel_')) {
          validPermissions[resource] = {
            viewOnMap: permissions[resource]?.viewOnMap || false,
            read: permissions[resource]?.read || false,
            write: permissions[resource]?.write || false
          };
        } else {
          validPermissions[resource] = {
            read: permissions[resource]?.read || false,
            write: permissions[resource]?.write || false
          };
        }
      });

      await api.put(`/api/users/${selectedUser.id}/permissions`, {
        permissions: validPermissions,
        ...(permissionScope !== null ? { sourceId: permissionScope } : {})
      });
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

  const handlePermanentDeleteUser = async (user: User) => {
    setUserToPermanentlyDelete(user);
    setShowPermanentDeleteConfirm(true);
  };

  const confirmPermanentDeleteUser = async () => {
    if (!userToPermanentlyDelete) return;

    try {
      await api.delete(`/api/users/${userToPermanentlyDelete.id}/permanent`);
      await fetchUsers();
      if (selectedUser?.id === userToPermanentlyDelete.id) {
        setSelectedUser(null);
      }
      showToast(t('users.user_permanently_deleted', { username: userToPermanentlyDelete.username }), 'success');
      setShowPermanentDeleteConfirm(false);
      setUserToPermanentlyDelete(null);
    } catch (err) {
      logger.error('Failed to permanently delete user:', err);
      if (err && typeof err === 'object' && 'message' in err) {
        showToast(String(err.message), 'error');
      } else if (err && typeof err === 'object' && 'status' in err && err.status === 403) {
        showToast(t('users.insufficient_permissions_delete'), 'error');
      } else {
        showToast(t('users.failed_permanent_delete'), 'error');
      }
      setError(t('users.failed_permanent_delete'));
      setShowPermanentDeleteConfirm(false);
      setUserToPermanentlyDelete(null);
    }
  };

  const togglePermission = (resource: keyof PermissionSet, action: 'viewOnMap' | 'read' | 'write') => {
    setPermissions(prev => ({
      ...prev,
      [resource]: {
        ...prev[resource],
        [action]: !prev[resource]?.[action]
      }
    }));
  };

  // Toggle viewOnMap for channel resources
  const toggleChannelViewOnMap = (resource: keyof PermissionSet) => {
    setPermissions(prev => ({
      ...prev,
      [resource]: {
        ...prev[resource],
        viewOnMap: !prev[resource]?.viewOnMap
      }
    }));
  };

  // Toggle read for channel resources - unchecking read also unchecks write
  const toggleChannelRead = (resource: keyof PermissionSet) => {
    const newRead = !permissions[resource]?.read;
    setPermissions(prev => ({
      ...prev,
      [resource]: {
        ...prev[resource],
        read: newRead,
        write: newRead ? prev[resource]?.write : false // Uncheck write if unchecking read
      }
    }));
  };

  // Toggle write for channel resources - checking write also checks read
  const toggleChannelWrite = (resource: keyof PermissionSet) => {
    const newWrite = !permissions[resource]?.write;
    setPermissions(prev => ({
      ...prev,
      [resource]: {
        ...prev[resource],
        write: newWrite,
        read: newWrite ? true : prev[resource]?.read // Check read if checking write
      }
    }));
  };

  // Channel database (virtual channel) permission handlers
  const getChannelDbPermission = (channelDbId: number): ChannelDatabasePermission => {
    const existing = channelDbPermissions.find(p => p.channelDatabaseId === channelDbId);
    return existing || { channelDatabaseId: channelDbId, canViewOnMap: false, canRead: false, canWrite: false };
  };

  const toggleChannelDbViewOnMap = (channelDbId: number) => {
    const existing = getChannelDbPermission(channelDbId);
    const newValue = !existing.canViewOnMap;
    updateChannelDbPermission(channelDbId, {
      canViewOnMap: newValue,
      canRead: existing.canRead,
      canWrite: existing.canWrite ?? false,
    });
  };

  const toggleChannelDbRead = (channelDbId: number) => {
    const existing = getChannelDbPermission(channelDbId);
    const newValue = !existing.canRead;
    // Unchecking read forces canWrite off too — write without read is
    // nonsensical and mirrors the channel_* grid behavior above.
    updateChannelDbPermission(channelDbId, {
      canViewOnMap: existing.canViewOnMap,
      canRead: newValue,
      canWrite: newValue ? (existing.canWrite ?? false) : false,
    });
  };

  // PR-C: write toggle for channel-database entries. Checking write also
  // checks read (matches channel_* behavior). Persisted via the same PUT.
  const toggleChannelDbWrite = (channelDbId: number) => {
    const existing = getChannelDbPermission(channelDbId);
    const newValue = !(existing.canWrite ?? false);
    updateChannelDbPermission(channelDbId, {
      canViewOnMap: existing.canViewOnMap,
      canRead: newValue ? true : existing.canRead,
      canWrite: newValue,
    });
  };

  const updateChannelDbPermission = (
    channelDbId: number,
    updates: { canViewOnMap: boolean; canRead: boolean; canWrite: boolean },
  ) => {
    setChannelDbPermissions(prev => {
      const existingIndex = prev.findIndex(p => p.channelDatabaseId === channelDbId);
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = { channelDatabaseId: channelDbId, ...updates };
        return updated;
      } else {
        return [...prev, { channelDatabaseId: channelDbId, ...updates }];
      }
    });
  };

  const handleUpdateChannelDbPermissions = async () => {
    if (!selectedUser) return;

    try {
      // Normalize: always send canWrite so the server has a chance to
      // persist it once PR-B's schema column lands. Existing servers
      // ignore unknown fields (canViewOnMap/canRead are the only ones
      // validated and stored today).
      const payload = channelDbPermissions.map(p => ({
        channelDatabaseId: p.channelDatabaseId,
        canViewOnMap: p.canViewOnMap,
        canRead: p.canRead,
        canWrite: p.canWrite ?? false,
      }));
      await api.put(`/api/users/${selectedUser.id}/channel-database-permissions`, {
        permissions: payload,
      });
      showToast(t('users.channel_db_permissions_updated'), 'success');
    } catch (err) {
      logger.error('Failed to update channel database permissions:', err);
      showToast(t('users.failed_update_channel_db_permissions'), 'error');
    }
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

  const labelMap: Record<string, string> = {
    dashboard: 'Source Status',
    nodes: 'Node Map & List',
    messages: t('nav.messages'),
    settings: t('nav.settings'),
    configuration: t('nav.configuration'),
    info: t('nav.info'),
    automation: t('nav.automation'),
    audit: t('nav.audit'),
    security: t('nav.security'),
    nodes_private: t('nodes_private'),
    connection: t('users.can_control_connection'),
    traceroute: t('users.can_initiate_traceroutes'),
    waypoints: 'Waypoints',
    themes: 'Custom Themes',
    sources: 'Sources',
    channel_database: 'Channel Database',
  };

  const tooltipMap: Record<string, string> = {
    dashboard: 'Controls visibility of source cards on the main dashboard. Does NOT include node or message access — grant those separately.',
    nodes: 'Read: view node list, neighbor info, and map markers. Write: edit node names/notes.',
    nodes_private: 'Read: view detailed position history for individual nodes.',
    messages: 'Read: view messages and channel list. Write: send messages.',
    settings: 'Read: view global settings. Write: change settings, map styles, GeoJSON layers.',
    configuration: 'Read: view device configuration. Write: change device radio/module settings.',
    info: 'Read: view device info and statistics.',
    automation: 'Read: view automation rules. Write: create/edit automation rules.',
    connection: 'Connect/disconnect the Meshtastic device for this source.',
    traceroute: 'Initiate traceroute requests to mesh nodes.',
    audit: 'Read: view the audit log. Write: purge audit log entries.',
    security: 'Read: view security scan results. Write: run scans, manage flagged/dead nodes.',
    packetmonitor: 'Read: view raw Meshtastic packets in the packet monitor.',
    waypoints: 'Read: view map waypoints. Write: create, edit, and delete waypoints (WAYPOINT_APP).',
    themes: 'Read: view custom color themes. Write: create and edit custom themes.',
    sources: 'Read: view per-source status. Write: create, edit, enable/disable, and delete data sources.',
    channel_database: 'Read: list global PSK library entries. Write: create/edit/delete entries used for MQTT decryption.',
  };

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
              <button
                className="button button-secondary"
                onClick={() => handlePermanentDeleteUser(selectedUser)}
                disabled={selectedUser.id === authStatus.user?.id || selectedUser.username === 'anonymous'}
                style={{ color: 'var(--ctp-red)', backgroundColor: 'var(--ctp-surface0)' }}
                title={selectedUser.username === 'anonymous' ? t('users.cannot_delete_anonymous') : t('users.permanently_delete_hint')}
              >
                {t('users.permanently_delete')}
              </button>
            </div>

            <h3>{t('users.permissions')}</h3>

            {/* PR-C: Global Resources section — themes, sources, channel_database
                and any other non-sourcey grants. The source-scope dropdown
                below does NOT affect these rows; the server stores them at
                sourceId=null. */}
            {GLOBAL_PERMISSION_RESOURCES.length > 0 && (
              <>
                <h4 style={{ marginTop: '12px' }}>
                  {t('users.global_resources', 'Global Resources')}
                </h4>
                <p className="text-xs text-gray-500" style={{ marginTop: 0 }}>
                  {t(
                    'users.global_resources_hint',
                    'Apply across the whole installation — not affected by the source scope below.',
                  )}
                </p>
                <div className="permissions-grid">
                  {GLOBAL_PERMISSION_RESOURCES.map(resource => {
                    const label = labelMap[resource]
                      || resource.charAt(0).toUpperCase() + resource.slice(1);
                    const tooltip = tooltipMap[resource] || '';
                    return (
                      <div key={`global-${resource}`} className="permission-item">
                        <div className="permission-label" title={tooltip}>{label}</div>
                        <div className="permission-actions">
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
                        </div>
                      </div>
                    );
                  })}
                </div>
                <h4 style={{ marginTop: '16px' }}>
                  {t('users.per_source_resources', 'Per-Source Resources')}
                </h4>
              </>
            )}

            {sources.length > 0 && (
              <div className="permission-scope-selector">
                <label htmlFor="permission-scope-select">{t('users.permission_scope')}:</label>
                <select
                  id="permission-scope-select"
                  value={permissionScope ?? ''}
                  onChange={e => handlePermissionScopeChange(e.target.value || null)}
                  className="permission-scope-select"
                >
                  {/* PR-C: group sources by type. Source.type comes from the
                      sources repository (`meshtastic_tcp` | `mqtt_broker` |
                      `mqtt_bridge` | `meshcore`) — bucket each option under
                      a labelled <optgroup>. Unknown types fall into "Other". */}
                  {(() => {
                    const groupLabels: Record<string, string> = {
                      meshtastic_tcp: t('source.type.meshtastic_tcp', 'Meshtastic (TCP/Serial)'),
                      meshtastic_mqtt: t('source.type.meshtastic_mqtt', 'Meshtastic (MQTT)'),
                      tcp: t('source.type.tcp', 'TCP'),
                      serial: t('source.type.serial', 'Serial'),
                      mqtt_broker: t('source.type.mqtt_broker', 'MQTT Broker'),
                      mqtt_bridge: t('source.type.mqtt_bridge', 'MQTT Bridge'),
                      meshcore: t('source.type.meshcore', 'MeshCore'),
                      other: t('source.type.other', 'Other'),
                    };
                    const byType = new Map<string, Source[]>();
                    sources.forEach(s => {
                      const key = (s.type && groupLabels[s.type]) ? s.type : 'other';
                      if (!byType.has(key)) byType.set(key, []);
                      byType.get(key)!.push(s);
                    });
                    // Stable order: known types first, then 'other'.
                    const order = ['meshtastic_tcp', 'meshtastic_mqtt', 'tcp', 'serial', 'mqtt_broker', 'mqtt_bridge', 'meshcore', 'other'];
                    return order
                      .filter(t => byType.has(t))
                      .map(t => (
                        <optgroup key={t} label={groupLabels[t]}>
                          {byType.get(t)!.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </optgroup>
                      ));
                  })()}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {t('users.source_permissions_hint', 'All permissions are granted per-source.')}
                </p>
              </div>
            )}

            {/* For MQTT sources the slot-indexed channel_0..7 grid doesn't
                map to a stable channel identity — different upstream nodes
                use different channels in their own slot 0, so a grant on
                channel_0 silently protects whichever name "won" the slot
                most recently. MQTT-sourced rows are instead permission-keyed
                through channel_database_permissions (the Virtual Channel
                Permissions section below). Hide the grid's channel rows
                here and show a pointer to where admins should actually
                grant access. */}
              {(() => {
                const scopedSource = sources.find(s => s.id === permissionScope);
                const isMqttScope = scopedSource?.type === 'mqtt_broker' || scopedSource?.type === 'mqtt_bridge';
                return isMqttScope ? (
                  <div className="permission-hint" style={{ margin: '8px 0 12px', padding: '8px 12px', background: 'var(--bg-soft, #f5f5f5)', borderLeft: '3px solid var(--accent, #2563eb)', borderRadius: '4px' }}>
                    {t(
                      'users.mqtt_channel_permissions_hint',
                      'Channel permissions for MQTT sources are managed under Virtual Channel Permissions below — MQTT channels are identified by name across all sources, not by per-source slot.',
                    )}
                  </div>
                ) : null;
              })()}

            <div className="permissions-grid">
              {/* PR-C: only render sourcey resources here. Globals are in the
                  Global Resources section above; mixing them led to the
                  scope dropdown looking like it affected themes/sources.
                  MQTT scopes additionally hide channel_0..7 rows — see the
                  hint banner just above this grid for the rationale. */}
              {PERMISSION_KEYS.filter(r => {
                if (!SOURCEY_RESOURCES.includes(r as ResourceType)) return false;
                const scopedSource = sources.find(s => s.id === permissionScope);
                const isMqttScope = scopedSource?.type === 'mqtt_broker' || scopedSource?.type === 'mqtt_bridge';
                if (isMqttScope && String(r).startsWith('channel_')) return false;
                return true;
              }).map(resource => {
                // Get label from translated map or format it
                let label = resource.charAt(0).toUpperCase() + resource.slice(1);

                if (resource.startsWith('channel_')) {
                  const channelNum = resource.split('_')[1];
                  const chName = channelNames.get(Number(channelNum));
                  const baseLabel = channelNum === '0' ? t('users.channel_primary') : t('users.channel_n', { n: channelNum });
                  label = chName ? `${baseLabel} (${chName})` : baseLabel;
                } else {
                  label = labelMap[resource] || label;
                }

                const tooltip = resource.startsWith('channel_')
                  ? 'View on Map: show nodes heard on this channel. Read: view messages. Write: send messages.'
                  : tooltipMap[resource] || '';

                return (
                  <div key={resource} className="permission-item">
                    <div className="permission-label" title={tooltip}>{label}</div>
                    <div className="permission-actions">
                      {resource === 'packetmonitor' ? (
                        // Packet Monitor is read-only, no write permission
                        <label>
                          <input
                            type="checkbox"
                            checked={permissions[resource]?.read || false}
                            onChange={() => togglePermission(resource, 'read')}
                          />
                          {t('users.read')}
                        </label>
                      ) : (resource === 'connection' || resource === 'traceroute') ? (
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
                      ) : resource.startsWith('channel_') ? (
                        // Channel permissions use three checkboxes: viewOnMap, read, write
                        <>
                          <label>
                            <input
                              type="checkbox"
                              checked={permissions[resource]?.viewOnMap || false}
                              onChange={() => toggleChannelViewOnMap(resource)}
                            />
                            {t('users.view_on_map')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={permissions[resource]?.read || false}
                              disabled={permissions[resource]?.write || false}
                              onChange={() => toggleChannelRead(resource)}
                            />
                            {t('users.read_messages')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={permissions[resource]?.write || false}
                              onChange={() => toggleChannelWrite(resource)}
                            />
                            {t('users.send_messages')}
                          </label>
                        </>
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

            {/* Virtual Channel (Channel Database) Permissions */}
            {channelDatabaseEntries.length > 0 && (
              <>
                <h3 style={{ marginTop: '24px' }}>{t('users.channel_database_permissions')}</h3>
                <div className="permissions-grid">
                  {channelDatabaseEntries.map(entry => {
                    const perm = getChannelDbPermission(entry.id);
                    return (
                      <div key={`channeldb-${entry.id}`} className="permission-item">
                        <div className="permission-label">
                          {entry.name}
                          {entry.description && (
                            <span className="permission-description" style={{ fontSize: '0.85em', color: 'var(--text-muted)', marginLeft: '8px' }}>
                              ({entry.description})
                            </span>
                          )}
                        </div>
                        <div className="permission-actions">
                          <label>
                            <input
                              type="checkbox"
                              checked={perm.canViewOnMap}
                              onChange={() => toggleChannelDbViewOnMap(entry.id)}
                            />
                            {t('users.view_on_map')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={perm.canRead}
                              disabled={perm.canWrite ?? false}
                              onChange={() => toggleChannelDbRead(entry.id)}
                            />
                            {t('users.read_messages')}
                          </label>
                          {/* PR-C: canWrite column for channel-database
                              entries. The legacy /api/users/:id/
                              channel-database-permissions PUT in this
                              repository currently accepts {canViewOnMap,
                              canRead} only — sending canWrite is a
                              forward-compatible no-op until PR-B lands the
                              schema column and route extension. The UI
                              reflects the intent regardless so an admin
                              flipping the box sees their selection persist
                              client-side for the session. NOTE: a per-row
                              revoke (✕) button was considered, but the
                              legacy router exposes no DELETE endpoint for
                              /api/channel-database/:id/permissions/:userId
                              and rather than mounting one in PR-C (PR-B's
                              territory) we leave the UX to "clear both
                              boxes and Save" — that branch in
                              updateChannelDbPermission deletes the row. */}
                          <label>
                            <input
                              type="checkbox"
                              checked={perm.canWrite ?? false}
                              onChange={() => toggleChannelDbWrite(entry.id)}
                            />
                            {t('users.write')}
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <button className="button button-primary" onClick={handleUpdateChannelDbPermissions}>
                  {t('users.save_channel_db_permissions')}
                </button>
              </>
            )}
            {channelDatabaseEntries.length === 0 && (
              <p style={{ marginTop: '16px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {t('users.no_channel_database_entries')}
              </p>
            )}
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

      {/* Permanent Delete User Confirmation Modal */}
      {showPermanentDeleteConfirm && userToPermanentlyDelete && (
        <div className="modal-overlay" onClick={() => setShowPermanentDeleteConfirm(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('users.permanent_delete_confirm')}</h2>
              <button className="close-button" onClick={() => setShowPermanentDeleteConfirm(false)}>×</button>
            </div>

            <div className="modal-body">
              <p><Trans i18nKey="users.permanent_delete_confirm_text" values={{ username: userToPermanentlyDelete.username }} components={{ strong: <strong /> }} /></p>
              <p style={{ color: 'var(--ctp-red)', marginTop: '1rem', fontWeight: 'bold' }}>
                {t('users.permanent_delete_warning')}
              </p>
              <p style={{ marginTop: '0.5rem', fontSize: '0.9em', color: 'var(--ctp-subtext0)' }}>
                {t('users.permanent_delete_details')}
              </p>

              <div className="modal-actions">
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setShowPermanentDeleteConfirm(false);
                    setUserToPermanentlyDelete(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="button button-primary"
                  onClick={confirmPermanentDeleteUser}
                  style={{ backgroundColor: 'var(--ctp-red)', borderColor: 'var(--ctp-red)' }}
                >
                  {t('users.permanently_delete')}
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
