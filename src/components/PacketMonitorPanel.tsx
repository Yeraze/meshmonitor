import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PacketLog, PacketFilters } from '../types/packet';
import { getPackets, clearPackets } from '../services/packetApi';
import { useAuth } from '../contexts/AuthContext';
import { useSettings } from '../contexts/SettingsContext';
import { useData } from '../contexts/DataContext';
import { formatDateTime } from '../utils/datetime';
import { ResourceType } from '../types/permission';
import './PacketMonitorPanel.css';

interface PacketMonitorPanelProps {
  onClose: () => void;
  onNodeClick?: (nodeId: string) => void;
}

// Constants
const PACKET_FETCH_LIMIT = 10000;
const POLL_INTERVAL_MS = 5000;

// Safe JSON parse helper
const safeJsonParse = <T,>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn('Failed to parse JSON from localStorage:', error);
    return fallback;
  }
};

const PacketMonitorPanel: React.FC<PacketMonitorPanelProps> = ({ onClose, onNodeClick }) => {
  const { hasPermission, authStatus } = useAuth();
  const { timeFormat, dateFormat } = useSettings();
  const { deviceInfo } = useData();
  const [rawPackets, setRawPackets] = useState<PacketLog[]>([]);
  const [total, setTotal] = useState(0);
  const [maxCount, setMaxCount] = useState(1000);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(() =>
    safeJsonParse(localStorage.getItem('packetMonitor.autoScroll'), true)
  );
  const [selectedPacket, setSelectedPacket] = useState<PacketLog | null>(null);
  const [filters, setFilters] = useState<PacketFilters>(() =>
    safeJsonParse<PacketFilters>(localStorage.getItem('packetMonitor.filters'), {})
  );
  const [showFilters, setShowFilters] = useState(() =>
    safeJsonParse(localStorage.getItem('packetMonitor.showFilters'), false)
  );
  const [hideOwnPackets, setHideOwnPackets] = useState(() =>
    safeJsonParse(localStorage.getItem('packetMonitor.hideOwnPackets'), true)
  );
  const tableRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Check permissions - user needs to have at least one channel permission and messages permission
  const hasAnyChannelPermission = () => {
    for (let i = 0; i < 8; i++) {
      if (hasPermission(`channel_${i}` as ResourceType, 'read')) {
        return true;
      }
    }
    return false;
  };
  const canView = hasAnyChannelPermission() && hasPermission('messages', 'read');

  // Get own node number for filtering
  // Convert nodeId (hex string like "!43588558") to number
  const ownNodeNum = React.useMemo(() => {
    const nodeId = deviceInfo?.localNodeInfo?.nodeId;
    if (!nodeId || !nodeId.startsWith('!')) return undefined;
    return parseInt(nodeId.substring(1), 16);
  }, [deviceInfo?.localNodeInfo?.nodeId]);

  // Apply "Hide Own Packets" filter reactively
  const packets = React.useMemo(() => {
    if (hideOwnPackets && ownNodeNum) {
      return rawPackets.filter(packet => packet.from_node !== ownNodeNum);
    }
    return rawPackets;
  }, [rawPackets, hideOwnPackets, ownNodeNum]);

  // Persist filter settings to localStorage
  useEffect(() => {
    localStorage.setItem('packetMonitor.filters', JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    localStorage.setItem('packetMonitor.hideOwnPackets', JSON.stringify(hideOwnPackets));
  }, [hideOwnPackets]);

  useEffect(() => {
    localStorage.setItem('packetMonitor.showFilters', JSON.stringify(showFilters));
  }, [showFilters]);

  useEffect(() => {
    localStorage.setItem('packetMonitor.autoScroll', JSON.stringify(autoScroll));
  }, [autoScroll]);

  // Helper function to truncate long names
  const truncateLongName = (longName: string | undefined, maxLength: number = 20): string | undefined => {
    if (!longName) return undefined;
    return longName.length > maxLength ? `${longName.substring(0, maxLength)}...` : longName;
  };

  // Fetch packets
  const fetchPackets = useCallback(async () => {
    if (!canView) return;

    try {
      // Fetch all packets by using the maximum limit from backend
      const response = await getPackets(0, PACKET_FETCH_LIMIT, filters);

      setRawPackets(response.packets);
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

    // Poll for new packets
    pollIntervalRef.current = setInterval(fetchPackets, POLL_INTERVAL_MS);

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

  // Export packets to JSONL
  const handleExport = () => {
    if (packets.length === 0) {
      alert('No packets to export');
      return;
    }

    try {
      // Convert each packet to a JSON line (JSONL format)
      const jsonlContent = packets.map(packet => {
        // Safely parse metadata if it's a string
        const packetWithParsedMetadata = {
          ...packet,
          metadata: packet.metadata ? safeJsonParse(packet.metadata, {}) : undefined
        };
        return JSON.stringify(packetWithParsedMetadata);
      }).join('\n');

      // Create blob and download
      const blob = new Blob([jsonlContent], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const hasActiveFilters = Boolean(filters.portnum) ||
                              filters.encrypted !== undefined ||
                              hideOwnPackets !== true;
      const filterInfo = hasActiveFilters ? '-filtered' : '';
      link.download = `packet-monitor${filterInfo}-${timestamp}.jsonl`;

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export packets:', error);
      alert('Failed to export packets');
    }
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
          <button
            className="control-btn"
            onClick={handleExport}
            title="Export packets to JSONL"
            disabled={packets.length === 0}
          >
            📥
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

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={hideOwnPackets}
              onChange={(e) => setHideOwnPackets(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            <span>Hide Own Packets</span>
          </label>

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
                    <td className="from-node" title={packet.from_node_longName || packet.from_node_id || ''}>
                      {packet.from_node_id && onNodeClick ? (
                        <span
                          className="node-id-link"
                          onClick={(e) => handleNodeClick(packet.from_node_id!, e)}
                        >
                          {truncateLongName(packet.from_node_longName) || packet.from_node_id}
                        </span>
                      ) : (
                        truncateLongName(packet.from_node_longName) || packet.from_node_id || packet.from_node
                      )}
                    </td>
                    <td className="to-node" title={packet.to_node_longName || packet.to_node_id || ''}>
                      {packet.to_node_id === '!ffffffff' ? (
                        'Broadcast'
                      ) : packet.to_node_id && onNodeClick ? (
                        <span
                          className="node-id-link"
                          onClick={(e) => handleNodeClick(packet.to_node_id!, e)}
                        >
                          {truncateLongName(packet.to_node_longName) || packet.to_node_id}
                        </span>
                      ) : (
                        truncateLongName(packet.to_node_longName) || packet.to_node_id || packet.to_node || 'N/A'
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
            <h4>Packet Details (Full JSON)</h4>
            <button className="close-btn" onClick={() => setSelectedPacket(null)}>×</button>
          </div>
          <div className="packet-detail-body">
            <pre className="packet-json">{JSON.stringify(selectedPacket, null, 2)}</pre>
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
};

export default PacketMonitorPanel;
