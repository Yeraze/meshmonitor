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

import React, { useState, useEffect, useCallback } from 'react';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
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
}

// Device type labels
const DEVICE_TYPE_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Companion',
  2: 'Repeater',
  3: 'Room Server',
};

export const MeshCoreTab: React.FC = () => {
  // State
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [nodes, setNodes] = useState<MeshCoreNode[]>([]);
  const [contacts, setContacts] = useState<MeshCoreContact[]>([]);
  const [messages, setMessages] = useState<MeshCoreMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track mount for debugging
  useEffect(() => {
    console.log('MeshCoreTab mounted');
    return () => console.log('MeshCoreTab unmounted');
  }, []);

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
  const [adminStatus, setAdminStatus] = useState<any>(null);

  // CSRF-protected fetch
  const csrfFetch = useCsrfFetch();

  // Fetch status
  const fetchStatus = useCallback(async () => {
    try {
      const response = await csrfFetch('/api/meshcore/status');
      const data = await response.json();
      if (data.success) {
        setStatus(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
    }
  }, []);

  // Fetch nodes
  const fetchNodes = useCallback(async () => {
    try {
      const response = await csrfFetch('/api/meshcore/nodes');
      const data = await response.json();
      if (data.success) {
        setNodes(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch nodes:', err);
    }
  }, []);

  // Fetch contacts
  const fetchContacts = useCallback(async () => {
    try {
      const response = await csrfFetch('/api/meshcore/contacts');
      const data = await response.json();
      if (data.success) {
        setContacts(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch contacts:', err);
    }
  }, []);

  // Fetch messages
  const fetchMessages = useCallback(async () => {
    try {
      const response = await csrfFetch('/api/meshcore/messages?limit=50');
      const data = await response.json();
      if (data.success) {
        setMessages(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  }, []);

  // Initial load and polling
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => {
      fetchStatus();
      if (status?.connected) {
        fetchNodes();
        fetchContacts();
        fetchMessages();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchNodes, fetchContacts, fetchMessages, status?.connected]);

  // Connect handler
  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await csrfFetch('/api/meshcore/connect', {
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
      await csrfFetch('/api/meshcore/disconnect', { method: 'POST' });
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
      const response = await csrfFetch('/api/meshcore/advert', { method: 'POST' });
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
      const response = await csrfFetch('/api/meshcore/contacts/refresh', { method: 'POST' });
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
      const response = await csrfFetch('/api/meshcore/messages/send', {
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
      const response = await csrfFetch('/api/meshcore/admin/login', {
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
        const statusResponse = await fetch(`/api/meshcore/admin/status/${adminPublicKey}`);
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
      <h2>MeshCore Monitor</h2>

      {error && (
        <div className="meshcore-error">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Connection Section */}
      <section className="meshcore-section">
        <h3>Connection</h3>
        {!status?.connected ? (
          <div className="meshcore-connect-form">
            <div className="form-group">
              <label>Connection Type:</label>
              <select
                value={connectionType}
                onChange={(e) => setConnectionType(e.target.value as 'serial' | 'tcp')}
              >
                <option value="serial">Serial Port</option>
                <option value="tcp">TCP/IP</option>
              </select>
            </div>

            {connectionType === 'serial' ? (
              <div className="form-group">
                <label>Serial Port:</label>
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
                  <label>Host:</label>
                  <input
                    type="text"
                    value={tcpHost}
                    onChange={(e) => setTcpHost(e.target.value)}
                    placeholder="192.168.1.100"
                  />
                </div>
                <div className="form-group">
                  <label>Port:</label>
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
              {loading ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        ) : (
          <div className="meshcore-status">
            <div className="status-connected">
              <span className="status-dot connected"></span>
              Connected to {status.localNode?.name || 'Unknown'}
            </div>
            <div className="status-details">
              <div>Type: {status.deviceTypeName}</div>
              {status.localNode?.radioFreq && (
                <div>
                  Radio: {status.localNode.radioFreq} MHz, BW{status.localNode.radioBw}, SF{status.localNode.radioSf}
                </div>
              )}
              <div>Public Key: {status.localNode?.publicKey?.substring(0, 16)}...</div>
            </div>
            <div className="status-actions">
              <button onClick={handleSendAdvert}>Send Advert</button>
              <button onClick={handleDisconnect} className="disconnect">
                Disconnect
              </button>
            </div>
          </div>
        )}
      </section>

      {status?.connected && (
        <>
          {/* Nodes Section */}
          <section className="meshcore-section">
            <h3>Nodes ({nodes.length})</h3>
            <div className="meshcore-node-list">
              {nodes.map((node) => (
                <div key={node.publicKey} className="meshcore-node-item">
                  <div className="node-name">
                    {node.name || 'Unknown'}
                    <span className="node-type">{DEVICE_TYPE_LABELS[node.advType] || 'Unknown'}</span>
                  </div>
                  <div className="node-details">
                    <span>Key: {node.publicKey.substring(0, 12)}...</span>
                    {node.rssi && <span>RSSI: {node.rssi} dBm</span>}
                    {node.snr && <span>SNR: {node.snr} dB</span>}
                    {node.batteryMv && <span>Battery: {(node.batteryMv / 1000).toFixed(2)}V</span>}
                    {node.lastHeard && <span>Last: {formatTime(node.lastHeard)}</span>}
                  </div>
                </div>
              ))}
              {nodes.length === 0 && (
                <div className="meshcore-empty">No nodes discovered yet</div>
              )}
            </div>
          </section>

          {/* Contacts Section */}
          <section className="meshcore-section">
            <h3>
              Contacts ({contacts.length})
              <button onClick={handleRefreshContacts} disabled={loading} className="refresh-btn">
                Refresh
              </button>
            </h3>
            <div className="meshcore-contact-list">
              {contacts.map((contact) => (
                <div key={contact.publicKey} className="meshcore-contact-item">
                  <div className="contact-name">
                    {contact.advName || contact.name || 'Unknown'}
                  </div>
                  <div className="contact-details">
                    <span>Key: {contact.publicKey.substring(0, 12)}...</span>
                    {contact.rssi && <span>RSSI: {contact.rssi}</span>}
                    {contact.snr && <span>SNR: {contact.snr}</span>}
                  </div>
                  <button
                    className="contact-select"
                    onClick={() => {
                      setSelectedContact(contact.publicKey);
                      setAdminPublicKey(contact.publicKey);
                    }}
                  >
                    Select
                  </button>
                </div>
              ))}
              {contacts.length === 0 && (
                <div className="meshcore-empty">No contacts yet. Send an advert to discover nodes.</div>
              )}
            </div>
          </section>

          {/* Messages Section */}
          <section className="meshcore-section">
            <h3>Messages</h3>
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
                <div className="meshcore-empty">No messages yet</div>
              )}
            </div>
            <div className="meshcore-send-form">
              <select
                value={selectedContact}
                onChange={(e) => setSelectedContact(e.target.value)}
              >
                <option value="">Broadcast</option>
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
                placeholder="Type a message..."
                onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
              />
              <button onClick={handleSendMessage}>Send</button>
            </div>
          </section>

          {/* Admin Section */}
          <section className="meshcore-section">
            <h3>Remote Admin</h3>
            <div className="meshcore-admin-form">
              <div className="form-group">
                <label>Target Public Key:</label>
                <input
                  type="text"
                  value={adminPublicKey}
                  onChange={(e) => setAdminPublicKey(e.target.value)}
                  placeholder="Public key of target node"
                />
              </div>
              <div className="form-group">
                <label>Admin Password:</label>
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Admin password"
                />
              </div>
              <button onClick={handleAdminLogin}>Login & Get Status</button>
            </div>
            {adminStatus && (
              <div className="meshcore-admin-status">
                <h4>Remote Node Status</h4>
                <div className="admin-status-grid">
                  {adminStatus.batteryMv && (
                    <div>Battery: {(adminStatus.batteryMv / 1000).toFixed(2)}V</div>
                  )}
                  {adminStatus.uptimeSecs && (
                    <div>Uptime: {formatUptime(adminStatus.uptimeSecs)}</div>
                  )}
                  {adminStatus.txPower && (
                    <div>TX Power: {adminStatus.txPower} dBm</div>
                  )}
                  {adminStatus.radioFreq && (
                    <div>Frequency: {adminStatus.radioFreq} MHz</div>
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
