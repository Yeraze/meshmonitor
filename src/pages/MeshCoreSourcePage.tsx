/**
 * MeshCoreSourcePage — per-source MeshCore dashboard.
 *
 * Slice 4 of the MeshCore-as-source refactor. Mirrors the per-source
 * Meshtastic dashboard structurally — connection panel, nodes/contacts,
 * channels-as-messages, message send — but talks to the nested
 * `/api/sources/:id/meshcore/*` routes that slice 2 introduced.
 *
 * Permission gating uses `hasPermission(resource, action, { sourceId })` with
 * the per-source sourcey resources slice 3 introduced (`connection`,
 * `configuration`, `nodes`, `messages`). Channels are lumped under `messages`
 * for v1 — per-channel `mc_channel_N` resources can land later if needed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../components/ToastContainer';
import { useAuth } from '../contexts/AuthContext';
import { useSource } from '../contexts/SourceContext';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useWebSocketContext } from '../contexts/WebSocketContext';
import type {
  MeshCoreMessageEvent,
  MeshCoreContactUpdateEvent,
  MeshCoreStatusUpdateEvent,
  MeshCoreLocalNodeUpdateEvent,
} from '../hooks/useWebSocket';
import LoginModal from '../components/LoginModal';
import UserMenu from '../components/UserMenu';
import { appBasename } from '../init';
import '../components/MeshCore/MeshCoreTab.css';

interface MeshCoreNode {
  publicKey: string;
  name: string;
  advType: number;
  txPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
  lastHeard?: number;
  rssi?: number;
  snr?: number;
  batteryMv?: number;
  uptimeSecs?: number;
  latitude?: number;
  longitude?: number;
}

interface MeshCoreContact {
  publicKey: string;
  advName?: string;
  name?: string;
  advType?: number;
  rssi?: number;
  snr?: number;
  latitude?: number;
  longitude?: number;
  lastSeen?: number;
}

interface MeshCoreMessage {
  id: string;
  fromPublicKey: string;
  toPublicKey?: string;
  text: string;
  timestamp: number;
}

interface ConnectionStatus {
  connected: boolean;
  deviceType: number;
  deviceTypeName: string;
  config: Record<string, unknown> | null;
  localNode: MeshCoreNode | null;
}

const DEVICE_TYPE_KEYS: Record<number, string> = {
  0: 'meshcore.device_type.unknown',
  1: 'meshcore.device_type.companion',
  2: 'meshcore.device_type.repeater',
  3: 'meshcore.device_type.room_server',
};

/** Returns the per-source meshcore base path: /api/sources/:id/meshcore */
function buildBase(sourceId: string): string {
  return `${appBasename}/api/sources/${encodeURIComponent(sourceId)}/meshcore`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function MeshCoreSourceInner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sourceId } = useSource();
  const { authStatus, hasPermission } = useAuth();
  const csrfFetch = useCsrfFetch();
  const isAuthenticated = authStatus?.authenticated ?? false;

  const base = sourceId ? buildBase(sourceId) : '';

  // Per-source permissions — sourceId is auto-bound by useAuth via SourceContext.
  const canReadConnection = hasPermission('connection', 'read');
  const canWriteConnection = hasPermission('connection', 'write');
  const canReadNodes = hasPermission('nodes', 'read');
  const canWriteNodes = hasPermission('nodes', 'write');
  const canReadMessages = hasPermission('messages', 'read');
  const canWriteMessages = hasPermission('messages', 'write');

  const [showLogin, setShowLogin] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [nodes, setNodes] = useState<MeshCoreNode[]>([]);
  const [contacts, setContacts] = useState<MeshCoreContact[]>([]);
  const [messages, setMessages] = useState<MeshCoreMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [messageText, setMessageText] = useState('');
  const [selectedContact, setSelectedContact] = useState<string>('');

  const connectedRef = useRef(false);
  // Newest message timestamp seen — used by reconnect catch-up to request only
  // messages we missed while the socket was down.
  const seqCursorRef = useRef<number>(0);
  // Local-node + contacts map are the source of truth for deriving `nodes`
  // after push events arrive. The snapshot seeds both; events keep them fresh.
  const localNodeRef = useRef<MeshCoreNode | null>(null);
  const contactsRef = useRef<Map<string, MeshCoreContact>>(new Map());

  const { state: wsState } = useWebSocketContext();
  const socket = wsState.socket;

  const contactToNode = useCallback((c: MeshCoreContact): MeshCoreNode => ({
    publicKey: c.publicKey,
    name: c.advName || c.name || 'Unknown',
    advType: c.advType ?? 0,
    lastHeard: c.lastSeen,
    rssi: c.rssi,
    snr: c.snr,
    latitude: c.latitude,
    longitude: c.longitude,
  }), []);

  const recomputeNodes = useCallback(() => {
    const merged: MeshCoreNode[] = [];
    if (localNodeRef.current) merged.push(localNodeRef.current);
    for (const c of contactsRef.current.values()) merged.push(contactToNode(c));
    setNodes(merged);
  }, [contactToNode]);

  // -- snapshot (initial load) ----------------------------------------------

  const loadSnapshot = useCallback(async (): Promise<boolean> => {
    if (!base || !canReadConnection) return false;
    try {
      const res = await csrfFetch(`${base}/snapshot`);
      const data = await res.json();
      if (!data.success) return false;
      const snap = data.data;
      setStatus(snap.status);
      localNodeRef.current = snap.status?.localNode ?? null;
      contactsRef.current = new Map(
        (snap.contacts ?? []).map((c: MeshCoreContact) => [c.publicKey, c]),
      );
      setContacts(snap.contacts ?? []);
      setNodes(snap.nodes ?? []);
      setMessages(snap.messages ?? []);
      seqCursorRef.current = snap.seqCursor ?? 0;
      return snap.status?.connected ?? false;
    } catch (err) {
      if (isAuthenticated) console.error('Failed to load meshcore snapshot:', err);
      return false;
    }
  }, [base, canReadConnection, csrfFetch, isAuthenticated]);

  // -- status-only safety-net poll (30s) ------------------------------------

  const fetchStatus = useCallback(async (): Promise<boolean> => {
    if (!base || !canReadConnection) return false;
    try {
      const res = await csrfFetch(`${base}/status`);
      const data = await res.json();
      if (data.success) {
        setStatus(data.data);
        localNodeRef.current = data.data?.localNode ?? localNodeRef.current;
        return data.data.connected ?? false;
      }
    } catch (err) {
      if (isAuthenticated) console.error('Failed to fetch meshcore status:', err);
    }
    return false;
  }, [base, canReadConnection, csrfFetch, isAuthenticated]);

  useEffect(() => {
    connectedRef.current = status?.connected ?? false;
  }, [status?.connected]);

  useEffect(() => {
    if (!base) return;
    void loadSnapshot();
    const interval = setInterval(() => { void fetchStatus(); }, 30000);
    return () => clearInterval(interval);
  }, [base, loadSnapshot, fetchStatus]);

  // -- push events ----------------------------------------------------------

  useEffect(() => {
    if (!socket || !sourceId) return;

    const joinRoom = () => {
      socket.emit('join-source', sourceId);
    };
    // If the socket is already connected when this effect runs, join now.
    // Otherwise the 'connect' handler below will join when it fires.
    if (socket.connected) joinRoom();
    socket.on('connect', joinRoom);

    const onMessage = (msg: MeshCoreMessageEvent) => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      if (msg.timestamp > seqCursorRef.current) seqCursorRef.current = msg.timestamp;
    };

    const onContactUpdated = (evt: MeshCoreContactUpdateEvent) => {
      if (evt.sourceId !== sourceId) return;
      const c = evt.contact;
      contactsRef.current.set(c.publicKey, c as MeshCoreContact);
      setContacts(Array.from(contactsRef.current.values()));
      recomputeNodes();
    };

    const onStatusUpdated = (evt: MeshCoreStatusUpdateEvent) => {
      if (evt.sourceId !== sourceId) return;
      setStatus(prev => {
        if (!prev) {
          return {
            connected: evt.connected,
            deviceType: 0,
            deviceTypeName: '',
            config: null,
            localNode: (evt.node as MeshCoreNode | null) ?? null,
          };
        }
        return {
          ...prev,
          connected: evt.connected,
          localNode: (evt.node as MeshCoreNode | null) ?? prev.localNode,
        };
      });
      if (evt.node) localNodeRef.current = evt.node as MeshCoreNode;
    };

    const onLocalNodeUpdated = (evt: MeshCoreLocalNodeUpdateEvent) => {
      if (evt.sourceId !== sourceId) return;
      localNodeRef.current = evt.node as MeshCoreNode;
      setStatus(prev => (prev ? { ...prev, localNode: evt.node as MeshCoreNode } : prev));
      recomputeNodes();
    };

    // Reconnect catch-up: pull any messages we missed while disconnected, then
    // rejoin the room (the 'connect' handler above also handles the rejoin).
    const onReconnect = () => {
      if (!base || !canReadMessages) return;
      const since = seqCursorRef.current;
      void (async () => {
        try {
          const res = await csrfFetch(`${base}/messages?since=${since}`);
          const data = await res.json();
          if (data.success && Array.isArray(data.data) && data.data.length > 0) {
            setMessages(prev => {
              const seen = new Set(prev.map(m => m.id));
              const additions = (data.data as MeshCoreMessage[]).filter(
                m => !seen.has(m.id),
              );
              if (additions.length === 0) return prev;
              for (const m of additions) {
                if (m.timestamp > seqCursorRef.current) seqCursorRef.current = m.timestamp;
              }
              return [...prev, ...additions];
            });
          }
        } catch (err) {
          if (isAuthenticated) console.error('MeshCore reconnect catch-up failed:', err);
        }
      })();
    };

    socket.on('meshcore:message', onMessage);
    socket.on('meshcore:contact:updated', onContactUpdated);
    socket.on('meshcore:status:updated', onStatusUpdated);
    socket.on('meshcore:local-node:updated', onLocalNodeUpdated);
    socket.io.on('reconnect', onReconnect);

    return () => {
      socket.off('connect', joinRoom);
      socket.off('meshcore:message', onMessage);
      socket.off('meshcore:contact:updated', onContactUpdated);
      socket.off('meshcore:status:updated', onStatusUpdated);
      socket.off('meshcore:local-node:updated', onLocalNodeUpdated);
      socket.io.off('reconnect', onReconnect);
    };
  }, [socket, sourceId, base, canReadMessages, csrfFetch, isAuthenticated, recomputeNodes]);

  // -- actions ---------------------------------------------------------------

  const handleConnect = async () => {
    if (!sourceId || !canWriteConnection) return;
    setLoading(true);
    setError(null);
    try {
      // The generic /api/sources/:id/connect endpoint pulls connection params
      // from the saved source.config, so we don't need to send a body.
      const res = await csrfFetch(
        `${appBasename}/api/sources/${encodeURIComponent(sourceId)}/connect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      const data = await res.json();
      if (!data.success) setError(data.error || t('meshcore.connect_failed', 'Connection failed'));
      await fetchStatus();
    } catch (err) {
      setError(t('meshcore.connect_failed', 'Connection failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!sourceId || !canWriteConnection) return;
    setLoading(true);
    try {
      await csrfFetch(
        `${appBasename}/api/sources/${encodeURIComponent(sourceId)}/disconnect`,
        { method: 'POST' },
      );
      await fetchStatus();
      contactsRef.current.clear();
      localNodeRef.current = null;
      setNodes([]);
      setContacts([]);
      setMessages([]);
    } catch (err) {
      console.error('Disconnect error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshContacts = async () => {
    if (!base || !canWriteNodes) return;
    setLoading(true);
    try {
      const res = await csrfFetch(`${base}/contacts/refresh`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const fresh = (data.data ?? []) as MeshCoreContact[];
        contactsRef.current = new Map(fresh.map(c => [c.publicKey, c]));
        setContacts(fresh);
        recomputeNodes();
      }
    } catch (err) {
      console.error('Refresh contacts error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSendAdvert = async () => {
    if (!base || !canWriteConnection) return;
    try {
      const res = await csrfFetch(`${base}/advert`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) setError(data.error || t('meshcore.advert_failed', 'Failed to send advert'));
    } catch (err) {
      setError(t('meshcore.advert_failed', 'Failed to send advert'));
    }
  };

  const handleSendMessage = async () => {
    if (!base || !canWriteMessages || !messageText.trim()) return;
    try {
      const res = await csrfFetch(`${base}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: messageText,
          toPublicKey: selectedContact || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMessageText('');
        // The server emits `meshcore:message` for outbound sends too, so the
        // message will arrive via the socket listener.
      } else {
        setError(data.error || t('meshcore.send_failed', 'Failed to send message'));
      }
    } catch (err) {
      setError(t('meshcore.send_failed', 'Failed to send message'));
    }
  };

  // -- render ----------------------------------------------------------------

  if (!sourceId) {
    return (
      <div className="meshcore-tab">
        <p>{t('meshcore.no_source', 'No source selected.')}</p>
      </div>
    );
  }

  // No connection-read permission means the entire surface is hidden, just
  // like a Meshtastic source the user can't read.
  if (!canReadConnection) {
    return (
      <div className="meshcore-tab">
        <h2>{t('meshcore.title')}</h2>
        <p>{t('meshcore.no_permission', 'You do not have permission to view this MeshCore source.')}</p>
      </div>
    );
  }

  // Map view: contacts with coordinates, rendered as a simple list. Slice 4
  // intentionally avoids pulling in Leaflet here — the dashboard map already
  // reads MeshCore contacts via MapContext, and the per-source map can be
  // added in a follow-up once contact→position plumbing is reused.
  const placedContacts = contacts.filter((c) => c.latitude != null && c.longitude != null);

  return (
    <div className="dashboard-page">
      <header className="dashboard-topbar">
        <button
          className="dashboard-topbar-hamburger"
          onClick={() => navigate('/')}
          title={t('source.sidebar.open_sources', 'Sources')}
        >
          ☰
        </button>
        <div className="dashboard-topbar-logo">
          <img
            src={`${appBasename}/logo.png`}
            alt="MeshMonitor"
            className="dashboard-topbar-logo-img"
          />
          <span className="dashboard-topbar-title">MeshMonitor — MeshCore</span>
        </div>
        <div className="dashboard-topbar-actions">
          {isAuthenticated ? (
            <UserMenu />
          ) : (
            <button className="dashboard-signin-btn" onClick={() => setShowLogin(true)}>
              {t('source.topbar.sign_in')}
            </button>
          )}
        </div>
      </header>

      <div className="meshcore-tab">
        <h2>{t('meshcore.title')}</h2>

        {error && (
          <div className="meshcore-error">
            {error}
            <button onClick={() => setError(null)}>{t('common.dismiss')}</button>
          </div>
        )}

        {/* Connection */}
        <section className="meshcore-section">
          <h3>{t('meshcore.connection')}</h3>
          {!status?.connected ? (
            <div className="meshcore-status">
              <div className="status-disconnected">
                <span className="status-dot disconnected"></span>
                {t('meshcore.disconnected', 'Disconnected')}
              </div>
              {canWriteConnection && (
                <div className="status-actions">
                  <button onClick={handleConnect} disabled={loading}>
                    {loading ? t('meshcore.connecting') : t('meshcore.connect')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="meshcore-status">
              <div className="status-connected">
                <span className="status-dot connected"></span>
                {t('meshcore.connected_to', { name: status.localNode?.name ?? t('meshcore.unknown') })}
              </div>
              <div className="status-details">
                <div>
                  {t('meshcore.type')}: {status.deviceTypeName}
                </div>
                {status.localNode?.radioFreq != null && (
                  <div>
                    {t('meshcore.radio')}: {status.localNode.radioFreq} MHz, BW
                    {status.localNode.radioBw}, SF{status.localNode.radioSf}
                  </div>
                )}
                {status.localNode?.publicKey && (
                  <div>
                    {t('meshcore.public_key')}: {status.localNode.publicKey.slice(0, 16)}…
                  </div>
                )}
              </div>
              {canWriteConnection && (
                <div className="status-actions">
                  <button onClick={handleSendAdvert}>{t('meshcore.send_advert')}</button>
                  <button onClick={handleDisconnect} className="disconnect">
                    {t('meshcore.disconnect')}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Map (contact positions) */}
        {canReadNodes && (
          <section className="meshcore-section">
            <h3>{t('meshcore.map_title', 'Map')}</h3>
            {placedContacts.length === 0 ? (
              <div className="meshcore-empty">
                {t('meshcore.no_positions', 'No contacts have reported positions yet.')}
              </div>
            ) : (
              <div className="meshcore-contact-list">
                {placedContacts.map((c) => (
                  <div key={c.publicKey} className="meshcore-contact-item">
                    <div className="contact-name">{c.advName || c.name || t('meshcore.unknown')}</div>
                    <div className="contact-details">
                      <span>
                        {t('meshcore.position', 'Position')}: {c.latitude!.toFixed(4)},{' '}
                        {c.longitude!.toFixed(4)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Nodes */}
        {canReadNodes && status?.connected && (
          <section className="meshcore-section">
            <h3>{t('meshcore.nodes_count', { count: nodes.length })}</h3>
            <div className="meshcore-node-list">
              {nodes.map((node) => (
                <div key={node.publicKey} className="meshcore-node-item">
                  <div className="node-name">
                    {node.name || t('meshcore.unknown')}
                    <span className="node-type">
                      {t(DEVICE_TYPE_KEYS[node.advType] || 'meshcore.device_type.unknown')}
                    </span>
                  </div>
                  <div className="node-details">
                    <span>
                      {t('meshcore.key')}: {node.publicKey.slice(0, 12)}…
                    </span>
                    {node.rssi != null && (
                      <span>
                        {t('meshcore.rssi')}: {node.rssi} dBm
                      </span>
                    )}
                    {node.snr != null && (
                      <span>
                        {t('meshcore.snr')}: {node.snr} dB
                      </span>
                    )}
                    {node.batteryMv != null && (
                      <span>
                        {t('meshcore.battery')}: {(node.batteryMv / 1000).toFixed(2)}V
                      </span>
                    )}
                    {node.lastHeard != null && (
                      <span>
                        {t('meshcore.last_heard')}: {formatTime(node.lastHeard)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {nodes.length === 0 && (
                <div className="meshcore-empty">{t('meshcore.no_nodes')}</div>
              )}
            </div>
          </section>
        )}

        {/* Contacts (channels are lumped here under messages perm per slice-3 design) */}
        {canReadNodes && status?.connected && (
          <section className="meshcore-section">
            <h3>
              {t('meshcore.contacts_count', { count: contacts.length })}
              {canWriteNodes && (
                <button onClick={handleRefreshContacts} disabled={loading} className="refresh-btn">
                  {t('meshcore.refresh')}
                </button>
              )}
            </h3>
            <div className="meshcore-contact-list">
              {contacts.map((c) => (
                <div key={c.publicKey} className="meshcore-contact-item">
                  <div className="contact-name">{c.advName || c.name || t('meshcore.unknown')}</div>
                  <div className="contact-details">
                    <span>
                      {t('meshcore.key')}: {c.publicKey.slice(0, 12)}…
                    </span>
                    {c.rssi != null && (
                      <span>
                        {t('meshcore.rssi')}: {c.rssi}
                      </span>
                    )}
                    {c.snr != null && (
                      <span>
                        {t('meshcore.snr')}: {c.snr}
                      </span>
                    )}
                  </div>
                  {canWriteMessages && (
                    <button
                      className="contact-select"
                      onClick={() => setSelectedContact(c.publicKey)}
                    >
                      {t('meshcore.select')}
                    </button>
                  )}
                </div>
              ))}
              {contacts.length === 0 && (
                <div className="meshcore-empty">{t('meshcore.no_contacts')}</div>
              )}
            </div>
          </section>
        )}

        {/* Messages */}
        {canReadMessages && status?.connected && (
          <section className="meshcore-section">
            <h3>{t('meshcore.messages')}</h3>
            <div className="meshcore-messages">
              {messages.map((msg) => (
                <div key={msg.id} className="meshcore-message">
                  <div className="message-header">
                    <span className="message-from">{msg.fromPublicKey.slice(0, 8)}…</span>
                    <span className="message-time">{formatTime(msg.timestamp)}</span>
                  </div>
                  <div className="message-text">{msg.text}</div>
                </div>
              ))}
              {messages.length === 0 && (
                <div className="meshcore-empty">{t('meshcore.no_messages')}</div>
              )}
            </div>
            {canWriteMessages && (
              <div className="meshcore-send-form">
                <select
                  value={selectedContact}
                  onChange={(e) => setSelectedContact(e.target.value)}
                >
                  <option value="">{t('meshcore.broadcast')}</option>
                  {contacts.map((c) => (
                    <option key={c.publicKey} value={c.publicKey}>
                      {c.advName || c.name || c.publicKey.slice(0, 12)}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder={t('meshcore.type_message')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSendMessage();
                  }}
                />
                <button onClick={handleSendMessage}>{t('meshcore.send')}</button>
              </div>
            )}
          </section>
        )}
      </div>

      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}

export default function MeshCoreSourcePage() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <MeshCoreSourceInner />
      </ToastProvider>
    </SettingsProvider>
  );
}
