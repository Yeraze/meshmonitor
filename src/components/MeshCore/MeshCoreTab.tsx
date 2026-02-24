/**
 * MeshCore Tab - Main tab component for MeshCore device monitoring
 *
 * Provides interface for:
 * - Connection management
 * - Node list display
 * - Contact management
 * - Messaging
 * - Admin commands
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useMapContext, MeshCoreMapNode } from '../../contexts/MapContext';
import './MeshCoreTab.css';

// Types
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
}

interface MeshCoreContact {
  publicKey: string;
  advName?: string;
  name?: string;
  lastSeen?: number;
  rssi?: number;
  snr?: number;
  advType?: number;
  latitude?: number;
  longitude?: number;
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
  config: {
    connectionType: string;
    serialPort?: string;
    tcpHost?: string;
    tcpPort?: number;
  } | null;
  localNode: MeshCoreNode | null;
  envConfig: {
    connectionType: string;
    serialPort?: string;
    tcpHost?: string;
    tcpPort?: number;
  } | null;
}

interface RemoteNodeStatus {
  batteryMv?: number;
  uptimeSecs?: number;
  txPower?: number;
  radioFreq?: number;
  radioBw?: number;
  radioSf?: number;
  radioCr?: number;
}

// Device type translation keys
const DEVICE_TYPE_KEYS: Record<number, string> = {
  0: 'meshcore.device_type.unknown',
  1: 'meshcore.device_type.companion',
  2: 'meshcore.device_type.repeater',
  3: 'meshcore.device_type.room_server',
};

// Small offset to prevent exact overlap on map when local node is at same location as contacts
const LOCAL_NODE_OFFSET = 0.0005; // ~55m

interface MeshCoreTabProps {
  baseUrl: string;
}

export const MeshCoreTab: React.FC<MeshCoreTabProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const { setMeshCoreNodes } = useMapContext();

  // State
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [nodes, setNodes] = useState<MeshCoreNode[]>([]);
  const [contacts, setContacts] = useState<MeshCoreContact[]>([]);
  const [messages, setMessages] = useState<MeshCoreMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connection form state
  const [connectionType, setConnectionType] = useState<'serial' | 'tcp'>('serial');
  const [serialPort, setSerialPort] = useState('COM3');
  const [tcpHost, setTcpHost] = useState('');
  const [tcpPort, setTcpPort] = useState('4403');

  // Message form state
  const [messageText, setMessageText] = useState('');
  const [selectedContact, setSelectedContact] = useState<string>('');

  // Admin form state
  const [adminPublicKey, setAdminPublicKey] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminStatus, setAdminStatus] = useState<RemoteNodeStatus | null>(null);

  // CSRF-protected fetch
  const csrfFetch = useCsrfFetch();

  // Track whether env defaults have been loaded into the form
  const defaultsLoaded = useRef(false);

  // Fetch status
  const fetchStatus = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/status`);
      const data = await response.json();
      if (data.success) {
        setStatus(data.data);

        // Pre-populate form from env config on first fetch (only when not connected)
        if (!defaultsLoaded.current && !data.data.connected && data.data.envConfig) {
          const env = data.data.envConfig;
          if (env.connectionType === 'serial' || env.connectionType === 'tcp') {
            setConnectionType(env.connectionType);
          }
          if (env.serialPort) setSerialPort(env.serialPort);
          if (env.tcpHost) setTcpHost(env.tcpHost);
          if (env.tcpPort) setTcpPort(String(env.tcpPort));
          defaultsLoaded.current = true;
        }
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
    }
  }, [baseUrl, csrfFetch]);

  // Fetch nodes
  const fetchNodes = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/nodes`);
      const data = await response.json();
      if (data.success) {
        setNodes(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch nodes:', err);
    }
  }, [baseUrl, csrfFetch]);

  // Fetch contacts and update map nodes
  const fetchContacts = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/contacts`);
      const data = await response.json();
      if (data.success) {
        setContacts(data.data);

        // Update map nodes - apply offset for local node to prevent overlap
        const mapNodes: MeshCoreMapNode[] = data.data
          .filter((c: MeshCoreContact) => c.latitude && c.longitude)
          .map((c: MeshCoreContact) => {
            const isLocalNode = c.advName?.includes('(local)');
            return {
              publicKey: c.publicKey,
              name: c.advName || c.name || 'Unknown',
              latitude: c.latitude! + (isLocalNode ? LOCAL_NODE_OFFSET : 0),
              longitude: c.longitude! + (isLocalNode ? LOCAL_NODE_OFFSET : 0),
              rssi: c.rssi,
              snr: c.snr,
              lastSeen: c.lastSeen,
              advType: c.advType,
            };
          });
        setMeshCoreNodes(mapNodes);
      }
    } catch (err) {
      console.error('Failed to fetch contacts:', err);
    }
  }, [baseUrl, csrfFetch, setMeshCoreNodes]);

  // Fetch messages
  const fetchMessages = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/messages?limit=50`);
      const data = await response.json();
      if (data.success) {
        setMessages(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  }, [baseUrl, csrfFetch]);

  // Track connected state in ref to avoid dependency in effect
  const connectedRef = useRef(false);
  useEffect(() => {
    connectedRef.current = status?.connected ?? false;
  }, [status?.connected]);

  // Initial load and polling
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => {
      fetchStatus();
      // Use ref to check connected state without causing re-renders
      if (connectedRef.current) {
        fetchNodes();
        fetchContacts();
        fetchMessages();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchNodes, fetchContacts, fetchMessages]);

  // Connect handler
  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionType,
          serialPort: connectionType === 'serial' ? serialPort : undefined,
          tcpHost: connectionType === 'tcp' ? tcpHost : undefined,
          tcpPort: connectionType === 'tcp' ? parseInt(tcpPort) : undefined,
        }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchStatus();
        await fetchNodes();
        await fetchContacts();
      } else {
        setError(data.error || 'Connection failed');
      }
    } catch (err) {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  };

  // Disconnect handler
  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await csrfFetch(`${baseUrl}/api/meshcore/disconnect`, { method: 'POST' });
      await fetchStatus();
      setNodes([]);
      setContacts([]);
      setMessages([]);
    } catch (err) {
      console.error('Disconnect error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Send advert handler
  const handleSendAdvert = async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/advert`, { method: 'POST' });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Failed to send advert');
      }
    } catch (err) {
      setError('Failed to send advert');
    }
  };

  // Refresh contacts handler
  const handleRefreshContacts = async () => {
    setLoading(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/contacts/refresh`, { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        setContacts(data.data);
      }
    } catch (err) {
      console.error('Refresh error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Send message handler
  const handleSendMessage = async () => {
    if (!messageText.trim()) return;

    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: messageText,
          toPublicKey: selectedContact || undefined,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setMessageText('');
        await fetchMessages();
      } else {
        setError(data.error || 'Failed to send message');
      }
    } catch (err) {
      setError('Failed to send message');
    }
  };

  // Admin login handler
  const handleAdminLogin = async () => {
    if (!adminPublicKey || !adminPassword) return;

    try {
      const response = await csrfFetch(`${baseUrl}/api/meshcore/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: adminPublicKey,
          password: adminPassword,
        }),
      });
      const data = await response.json();
      if (data.success) {
        // Fetch status after login
        const statusResponse = await csrfFetch(`${baseUrl}/api/meshcore/admin/status/${adminPublicKey}`);
        const statusData = await statusResponse.json();
        if (statusData.success) {
          setAdminStatus(statusData.data);
        }
      } else {
        setError(data.error || 'Admin login failed');
      }
    } catch (err) {
      setError('Admin login failed');
    }
  };

  // Format timestamp
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  // Format uptime
  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  return (
    <div className="meshcore-tab">
      <h2>{t('meshcore.title')}</h2>

      {error && (
        <div className="meshcore-error">
          {error}
          <button onClick={() => setError(null)}>{t('common.dismiss')}</button>
        </div>
      )}

      {/* Connection Section */}
      <section className="meshcore-section">
        <h3>{t('meshcore.connection')}</h3>
        {!status?.connected ? (
          <div className="meshcore-connect-form">
            <div className="form-group">
              <label>{t('meshcore.connection_type')}:</label>
              <select
                value={connectionType}
                onChange={(e) => setConnectionType(e.target.value as 'serial' | 'tcp')}
              >
                <option value="serial">{t('meshcore.serial_port')}</option>
                <option value="tcp">{t('meshcore.tcp_ip')}</option>
              </select>
            </div>

            {connectionType === 'serial' ? (
              <div className="form-group">
                <label>{t('meshcore.serial_port')}:</label>
                <input
                  type="text"
                  value={serialPort}
                  onChange={(e) => setSerialPort(e.target.value)}
                  placeholder="COM3 or /dev/ttyACM0"
                />
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label>{t('meshcore.host')}:</label>
                  <input
                    type="text"
                    value={tcpHost}
                    onChange={(e) => setTcpHost(e.target.value)}
                    placeholder="192.168.1.100"
                  />
                </div>
                <div className="form-group">
                  <label>{t('meshcore.port')}:</label>
                  <input
                    type="text"
                    value={tcpPort}
                    onChange={(e) => setTcpPort(e.target.value)}
                    placeholder="4403"
                  />
                </div>
              </>
            )}

            <button onClick={handleConnect} disabled={loading}>
              {loading ? t('meshcore.connecting') : t('meshcore.connect')}
            </button>
          </div>
        ) : (
          <div className="meshcore-status">
            <div className="status-connected">
              <span className="status-dot connected"></span>
              {t('meshcore.connected_to', { name: status.localNode?.name || t('meshcore.unknown') })}
            </div>
            <div className="status-details">
              <div>{t('meshcore.type')}: {status.deviceTypeName}</div>
              {status.localNode?.radioFreq && (
                <div>
                  {t('meshcore.radio')}: {status.localNode.radioFreq} MHz, BW{status.localNode.radioBw}, SF{status.localNode.radioSf}
                </div>
              )}
              <div>{t('meshcore.public_key')}: {status.localNode?.publicKey?.substring(0, 16)}...</div>
            </div>
            <div className="status-actions">
              <button onClick={handleSendAdvert}>{t('meshcore.send_advert')}</button>
              <button onClick={handleDisconnect} className="disconnect">
                {t('meshcore.disconnect')}
              </button>
            </div>
          </div>
        )}
      </section>

      {status?.connected && (
        <>
          {/* Nodes Section */}
          <section className="meshcore-section">
            <h3>{t('meshcore.nodes_count', { count: nodes.length })}</h3>
            <div className="meshcore-node-list">
              {nodes.map((node) => (
                <div key={node.publicKey} className="meshcore-node-item">
                  <div className="node-name">
                    {node.name || t('meshcore.unknown')}
                    <span className="node-type">{t(DEVICE_TYPE_KEYS[node.advType] || 'meshcore.device_type.unknown')}</span>
                  </div>
                  <div className="node-details">
                    <span>{t('meshcore.key')}: {node.publicKey.substring(0, 12)}...</span>
                    {node.rssi && <span>{t('meshcore.rssi')}: {node.rssi} dBm</span>}
                    {node.snr && <span>{t('meshcore.snr')}: {node.snr} dB</span>}
                    {node.batteryMv && <span>{t('meshcore.battery')}: {(node.batteryMv / 1000).toFixed(2)}V</span>}
                    {node.lastHeard && <span>{t('meshcore.last_heard')}: {formatTime(node.lastHeard)}</span>}
                  </div>
                </div>
              ))}
              {nodes.length === 0 && (
                <div className="meshcore-empty">{t('meshcore.no_nodes')}</div>
              )}
            </div>
          </section>

          {/* Contacts Section */}
          <section className="meshcore-section">
            <h3>
              {t('meshcore.contacts_count', { count: contacts.length })}
              <button onClick={handleRefreshContacts} disabled={loading} className="refresh-btn">
                {t('meshcore.refresh')}
              </button>
            </h3>
            <div className="meshcore-contact-list">
              {contacts.map((contact) => (
                <div key={contact.publicKey} className="meshcore-contact-item">
                  <div className="contact-name">
                    {contact.advName || contact.name || t('meshcore.unknown')}
                  </div>
                  <div className="contact-details">
                    <span>{t('meshcore.key')}: {contact.publicKey.substring(0, 12)}...</span>
                    {contact.rssi && <span>{t('meshcore.rssi')}: {contact.rssi}</span>}
                    {contact.snr && <span>{t('meshcore.snr')}: {contact.snr}</span>}
                  </div>
                  <button
                    className="contact-select"
                    onClick={() => {
                      setSelectedContact(contact.publicKey);
                      setAdminPublicKey(contact.publicKey);
                    }}
                  >
                    {t('meshcore.select')}
                  </button>
                </div>
              ))}
              {contacts.length === 0 && (
                <div className="meshcore-empty">{t('meshcore.no_contacts')}</div>
              )}
            </div>
          </section>

          {/* Messages Section */}
          <section className="meshcore-section">
            <h3>{t('meshcore.messages')}</h3>
            <div className="meshcore-messages">
              {messages.map((msg) => (
                <div key={msg.id} className="meshcore-message">
                  <div className="message-header">
                    <span className="message-from">{msg.fromPublicKey.substring(0, 8)}...</span>
                    <span className="message-time">{formatTime(msg.timestamp)}</span>
                  </div>
                  <div className="message-text">{msg.text}</div>
                </div>
              ))}
              {messages.length === 0 && (
                <div className="meshcore-empty">{t('meshcore.no_messages')}</div>
              )}
            </div>
            <div className="meshcore-send-form">
              <select
                value={selectedContact}
                onChange={(e) => setSelectedContact(e.target.value)}
              >
                <option value="">{t('meshcore.broadcast')}</option>
                {contacts.map((c) => (
                  <option key={c.publicKey} value={c.publicKey}>
                    {c.advName || c.name || c.publicKey.substring(0, 12)}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder={t('meshcore.type_message')}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              />
              <button onClick={handleSendMessage}>{t('meshcore.send')}</button>
            </div>
          </section>

          {/* Admin Section */}
          <section className="meshcore-section">
            <h3>{t('meshcore.remote_admin')}</h3>
            <div className="meshcore-admin-form">
              <div className="form-group">
                <label>{t('meshcore.target_public_key')}:</label>
                <input
                  type="text"
                  value={adminPublicKey}
                  onChange={(e) => setAdminPublicKey(e.target.value)}
                  placeholder={t('meshcore.target_key_placeholder')}
                />
              </div>
              <div className="form-group">
                <label>{t('meshcore.admin_password')}:</label>
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder={t('meshcore.admin_password_placeholder')}
                />
              </div>
              <button onClick={handleAdminLogin}>{t('meshcore.login_status')}</button>
            </div>
            {adminStatus && (
              <div className="meshcore-admin-status">
                <h4>{t('meshcore.remote_node_status')}</h4>
                <div className="admin-status-grid">
                  {adminStatus.batteryMv && (
                    <div>{t('meshcore.battery')}: {(adminStatus.batteryMv / 1000).toFixed(2)}V</div>
                  )}
                  {adminStatus.uptimeSecs && (
                    <div>{t('meshcore.uptime')}: {formatUptime(adminStatus.uptimeSecs)}</div>
                  )}
                  {adminStatus.txPower && (
                    <div>{t('meshcore.tx_power')}: {adminStatus.txPower} dBm</div>
                  )}
                  {adminStatus.radioFreq && (
                    <div>{t('meshcore.frequency')}: {adminStatus.radioFreq} MHz</div>
                  )}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default MeshCoreTab;
