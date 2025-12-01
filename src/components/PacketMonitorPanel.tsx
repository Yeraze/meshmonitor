import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { PacketLog, PacketFilters } from '../types/packet';
import { getPackets, clearPackets, exportPackets } from '../services/packetApi';
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
const PACKET_FETCH_LIMIT = 100; // Fetch most recent 100 packets for display
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
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
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
  const [rateLimitError, setRateLimitError] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const rateLimitResetTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  // Virtual scrolling setup with infinite loading
  const rowVirtualizer = useVirtualizer({
    count: hasMore ? packets.length + 1 : packets.length, // Add 1 for loading indicator
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36, // Estimated row height in pixels
    overscan: 10, // Number of items to render outside of visible area
  });

  // Load more packets function
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || rateLimitError) return;

    setLoadingMore(true);
    try {
      const response = await getPackets(rawPackets.length, PACKET_FETCH_LIMIT, filters);

      if (response.packets.length === 0) {
        setHasMore(false);
      } else {
        setRawPackets(prev => [...prev, ...response.packets]);
        setTotal(response.total);
      }
    } catch (error) {
      console.error('Failed to load more packets:', error);

      // Check if this is a rate limit error
      if (error instanceof Error && error.message.includes('Too many requests')) {
        setRateLimitError(true);
        setHasMore(false); // Prevent further load attempts

        // Clear any existing reset timer
        if (rateLimitResetTimerRef.current) {
          clearTimeout(rateLimitResetTimerRef.current);
        }

        // Reset after 15 minutes (matches rate limit window)
        rateLimitResetTimerRef.current = setTimeout(() => {
          setRateLimitError(false);
          setHasMore(true);
        }, 15 * 60 * 1000);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, rateLimitError, rawPackets.length, filters]);

  // Load more packets when scrolling near the end
  useEffect(() => {
    const [lastItem] = [...rowVirtualizer.getVirtualItems()].reverse();

    if (!lastItem) return;

    // Prevent infinite loop when filters result in empty packet list
    // If we have raw packets but no filtered packets, don't keep trying to load more
    if (packets.length === 0 && rawPackets.length > 0) {
      return;
    }

    if (
      lastItem.index >= packets.length - 1 &&
      hasMore &&
      !loadingMore &&
      canView
    ) {
      loadMore();
    }
  }, [rowVirtualizer.getVirtualItems(), hasMore, loadingMore, packets.length, rawPackets.length, canView, loadMore]);

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

  // Fetch packets (initial load or refresh from polling)
  const fetchPackets = useCallback(async () => {
    if (!canView) return;

    try {
      // When polling updates, only fetch the first batch to check for new packets
      // This prevents resetting the scroll position
      const currentPacketCount = rawPackets.length;
      const isInitialLoad = currentPacketCount === 0;

      // Fetch most recent packets
      const response = await getPackets(0, PACKET_FETCH_LIMIT, filters);

      // Only update if this is initial load OR if there are new packets
      // This prevents unnecessary state updates that could reset scroll position
      if (isInitialLoad || response.packets[0]?.id !== rawPackets[0]?.id) {
        // Preserve existing packets beyond the first batch when polling
        if (!isInitialLoad && currentPacketCount > PACKET_FETCH_LIMIT) {
          // The new response contains positions 0-99 (most recent packets)
          // We want to keep our existing packets from position 100+ that aren't in the new batch

          // Remove duplicates: filter out any of our existing packets that appear in the new batch
          const newPacketIds = new Set(response.packets.map(p => p.id));
          const oldPacketsWithoutDuplicates = rawPackets.filter(p => !newPacketIds.has(p.id));

          // We already have positions 0-99 from the server (response.packets)
          // So we want to keep old packets starting from what would be position 100
          // Since we removed duplicates, we take everything from the old list
          setRawPackets([...response.packets, ...oldPacketsWithoutDuplicates]);
        } else {
          setRawPackets(response.packets);
          setHasMore(response.packets.length >= PACKET_FETCH_LIMIT);
        }
        setTotal(response.total);
      }

      setLoading(false);

      // Auto-scroll to top only on initial load if enabled
      if (autoScroll && tableRef.current && isInitialLoad) {
        tableRef.current.scrollTop = 0;
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
      if (rateLimitResetTimerRef.current) {
        clearTimeout(rateLimitResetTimerRef.current);
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

  // Export packets to JSONL (server-side)
  const handleExport = () => {
    try {
      // Use backend export endpoint with current filters
      // Note: hideOwnPackets is a client-side filter and not passed to backend
      exportPackets(filters);
    } catch (error) {
      console.error('Failed to export packets:', error);
      alert('Failed to export packets');
    }
  };

  // Pop-out to new window
  const handlePopout = () => {
    try {
      // Get base URL from <base> tag
      const baseElement = document.querySelector('base');
      const baseHref = baseElement?.getAttribute('href') || '/';
      const basename = baseHref === '/' ? '' : baseHref.replace(/\/$/, '');

      const popoutUrl = `${basename}/packet-monitor`;
      window.open(popoutUrl, '_blank', 'width=1200,height=800');
    } catch (error) {
      console.error('Failed to open pop-out window:', error);
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
        <div className="packet-count" title={`Showing ${packets.length} most recent packets. Export will include all ${total} packets.`}>
          {packets.length} shown / {total} total
        </div>
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
            disabled={total === 0}
          >
            📥
          </button>
          {authStatus?.user?.isAdmin && (
            <button className="control-btn" onClick={handleClear} title="Clear all packets">
              🗑️
            </button>
          )}
          <button
            className="control-btn"
            onClick={handlePopout}
            title="Pop out to new window"
          >
            ⧉
          </button>
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

      <div className="packet-table-container" ref={parentRef}>
        {rateLimitError && (
          <div className="rate-limit-warning" style={{
            padding: '1rem',
            margin: '1rem',
            backgroundColor: 'var(--warning-bg, #fff3cd)',
            color: 'var(--warning-text, #856404)',
            borderRadius: '4px',
            border: '1px solid var(--warning-border, #ffeaa7)'
          }}>
            ⚠️ Rate limit reached. Infinite scrolling paused for 15 minutes. Current packets will continue to update.
          </div>
        )}
        {loading ? (
          <div className="loading">Loading packets...</div>
        ) : packets.length === 0 ? (
          <div className="no-packets">No packets logged yet</div>
        ) : (
          <div style={{ width: '100%' }}>
            <table className="packet-table packet-table-fixed">
              <colgroup>
                <col style={{ width: '60px' }} />
                <col style={{ width: '110px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '120px' }} />
                <col style={{ width: '50px' }} />
                <col style={{ width: '60px' }} />
                <col style={{ width: '60px' }} />
                <col style={{ width: '60px' }} />
                <col style={{ minWidth: '200px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ width: '60px' }}>#</th>
                  <th style={{ width: '110px' }}>Time</th>
                  <th style={{ width: '140px' }}>From</th>
                  <th style={{ width: '140px' }}>To</th>
                  <th style={{ width: '120px' }}>Type</th>
                  <th style={{ width: '50px' }}>Ch</th>
                  <th style={{ width: '60px' }}>SNR</th>
                  <th style={{ width: '60px' }}>Hops</th>
                  <th style={{ width: '60px' }}>Size</th>
                  <th style={{ minWidth: '200px' }}>Content</th>
                </tr>
              </thead>
            </table>
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              <table className="packet-table packet-table-fixed">
                <colgroup>
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '50px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ minWidth: '200px' }} />
                </colgroup>
                <tbody>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const isLoaderRow = virtualRow.index > packets.length - 1;
                    const packet = packets[virtualRow.index];

                    if (isLoaderRow) {
                      return (
                        <tr
                          key="loader"
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${virtualRow.start}px)`,
                            display: 'table',
                            tableLayout: 'fixed',
                          }}
                        >
                          <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                            Loading more packets...
                          </td>
                        </tr>
                      );
                    }

                    const hops = calculateHops(packet);
                    return (
                      <tr
                        key={packet.id}
                        onClick={() => setSelectedPacket(packet)}
                        className={selectedPacket?.id === packet.id ? 'selected' : ''}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                          display: 'table',
                          tableLayout: 'fixed',
                        }}
                      >
                        <td className="packet-number" style={{ width: '60px', textAlign: 'right' }}>
                          {virtualRow.index + 1}
                        </td>
                        <td className="timestamp" style={{ width: '110px' }} title={formatDateTime(new Date(packet.timestamp * 1000), timeFormat, dateFormat)}>
                          {formatTimestamp(packet.timestamp)}
                        </td>
                        <td className="from-node" style={{ width: '140px' }} title={packet.from_node_longName || packet.from_node_id || ''}>
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
                        <td className="to-node" style={{ width: '140px' }} title={packet.to_node_longName || packet.to_node_id || ''}>
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
                          style={{ width: '120px', color: getPortnumColor(packet.portnum) }}
                          title={packet.portnum_name || ''}
                        >
                          {packet.portnum_name || packet.portnum}
                        </td>
                        <td className="channel" style={{ width: '50px' }}>{packet.channel ?? 'N/A'}</td>
                        <td className="snr" style={{ width: '60px' }}>{packet.snr !== null && packet.snr !== undefined ? `${packet.snr.toFixed(1)}` : 'N/A'}</td>
                        <td className="hops" style={{ width: '60px' }}>{hops !== null ? hops : 'N/A'}</td>
                        <td className="size" style={{ width: '60px' }}>{packet.payload_size ?? 'N/A'}</td>
                        <td className="content" style={{ minWidth: '200px' }}>
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
            </div>
          </div>
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
