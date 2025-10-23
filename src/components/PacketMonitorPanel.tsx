import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PacketLog, PacketFilters } from '../types/packet';
import { getPackets, clearPackets } from '../services/packetApi';
import { useAuth } from '../contexts/AuthContext';
import { useSettings } from '../contexts/SettingsContext';
import { formatDateTime } from '../utils/datetime';
import './PacketMonitorPanel.css';

interface PacketMonitorPanelProps {
  onClose: () => void;
  onNodeClick?: (nodeId: string) => void;
}

const PacketMonitorPanel: React.FC<PacketMonitorPanelProps> = ({ onClose, onNodeClick }) => {
  const { hasPermission, authStatus } = useAuth();
  const { timeFormat, dateFormat } = useSettings();
  const [packets, setPackets] = useState<PacketLog[]>([]);
  const [total, setTotal] = useState(0);
  const [maxCount, setMaxCount] = useState(1000);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedPacket, setSelectedPacket] = useState<PacketLog | null>(null);
  const [filters, setFilters] = useState<PacketFilters>({});
  const [showFilters, setShowFilters] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Check permissions
  const canView = hasPermission('channels', 'read') && hasPermission('messages', 'read');

  // Fetch packets
  const fetchPackets = useCallback(async () => {
    if (!canView) return;

    try {
      const response = await getPackets(0, 100, filters);
      setPackets(response.packets);
      setTotal(response.total);
      setMaxCount(response.maxCount);
      setLoading(false);

      // Auto-scroll to bottom if enabled
      if (autoScroll && tableRef.current) {
        tableRef.current.scrollTop = 0; // Scroll to top since newest packets are first
      }
    } catch (error) {
      console.error('Failed to fetch packets:', error);
      setLoading(false);
    }
  }, [canView, filters, autoScroll]);

  // Initial fetch and polling
  useEffect(() => {
    if (!canView) return;

    fetchPackets();

    // Poll for new packets every 2 seconds
    pollIntervalRef.current = setInterval(fetchPackets, 2000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [fetchPackets, canView]);

  // Handle clear packets
  const handleClear = async () => {
    if (!authStatus?.user?.isAdmin) {
      alert('Only administrators can clear packet logs');
      return;
    }

    if (!confirm('Are you sure you want to clear all packet logs?')) {
      return;
    }

    try {
      await clearPackets();
      fetchPackets();
    } catch (error) {
      console.error('Failed to clear packets:', error);
      alert('Failed to clear packet logs');
    }
  };

  // Handle node click
  const handleNodeClick = (nodeId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent row click
    if (onNodeClick && nodeId && nodeId !== '!ffffffff') {
      onNodeClick(nodeId);
    }
  };

  // Get port number color
  const getPortnumColor = (portnum: number): string => {
    switch (portnum) {
      case 1: return '#4a9eff'; // TEXT_MESSAGE - blue
      case 3: return '#4caf50'; // POSITION - green
      case 4: return '#00bcd4'; // NODEINFO - cyan
      case 67: return '#ff9800'; // TELEMETRY - orange
      case 70: return '#9c27b0'; // TRACEROUTE - purple
      case 71: return '#673ab7'; // NEIGHBORINFO - deep purple
      case 5: return '#f44336'; // ROUTING - red
      case 6: return '#e91e63'; // ADMIN - pink
      case 8: return '#4caf50'; // WAYPOINT - green
      case 11: return '#ff5722'; // ALERT - deep orange
      case 32: return '#2196f3'; // REPLY - light blue
      case 64: // SERIAL - brown
      case 65: // STORE_FORWARD - brown
      case 66: return '#795548'; // RANGE_TEST - brown
      case 72: // ATAK_PLUGIN - teal
      case 73: return '#009688'; // MAP_REPORT - teal
      case 256: // PRIVATE_APP - gray
      case 257: return '#757575'; // ATAK_FORWARDER - gray
      default: return '#9e9e9e'; // UNKNOWN - gray
    }
  };

  // Format timestamp
  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const time = date.toLocaleTimeString('en-US', {
      hour12: timeFormat === '12',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${time}.${ms}`;
  };

  // Calculate hops
  const calculateHops = (packet: PacketLog): number | null => {
    if (packet.hop_start !== undefined && packet.hop_limit !== undefined) {
      return packet.hop_start - packet.hop_limit;
    }
    return null;
  };

  if (!canView) {
    return (
      <div className="packet-monitor-panel">
        <div className="packet-monitor-header">
          <h3>Mesh Traffic Monitor</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="packet-monitor-no-permission">
          <p>You need both <strong>channels:read</strong> and <strong>messages:read</strong> permissions to view packet logs.</p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="packet-monitor-panel">
      <div className="packet-monitor-header">
        <h3>Mesh Traffic Monitor</h3>
        <div className="packet-count">{total} / {maxCount} packets</div>
        <div className="header-controls">
          <button
            className="control-btn"
            onClick={() => setAutoScroll(!autoScroll)}
            title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
          >
            {autoScroll ? '⏸️' : '▶️'}
          </button>
          <button
            className="control-btn"
            onClick={() => setShowFilters(!showFilters)}
            title="Toggle filters"
          >
            🔍
          </button>
          {authStatus?.user?.isAdmin && (
            <button className="control-btn" onClick={handleClear} title="Clear all packets">
              🗑️
            </button>
          )}
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
      </div>

      {showFilters && (
        <div className="packet-filters">
          <select
            value={filters.portnum ?? ''}
            onChange={(e) => setFilters({ ...filters, portnum: e.target.value ? parseInt(e.target.value) : undefined })}
          >
            <option value="">All Types</option>
            <option value="1">TEXT_MESSAGE</option>
            <option value="3">POSITION</option>
            <option value="4">NODEINFO</option>
            <option value="5">ROUTING</option>
            <option value="6">ADMIN</option>
            <option value="67">TELEMETRY</option>
            <option value="70">TRACEROUTE</option>
            <option value="71">NEIGHBORINFO</option>
          </select>

          <select
            value={filters.encrypted !== undefined ? (filters.encrypted ? 'true' : 'false') : ''}
            onChange={(e) => setFilters({
              ...filters,
              encrypted: e.target.value ? e.target.value === 'true' : undefined
            })}
          >
            <option value="">All Packets</option>
            <option value="true">Encrypted Only</option>
            <option value="false">Decoded Only</option>
          </select>

          <button onClick={() => setFilters({})} className="clear-filters-btn">
            Clear Filters
          </button>
        </div>
      )}

      <div className="packet-table-container" ref={tableRef}>
        {loading ? (
          <div className="loading">Loading packets...</div>
        ) : packets.length === 0 ? (
          <div className="no-packets">No packets logged yet</div>
        ) : (
          <table className="packet-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>From</th>
                <th>To</th>
                <th>Type</th>
                <th>Ch</th>
                <th>SNR</th>
                <th>Hops</th>
                <th>Size</th>
                <th>Content</th>
              </tr>
            </thead>
            <tbody>
              {packets.map((packet) => {
                const hops = calculateHops(packet);
                return (
                  <tr
                    key={packet.id}
                    onClick={() => setSelectedPacket(packet)}
                    className={selectedPacket?.id === packet.id ? 'selected' : ''}
                  >
                    <td className="timestamp" title={formatDateTime(new Date(packet.timestamp * 1000), timeFormat, dateFormat)}>
                      {formatTimestamp(packet.timestamp)}
                    </td>
                    <td className="from-node" title={packet.from_node_id || ''}>
                      {packet.from_node_id && onNodeClick ? (
                        <span
                          className="node-id-link"
                          onClick={(e) => handleNodeClick(packet.from_node_id!, e)}
                        >
                          {packet.from_node_id}
                        </span>
                      ) : (
                        packet.from_node_id || packet.from_node
                      )}
                    </td>
                    <td className="to-node" title={packet.to_node_id || ''}>
                      {packet.to_node_id === '!ffffffff' ? (
                        'Broadcast'
                      ) : packet.to_node_id && onNodeClick ? (
                        <span
                          className="node-id-link"
                          onClick={(e) => handleNodeClick(packet.to_node_id!, e)}
                        >
                          {packet.to_node_id}
                        </span>
                      ) : (
                        packet.to_node_id || packet.to_node || 'N/A'
                      )}
                    </td>
                    <td
                      className="portnum"
                      style={{ color: getPortnumColor(packet.portnum) }}
                      title={packet.portnum_name || ''}
                    >
                      {packet.portnum_name || packet.portnum}
                    </td>
                    <td className="channel">{packet.channel ?? 'N/A'}</td>
                    <td className="snr">{packet.snr !== null && packet.snr !== undefined ? `${packet.snr.toFixed(1)}` : 'N/A'}</td>
                    <td className="hops">{hops !== null ? hops : 'N/A'}</td>
                    <td className="size">{packet.payload_size ?? 'N/A'}</td>
                    <td className="content">
                      {packet.encrypted ? (
                        <span className="encrypted-indicator">🔒 &lt;ENCRYPTED&gt;</span>
                      ) : (
                        <span className="content-preview">{packet.payload_preview || '[No preview]'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

    </div>
    {/* Render modal as a portal to document.body to avoid overflow:hidden issues */}
    {selectedPacket && createPortal(
      <div className="packet-detail-modal" onClick={() => setSelectedPacket(null)}>
        <div className="packet-detail-content" onClick={(e) => e.stopPropagation()}>
          <div className="packet-detail-header">
            <h4>Packet Details</h4>
            <button className="close-btn" onClick={() => setSelectedPacket(null)}>×</button>
          </div>
          <div className="packet-detail-body">
            <div className="detail-row">
              <span className="detail-label">ID:</span>
              <span className="detail-value">{selectedPacket.packet_id ?? 'N/A'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Timestamp:</span>
              <span className="detail-value">{formatDateTime(new Date(selectedPacket.timestamp * 1000), timeFormat, dateFormat)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">From:</span>
              <span className="detail-value">{selectedPacket.from_node_id} ({selectedPacket.from_node})</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">To:</span>
              <span className="detail-value">
                {selectedPacket.to_node_id === '!ffffffff' ? 'Broadcast' : `${selectedPacket.to_node_id || 'N/A'} (${selectedPacket.to_node ?? 'N/A'})`}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Port:</span>
              <span className="detail-value">{selectedPacket.portnum_name} ({selectedPacket.portnum})</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Channel:</span>
              <span className="detail-value">{selectedPacket.channel ?? 'N/A'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Encrypted:</span>
              <span className="detail-value">{selectedPacket.encrypted ? 'Yes 🔒' : 'No'}</span>
            </div>
            {selectedPacket.snr !== null && selectedPacket.snr !== undefined && (
              <div className="detail-row">
                <span className="detail-label">SNR:</span>
                <span className="detail-value">{selectedPacket.snr.toFixed(1)} dB</span>
              </div>
            )}
            {selectedPacket.rssi !== null && selectedPacket.rssi !== undefined && (
              <div className="detail-row">
                <span className="detail-label">RSSI:</span>
                <span className="detail-value">{selectedPacket.rssi} dBm</span>
              </div>
            )}
            {calculateHops(selectedPacket) !== null && (
              <div className="detail-row">
                <span className="detail-label">Hops:</span>
                <span className="detail-value">{calculateHops(selectedPacket)}</span>
              </div>
            )}
            {selectedPacket.payload_size !== null && selectedPacket.payload_size !== undefined && (
              <div className="detail-row">
                <span className="detail-label">Payload Size:</span>
                <span className="detail-value">{selectedPacket.payload_size} bytes</span>
              </div>
            )}
            <div className="detail-row">
              <span className="detail-label">Content:</span>
              <span className="detail-value">
                {selectedPacket.encrypted ? (
                  <span className="encrypted-indicator">🔒 &lt;ENCRYPTED&gt;</span>
                ) : (
                  <pre className="payload-content">{selectedPacket.payload_preview || '[No preview]'}</pre>
                )}
              </span>
            </div>
            {selectedPacket.metadata && (
              <div className="detail-row">
                <span className="detail-label">Metadata:</span>
                <pre className="metadata-json">{JSON.stringify(JSON.parse(selectedPacket.metadata), null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
};

export default PacketMonitorPanel;
