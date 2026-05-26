/**
 * MeshCoreRoomsView -- room server message board UI.
 *
 * Room servers (advType=3) are BBS-style nodes that store posts and push-sync
 * them to connected clients. This view mirrors the Channels layout: left pane
 * lists discovered room servers, right pane shows the selected room's message
 * stream via the shared MeshCoreMessageStream component.
 *
 * Room posts are distinguished from DMs/channel messages by
 * `messageType === 'room_post'` and scoped to a room via `toPublicKey`.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreMessage, MeshCoreActions, ConnectionStatus } from './hooks/useMeshCore';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { useAuth } from '../../contexts/AuthContext';

interface MeshCoreRoomsViewProps {
  messages: MeshCoreMessage[];
  contacts: MeshCoreContact[];
  status: ConnectionStatus | null;
  actions: MeshCoreActions;
  baseUrl: string;
  sourceId: string;
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

export const MeshCoreRoomsView: React.FC<MeshCoreRoomsViewProps> = ({
  messages,
  contacts,
  status,
  actions,
  sourceId: _sourceId,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canSend = hasPermission('messages', 'write');

  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [loggedInRooms, setLoggedInRooms] = useState<Set<string>>(new Set());
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

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

  const isLoggedIn = useCallback(
    (pubkey: string) => loggedInRooms.has(pubkey),
    [loggedInRooms],
  );

  const handleSelectRoom = useCallback((pubkey: string) => {
    setSelectedRoom(pubkey);
    setLoginError(null);
    setLoginPassword('');
  }, []);

  const handleLogin = useCallback(async () => {
    if (!selectedRoom) return;
    setLoginLoading(true);
    setLoginError(null);
    try {
      const result = await actions.loginRoom(selectedRoom, loginPassword);
      if (result.success) {
        setLoggedInRooms(prev => new Set(prev).add(selectedRoom));
        setLoginPassword('');
      } else {
        setLoginError(result.error || t('meshcore.rooms.login_failed', 'Login failed'));
      }
    } catch {
      setLoginError(t('meshcore.rooms.login_failed', 'Login failed'));
    } finally {
      setLoginLoading(false);
    }
  }, [selectedRoom, loginPassword, actions, t]);

  const handleSend = useCallback(async (text: string): Promise<boolean> => {
    if (!selectedRoom) return false;
    return actions.sendRoomPost(selectedRoom, text);
  }, [selectedRoom, actions]);

  const selfKey = status?.localNode?.publicKey;
  const connected = status?.connected ?? false;

  const showLoginOverlay = selectedRoom && !isLoggedIn(selectedRoom);

  return (
    <div className="meshcore-two-pane">
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
            return (
              <button
                key={room.publicKey}
                className={`mc-channel-row ${selectedRoom === room.publicKey ? 'selected' : ''}`}
                onClick={() => handleSelectRoom(room.publicKey)}
              >
                <div className="mc-channel-row-name">
                  <span className={`mc-room-row-status ${loggedIn ? 'logged-in' : 'not-logged-in'}`}>
                    {loggedIn ? '●' : '○'}
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
        {!selectedRoom && (
          <div className="meshcore-empty-state">
            {t('meshcore.rooms.select_room', 'Select a room server to view posts')}
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
          <MeshCoreMessageStream
            messages={filtered}
            contacts={contacts}
            selfPublicKey={selfKey}
            disabled={!connected || !canSend}
            emptyText={t('meshcore.rooms.no_messages', 'No posts in this room yet')}
            onSend={handleSend}
          />
        )}
      </div>
    </div>
  );
};
