/**
 * MeshCoreRoomsView -- room server message board UI.
 *
 * Room servers (advType=3) are BBS-style nodes that store posts and push-sync
 * them to connected clients. This view mirrors the Channels layout: left pane
 * lists discovered room servers, right pane shows the selected room's message
 * stream via the shared MeshCoreMessageStream component.
 *
 * Features:
 *   - Credential persistence (remember password / auto-login with saved creds)
 *   - Room stats header (post count from message stream)
 *   - Sync-since tracking (newest post timestamp)
 *   - Auto-sync configuration (periodic re-login interval)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreMessage, MeshCoreActions, ConnectionStatus } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { useAuth } from '../../contexts/AuthContext';
import { UiIcon } from '../icons';

const MOBILE_BREAKPOINT = 768;
const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT;

interface MeshCoreRoomsViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  baseUrl: string;
  sourceId: string;
  onNodeNameClick?: (publicKey: string) => void;
}

function buildRoomFilter(roomPubkey: string): (m: MeshCoreMessage) => boolean {
  return (m) => {
    if (m.messageType !== 'room_post') return false;
    if (!m.toPublicKey) return false;
    return m.toPublicKey === roomPubkey ||
      m.toPublicKey.startsWith(roomPubkey) ||
      roomPubkey.startsWith(m.toPublicKey);
  };
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

export const MeshCoreRoomsView: React.FC<MeshCoreRoomsViewProps> = ({
  messages,
  contacts,
  status,
  actions,
  sourceId: _sourceId,
  onNodeNameClick,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canSend = hasPermission('messages', 'write');
  const canConfig = hasPermission('configuration', 'write');

  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [loggedInRooms, setLoggedInRooms] = useState<Set<string>>(new Set());
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [mobileShowContent, setMobileShowContent] = useState(false);

  useEffect(() => {
    const onResize = () => {
      if (!isMobileViewport()) setMobileShowContent(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Credential persistence state
  const [canRemember, setCanRemember] = useState(false);
  const [storedCreds, setStoredCreds] = useState<Set<string>>(new Set());
  const autoLoginAttempted = useRef<Set<string>>(new Set());

  // Sync config state (for selected room)
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncInterval, setSyncInterval] = useState(60);
  const [syncConfigDirty, setSyncConfigDirty] = useState(false);

  // Fetch credential capability on mount
  useEffect(() => {
    void (async () => {
      const creds = await actions.getRoomCredentials();
      if (creds) {
        setCanRemember(creds.canRemember);
        setStoredCreds(new Set(creds.stored.map(s => s.publicKey)));
      }
    })();
  }, [actions]);

  const roomServers = useMemo(
    () => contacts.filter(c => c.advType === 3),
    [contacts],
  );

  const activeRoom = useMemo(
    () => roomServers.find(r => r.publicKey === selectedRoom) ?? null,
    [roomServers, selectedRoom],
  );

  const activeFilter = useMemo(
    () => selectedRoom ? buildRoomFilter(selectedRoom) : () => false,
    [selectedRoom],
  );

  const filtered = useMemo(
    () => messages.filter(activeFilter),
    [messages, activeFilter],
  );

  const newestPostTs = useMemo(() => {
    if (filtered.length === 0) return null;
    return Math.max(...filtered.map(m => m.timestamp));
  }, [filtered]);

  const isLoggedIn = useCallback(
    (pubkey: string) => loggedInRooms.has(pubkey),
    [loggedInRooms],
  );

  // Auto-login when selecting a room with saved credentials
  useEffect(() => {
    if (!selectedRoom) return;
    if (loggedInRooms.has(selectedRoom)) return;
    if (!storedCreds.has(selectedRoom)) return;
    if (autoLoginAttempted.current.has(selectedRoom)) return;

    autoLoginAttempted.current.add(selectedRoom);
    void (async () => {
      setLoginLoading(true);
      const result = await actions.loginRoomWithSaved(selectedRoom);
      if (result.success) {
        setLoggedInRooms(prev => new Set(prev).add(selectedRoom));
      }
      setLoginLoading(false);
    })();
  }, [selectedRoom, loggedInRooms, storedCreds, actions]);

  const loadSyncConfig = useCallback(async (pubkey: string) => {
    const config = await actions.getRoomSyncConfig(pubkey);
    if (config) {
      setSyncEnabled(config.enabled);
      setSyncInterval(config.intervalMinutes);
    } else {
      setSyncEnabled(false);
      setSyncInterval(60);
    }
    setSyncConfigDirty(false);
  }, [actions]);

  const handleSelectRoom = useCallback((pubkey: string) => {
    setSelectedRoom(pubkey);
    setLoginError(null);
    setLoginPassword('');
    setRememberPassword(false);
    setSyncConfigDirty(false);
    void loadSyncConfig(pubkey);
    if (isMobileViewport()) setMobileShowContent(true);
  }, [loadSyncConfig]);

  const handleLogin = useCallback(async () => {
    if (!selectedRoom) return;
    setLoginLoading(true);
    setLoginError(null);
    try {
      const result = await actions.loginRoom(selectedRoom, loginPassword, rememberPassword);
      if (result.success) {
        setLoggedInRooms(prev => new Set(prev).add(selectedRoom));
        if (result.persisted) {
          setStoredCreds(prev => new Set(prev).add(selectedRoom));
        }
        setLoginPassword('');
      } else {
        setLoginError(result.error || t('meshcore.rooms.login_failed', 'Login failed'));
      }
    } catch {
      setLoginError(t('meshcore.rooms.login_failed', 'Login failed'));
    } finally {
      setLoginLoading(false);
    }
  }, [selectedRoom, loginPassword, rememberPassword, actions, t]);

  const handleSend = useCallback(async (text: string): Promise<boolean> => {
    if (!selectedRoom) return false;
    return actions.sendRoomPost(selectedRoom, text);
  }, [selectedRoom, actions]);

  const handleSaveSyncConfig = useCallback(async () => {
    if (!selectedRoom) return;
    const ok = await actions.setRoomSyncConfig(selectedRoom, syncEnabled, syncInterval);
    if (ok) setSyncConfigDirty(false);
  }, [selectedRoom, syncEnabled, syncInterval, actions]);

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;

  const showLoginOverlay = selectedRoom && !isLoggedIn(selectedRoom) && !loginLoading;

  const mobileClass = mobileShowContent ? 'mobile-show-content' : 'mobile-show-list';

  return (
    <div className={`meshcore-two-pane ${mobileClass}`}>
      <div className="meshcore-list-pane">
        <div className="meshcore-list-pane-header">
          <span>{t('meshcore.nav.rooms', 'Rooms')}</span>
          <span className="pane-count">{roomServers.length}</span>
        </div>
        <div className="meshcore-list-pane-body">
          {roomServers.length === 0 && (
            <div className="mc-channel-row" style={{ opacity: 0.6 }}>
              <div className="mc-channel-row-name">
                {t('meshcore.rooms.no_rooms', 'No room servers discovered yet')}
              </div>
            </div>
          )}
          {roomServers.map(room => {
            const filter = buildRoomFilter(room.publicKey);
            const count = messages.filter(filter).length;
            const loggedIn = isLoggedIn(room.publicKey);
            const hasSaved = storedCreds.has(room.publicKey);
            return (
              <button
                key={room.publicKey}
                className={`mc-channel-row ${selectedRoom === room.publicKey ? 'selected' : ''}`}
                onClick={() => handleSelectRoom(room.publicKey)}
              >
                <div className="mc-channel-row-name">
                  <span className={`mc-room-row-status ${loggedIn ? 'logged-in' : hasSaved ? 'has-saved' : 'not-logged-in'}`}>
                    <UiIcon name={loggedIn ? 'statusOn' : hasSaved ? 'statusPartial' : 'statusOff'} size={12} />
                  </span>
                  {' '}
                  {room.advName || room.name || room.publicKey.substring(0, 12) + '…'}
                </div>
                <div className="mc-channel-row-meta">
                  {count} {t('meshcore.messages', 'messages')}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="meshcore-main-pane">
        {mobileShowContent && (
          <div className="meshcore-mobile-back-header">
            <button
              type="button"
              className="meshcore-mobile-back-btn"
              onClick={() => setMobileShowContent(false)}
            >
              <UiIcon name="back" size={15} /> {t('common.back', 'Back')}
            </button>
            {activeRoom && (
              <span className="meshcore-mobile-back-title">
                {activeRoom.advName || activeRoom.name || selectedRoom?.substring(0, 12) + '…'}
              </span>
            )}
          </div>
        )}
        {!selectedRoom && (
          <div className="meshcore-empty-state">
            {t('meshcore.rooms.select_room', 'Select a room server to view posts')}
          </div>
        )}

        {selectedRoom && loginLoading && (
          <div className="meshcore-empty-state">
            {t('meshcore.rooms.logging_in', 'Logging in…')}
          </div>
        )}

        {showLoginOverlay && (
          <div className="meshcore-room-login-overlay">
            <div className="meshcore-room-login-card">
              <h3>{t('meshcore.rooms.login_title', 'Login to Room Server')}</h3>
              <p className="meshcore-room-login-name">
                {activeRoom?.advName || activeRoom?.name || selectedRoom.substring(0, 16) + '…'}
              </p>
              <input
                type="password"
                className="meshcore-room-login-input"
                value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !loginLoading && handleLogin()}
                placeholder={t('meshcore.rooms.password_placeholder', 'Password (empty for guest)')}
                disabled={loginLoading}
                autoFocus
              />
              {canRemember && (
                <label className="meshcore-room-login-remember">
                  <input
                    type="checkbox"
                    checked={rememberPassword}
                    onChange={e => setRememberPassword(e.target.checked)}
                  />
                  {t('meshcore.rooms.remember_password', 'Remember password')}
                </label>
              )}
              <button
                className="meshcore-room-login-btn"
                onClick={handleLogin}
                disabled={loginLoading}
              >
                {loginLoading
                  ? t('meshcore.rooms.logging_in', 'Logging in…')
                  : t('meshcore.rooms.login_button', 'Login')}
              </button>
              {loginError && (
                <div className="meshcore-room-login-error">{loginError}</div>
              )}
            </div>
          </div>
        )}

        {selectedRoom && isLoggedIn(selectedRoom) && (
          <>
            {/* Room stats header */}
            <div className="meshcore-room-stats-header">
              <span className="meshcore-room-stats-name">
                {activeRoom?.advName || activeRoom?.name || selectedRoom.substring(0, 16) + '…'}
              </span>
              <span className="meshcore-room-stats-info">
                {filtered.length} {t('meshcore.rooms.posts', 'posts')}
                {newestPostTs && (
                  <> &middot; {t('meshcore.rooms.last_post', 'last')}: {formatTimestamp(newestPostTs)}</>
                )}
              </span>
              {/* Sync config toggle */}
              {canConfig && (
                <span className="meshcore-room-sync-config">
                  <label title={t('meshcore.rooms.sync_enabled_tooltip', 'Periodically re-login to fetch new posts')}>
                    <input
                      type="checkbox"
                      checked={syncEnabled}
                      onChange={e => { setSyncEnabled(e.target.checked); setSyncConfigDirty(true); }}
                    />
                    {t('meshcore.rooms.auto_sync', 'Auto-sync')}
                  </label>
                  {syncEnabled && (
                    <select
                      value={syncInterval}
                      onChange={e => { setSyncInterval(Number(e.target.value)); setSyncConfigDirty(true); }}
                    >
                      <option value={60}>1h</option>
                      <option value={120}>2h</option>
                      <option value={240}>4h</option>
                      <option value={480}>8h</option>
                      <option value={720}>12h</option>
                      <option value={1440}>24h</option>
                    </select>
                  )}
                  {syncConfigDirty && (
                    <button className="meshcore-room-sync-save" onClick={handleSaveSyncConfig}>
                      {t('meshcore.rooms.save_sync', 'Save')}
                    </button>
                  )}
                </span>
              )}
            </div>
            <MeshCoreMessageStream
              messages={filtered}
              contacts={contacts}
              selfPublicKey={selfKey}
              disabled={!connected || !canSend}
              emptyText={t('meshcore.rooms.no_messages', 'No posts in this room yet')}
              onSend={handleSend}
              onNodeNameClick={onNodeNameClick}
              conversationKey={`room-${selectedRoom}`}
            />
          </>
        )}
      </div>
    </div>
  );
};
