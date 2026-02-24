import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { PacketLog, PacketFilters } from '../types/packet';
import { clearPackets, exportPackets } from '../services/packetApi';
import apiService from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useSettings } from '../contexts/SettingsContext';
import { useDeviceConfig, useNodes } from '../hooks/useServerData';
import { usePackets } from '../hooks/usePackets';
import { formatDateTime } from '../utils/datetime';
import { ResourceType } from '../types/permission';
import RelayNodeModal from './RelayNodeModal';
import './PacketMonitorPanel.css';

interface PacketMonitorPanelProps {
  onClose: () => void;
  onNodeClick?: (nodeId: string) => void;
}

// Constants
const LOAD_MORE_THRESHOLD = 10;

// Transport mechanism display names (matches protobufs/meshtastic/mesh.proto TransportMechanism enum)
const TRANSPORT_MECHANISM_NAMES: Record<number, { short: string; full: string }> = {
  0: { short: 'INT', full: 'Internal - Node generated packet' },
  1: { short: 'LoRa', full: 'LoRa - Primary radio' },
  2: { short: 'LoR1', full: 'LoRa Alt 1 - Secondary radio' },
  3: { short: 'LoR2', full: 'LoRa Alt 2 - Tertiary radio' },
  4: { short: 'LoR3', full: 'LoRa Alt 3 - Quaternary radio' },
  5: { short: 'MQTT', full: 'MQTT - Message queue' },
  6: { short: 'UDP', full: 'Multicast UDP' },
  7: { short: 'API', full: 'API - Direct connection' },
};

/**
 * Get display name for transport mechanism
 */
const getTransportMechanismName = (mechanism: number | undefined): { short: string; full: string } => {
  if (mechanism === undefined || mechanism === null) {
    return { short: '?', full: 'Unknown transport' };
  }
  return TRANSPORT_MECHANISM_NAMES[mechanism] || { short: '?', full: `Unknown (${mechanism})` };
};

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
  const { t } = useTranslation();
  const { hasPermission, authStatus } = useAuth();
  const { timeFormat, dateFormat } = useSettings();
  const { config: deviceInfo } = useDeviceConfig();
  const { nodes } = useNodes();

  // UI state (not data-related)
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

  // Relay node modal state
  const [relayModalOpen, setRelayModalOpen] = useState(false);
  const [selectedRelayNode, setSelectedRelayNode] = useState<number | null>(null);
  const [selectedRxTime, setSelectedRxTime] = useState<Date | undefined>(undefined);
  const [selectedMessageRssi, setSelectedMessageRssi] = useState<number | undefined>(undefined);
  const [directNeighborStats, setDirectNeighborStats] = useState<Record<number, { avgRssi: number; packetCount: number; lastHeard: number }>>({});

  const parentRef = useRef<HTMLDivElement>(null);

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

  // Use the packets hook for all data fetching
  const {
    packets,
    total,
    loading,
    hasMore,
    rateLimitError,
    loadMore,
    refresh: fetchPackets,
    markUserScrolled,
    shouldLoadMore,
  } = usePackets({
    canView,
    filters,
    hideOwnPackets,
    ownNodeNum,
  });

  // Virtual scrolling setup with infinite loading
  const rowVirtualizer = useVirtualizer({
    count: hasMore ? packets.length + 1 : packets.length, // Add 1 for loading indicator
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36, // Estimated row height in pixels
    overscan: 10, // Number of items to render outside of visible area
  });

  // Track scroll to enable infinite loading only after user interaction
  useEffect(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    const handleScroll = () => {
      // Mark that user has scrolled - this enables infinite scroll loading
      if (scrollElement.scrollTop > 50) {
        markUserScrolled();
      }
    };

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [markUserScrolled]);

  // Load more packets when scrolling near the end
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1]?.index ?? -1 : -1;

  useEffect(() => {
    if (shouldLoadMore(lastVisibleIndex, LOAD_MORE_THRESHOLD)) {
      loadMore();
    }
  }, [lastVisibleIndex, shouldLoadMore, loadMore]);

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

  // Fetch direct neighbor stats on mount for relay estimation
  useEffect(() => {
    if (!canView) return;

    const fetchNeighborStats = async () => {
      try {
        const stats = await apiService.getDirectNeighborStats(24);
        setDirectNeighborStats(stats);
      } catch (error) {
        console.error('Failed to fetch direct neighbor stats:', error);
      }
    };

    fetchNeighborStats();
  }, [canView]);

  // Helper function to truncate long names
  const truncateLongName = (longName: string | undefined, maxLength: number = 20): string | undefined => {
    if (!longName) return undefined;
    return longName.length > maxLength ? `${longName.substring(0, maxLength)}...` : longName;
  };

  // Handle clear packets
  const handleClear = async () => {
    if (!authStatus?.user?.isAdmin) {
      alert(t('packet_monitor.admin_only'));
      return;
    }

    if (!confirm(t('packet_monitor.confirm_clear'))) {
      return;
    }

    try {
      await clearPackets();
      fetchPackets();
    } catch (error) {
      console.error('Failed to clear packets:', error);
      alert(t('packet_monitor.clear_failed'));
    }
  };

  // Handle node click
  const handleNodeClick = (nodeId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent row click
    if (onNodeClick && nodeId && nodeId !== '!ffffffff') {
      onNodeClick(nodeId);
    }
  };

  // Handle relay node click - opens modal to show potential relay nodes
  const handleRelayClick = async (packet: PacketLog, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent row click
    // Set relay node to 0 if undefined/null (triggers "unknown relay" mode in modal)
    setSelectedRelayNode(packet.relay_node ?? 0);
    setSelectedRxTime(new Date(packet.timestamp * 1000));
    setSelectedMessageRssi(packet.rssi ?? undefined);

    // Fetch direct neighbor stats (refresh to ensure up-to-date data)
    try {
      const stats = await apiService.getDirectNeighborStats(24);
      setDirectNeighborStats(stats);
    } catch (error) {
      console.error('Failed to fetch direct neighbor stats:', error);
    }

    setRelayModalOpen(true);
  };

  // Map nodes to the format expected by RelayNodeModal
  const mappedNodes = nodes.map(node => {
    const stats = directNeighborStats[node.nodeNum];
    return {
      nodeNum: node.nodeNum,
      nodeId: node.user?.id || `!${node.nodeNum.toString(16).padStart(8, '0')}`,
      longName: node.user?.longName || `Node ${node.nodeNum}`,
      shortName: node.user?.shortName || node.nodeNum.toString(16).padStart(8, '0').slice(-4),
      hopsAway: node.hopsAway,
      role: typeof node.user?.role === 'string' ? parseInt(node.user.role, 10) : node.user?.role,
      avgDirectRssi: stats?.avgRssi,
      heardDirectly: stats !== undefined,
    };
  });

  // Get port number color
  const getPortnumColor = (portnum: number): string => {
    switch (portnum) {
      case 1:
        return '#4a9eff'; // TEXT_MESSAGE - blue
      case 3:
        return '#4caf50'; // POSITION - green
      case 4:
        return '#00bcd4'; // NODEINFO - cyan
      case 67:
        return '#ff9800'; // TELEMETRY - orange
      case 70:
        return '#9c27b0'; // TRACEROUTE - purple
      case 71:
        return '#673ab7'; // NEIGHBORINFO - deep purple
      case 5:
        return '#f44336'; // ROUTING - red
      case 6:
        return '#e91e63'; // ADMIN - pink
      case 8:
        return '#4caf50'; // WAYPOINT - green
      case 11:
        return '#ff5722'; // ALERT - deep orange
      case 32:
        return '#2196f3'; // REPLY - light blue
      case 64: // SERIAL - brown
      case 65: // STORE_FORWARD - brown
      case 66:
        return '#795548'; // RANGE_TEST - brown
      case 72: // ATAK_PLUGIN - teal
      case 73:
        return '#009688'; // MAP_REPORT - teal
      case 256: // PRIVATE_APP - gray
      case 257:
        return '#757575'; // ATAK_FORWARDER - gray
      default:
        return '#9e9e9e'; // UNKNOWN - gray
    }
  };

  // Format timestamp
  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const time = date.toLocaleTimeString('en-US', {
      hour12: timeFormat === '12',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
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

  // Get the most likely relay node name for a packet
  // Uses RSSI proximity to estimate the relay when there are multiple candidates or unknown relay byte
  const getMostLikelyRelayName = (relayNode: number | undefined | null, packetRssi: number | undefined | null): string | null => {
    // CLIENT_MUTE role doesn't relay
    const CLIENT_MUTE = 4;
    const relayCapableNodes = nodes.filter(node => {
      const role = typeof node.user?.role === 'string' ? parseInt(node.user.role, 10) : node.user?.role;
      return role !== CLIENT_MUTE;
    });

    // Helper to find the node with closest RSSI to the packet
    const findClosestByRssi = (candidates: typeof nodes): typeof nodes[0] | null => {
      if (candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0];
      if (packetRssi === undefined || packetRssi === null) return candidates[0];

      let closest = candidates[0];
      let closestDiff = Infinity;

      for (const node of candidates) {
        const stats = directNeighborStats[node.nodeNum];
        if (stats?.avgRssi !== undefined) {
          const diff = Math.abs(stats.avgRssi - packetRssi);
          if (diff < closestDiff) {
            closestDiff = diff;
            closest = node;
          }
        }
      }
      return closest;
    };

    // If relay_node is 0, undefined, or null - estimate from all direct neighbors
    if (relayNode === undefined || relayNode === null || relayNode === 0) {
      // Get all relay-capable nodes we've heard directly
      const directNeighbors = relayCapableNodes.filter(node => directNeighborStats[node.nodeNum] !== undefined);
      const closest = findClosestByRssi(directNeighbors);
      if (closest) {
        return closest.user?.shortName || `!${closest.nodeNum.toString(16).padStart(8, '0')}`;
      }
      return null;
    }

    // Try exact match first
    const exactMatch = relayCapableNodes.find(node => node.nodeNum === relayNode);
    if (exactMatch) {
      return exactMatch.user?.shortName || `!${relayNode.toString(16).padStart(8, '0')}`;
    }

    // Fall back to matching just the lowest byte
    // A relay MUST be a direct neighbor, so filter to only plausible candidates
    const byteMatches = relayCapableNodes.filter(node => (node.nodeNum & 0xFF) === relayNode);

    // Filter to only direct neighbors or nodes within 1 hop - a relay must be directly connected
    const plausibleRelays = byteMatches.filter(node =>
      directNeighborStats[node.nodeNum] !== undefined || (node.hopsAway !== undefined && node.hopsAway <= 1)
    );

    if (plausibleRelays.length === 1) {
      return plausibleRelays[0].user?.shortName || `!${plausibleRelays[0].nodeNum.toString(16).padStart(8, '0')}`;
    }
    if (plausibleRelays.length > 1) {
      // Multiple plausible matches - pick the one with closest RSSI
      const closest = findClosestByRssi(plausibleRelays);
      if (closest) {
        return closest.user?.shortName || `!${closest.nodeNum.toString(16).padStart(8, '0')}`;
      }
    }

    // No plausible matches found - return hex byte as fallback
    return `0x${relayNode.toString(16).padStart(2, '0').toUpperCase()}`;
  };

  // Export packets to JSONL (server-side)
  const handleExport = () => {
    try {
      // Use backend export endpoint with current filters
      // Note: hideOwnPackets is a client-side filter and not passed to backend
      exportPackets(filters);
    } catch (error) {
      console.error('Failed to export packets:', error);
      alert(t('packet_monitor.export_failed'));
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
          <h3>{t('packet_monitor.title')}</h3>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="packet-monitor-no-permission">
          <p>
            {t('packet_monitor.no_permission')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="packet-monitor-panel">
        <div className="packet-monitor-header">
          <h3>{t('packet_monitor.title')}</h3>
          <div
            className="packet-count"
            title={t('packet_monitor.count_tooltip', { shown: packets.length, total })}
          >
            {t('packet_monitor.count', { shown: packets.length, total })}
          </div>
          <div className="header-controls">
            <button
              className="control-btn"
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? t('packet_monitor.pause_autoscroll') : t('packet_monitor.resume_autoscroll')}
            >
              {autoScroll ? '⏸️' : '▶️'}
            </button>
            <button className="control-btn" onClick={() => setShowFilters(!showFilters)} title={t('packet_monitor.toggle_filters')}>
              🔍
            </button>
            <button
              className="control-btn"
              onClick={handleExport}
              title={t('packet_monitor.export_title')}
              disabled={total === 0}
            >
              📥
            </button>
            {authStatus?.user?.isAdmin && (
              <button className="control-btn" onClick={handleClear} title={t('packet_monitor.clear_all')}>
                🗑️
              </button>
            )}
            <button className="control-btn" onClick={handlePopout} title={t('packet_monitor.popout')}>
              ⧉
            </button>
            <button className="close-btn" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {showFilters && (
          <div className="packet-filters">
            <select
              value={filters.portnum ?? ''}
              onChange={e => setFilters({ ...filters, portnum: e.target.value ? parseInt(e.target.value) : undefined })}
            >
              <option value="">{t('packet_monitor.filter.all_types')}</option>
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
              onChange={e =>
                setFilters({
                  ...filters,
                  encrypted: e.target.value ? e.target.value === 'true' : undefined,
                })
              }
            >
              <option value="">{t('packet_monitor.filter.all_packets')}</option>
              <option value="true">{t('packet_monitor.filter.encrypted_only')}</option>
              <option value="false">{t('packet_monitor.filter.decoded_only')}</option>
            </select>

            <select
              value={filters.from_node ?? ''}
              onChange={e => setFilters({ ...filters, from_node: e.target.value ? parseInt(e.target.value) : undefined })}
              title={t('packet_monitor.filter.from_node_tooltip')}
            >
              <option value="">{t('packet_monitor.filter.all_nodes')}</option>
              {nodes
                .filter(node => node.user?.id)
                .sort((a, b) => (a.user?.longName || '').localeCompare(b.user?.longName || ''))
                .map(node => (
                  <option key={node.nodeNum} value={node.nodeNum}>
                    {node.user?.longName || node.user?.shortName || `!${node.nodeNum.toString(16).padStart(8, '0')}`}
                  </option>
                ))}
            </select>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={hideOwnPackets}
                onChange={e => setHideOwnPackets(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('packet_monitor.filter.hide_own')}</span>
            </label>

            <button onClick={() => setFilters({})} className="clear-filters-btn">
              {t('packet_monitor.filter.clear')}
            </button>
          </div>
        )}

        <div className="packet-table-container" ref={parentRef}>
          {rateLimitError && (
            <div
              className="rate-limit-warning"
              style={{
                padding: '1rem',
                margin: '1rem',
                backgroundColor: 'var(--warning-bg, #fff3cd)',
                color: 'var(--warning-text, #856404)',
                borderRadius: '4px',
                border: '1px solid var(--warning-border, #ffeaa7)',
              }}
            >
              ⚠️ {t('packet_monitor.rate_limit_warning')}
            </div>
          )}
          {loading ? (
            <div className="loading">{t('packet_monitor.loading')}</div>
          ) : packets.length === 0 ? (
            <div className="no-packets">{t('packet_monitor.no_packets')}</div>
          ) : (
            <div style={{ width: '100%' }}>
              <table className="packet-table packet-table-fixed">
                <colgroup>
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '35px' }} />
                  <col style={{ width: '45px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ minWidth: '200px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ width: '60px' }}>#</th>
                    <th style={{ width: '35px' }}>{t('packet_monitor.column.dir')}</th>
                    <th style={{ width: '45px' }}>{t('packet_monitor.column.via')}</th>
                    <th style={{ width: '110px' }}>{t('packet_monitor.column.time')}</th>
                    <th style={{ width: '140px' }}>{t('packet_monitor.column.from')}</th>
                    <th style={{ width: '140px' }}>{t('packet_monitor.column.to')}</th>
                    <th style={{ width: '120px' }}>{t('packet_monitor.column.type')}</th>
                    <th style={{ width: '110px' }}>{t('packet_monitor.column.slot')}</th>
                    <th style={{ width: '60px' }}>{t('packet_monitor.column.snr')}</th>
                    <th style={{ width: '60px' }}>{t('packet_monitor.column.rssi')}</th>
                    <th style={{ width: '60px' }}>{t('packet_monitor.column.hops')}</th>
                    <th style={{ width: '80px' }}>{t('packet_monitor.column.last_hop')}</th>
                    <th style={{ width: '60px' }}>{t('packet_monitor.column.size')}</th>
                    <th style={{ minWidth: '200px' }}>{t('packet_monitor.column.content')}</th>
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
                    <col style={{ width: '35px' }} />
                    <col style={{ width: '45px' }} />
                    <col style={{ width: '110px' }} />
                    <col style={{ width: '140px' }} />
                    <col style={{ width: '140px' }} />
                    <col style={{ width: '120px' }} />
                    <col style={{ width: '110px' }} />
                    <col style={{ width: '60px' }} />
                    <col style={{ width: '60px' }} />
                    <col style={{ width: '60px' }} />
                    <col style={{ width: '80px' }} />
                    <col style={{ width: '60px' }} />
                    <col style={{ minWidth: '200px' }} />
                  </colgroup>
                  <tbody>
                    {rowVirtualizer.getVirtualItems().map(virtualRow => {
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
                            <td colSpan={14} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                              {t('packet_monitor.loading_more')}
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
                          <td
                            className={`direction ${packet.direction === 'tx' ? 'direction-tx' : 'direction-rx'}`}
                            style={{ width: '35px', textAlign: 'center' }}
                            title={packet.direction === 'tx' ? t('packet_monitor.direction_tx') : t('packet_monitor.direction_rx')}
                          >
                            {packet.direction === 'tx' ? 'TX' : 'RX'}
                          </td>
                          <td
                            className={`transport-mechanism transport-${packet.transport_mechanism ?? 'unknown'}`}
                            style={{ width: '45px', textAlign: 'center' }}
                            title={getTransportMechanismName(packet.transport_mechanism).full}
                          >
                            {getTransportMechanismName(packet.transport_mechanism).short}
                          </td>
                          <td
                            className="timestamp"
                            style={{ width: '110px' }}
                            title={formatDateTime(new Date(packet.timestamp * 1000), timeFormat, dateFormat)}
                          >
                            {formatTimestamp(packet.timestamp)}
                          </td>
                          <td
                            className="from-node"
                            style={{ width: '140px' }}
                            title={packet.from_node_longName || packet.from_node_id || ''}
                          >
                            {packet.from_node_id && onNodeClick ? (
                              <span className="node-id-link" onClick={e => handleNodeClick(packet.from_node_id!, e)}>
                                {truncateLongName(packet.from_node_longName) || packet.from_node_id}
                              </span>
                            ) : (
                              truncateLongName(packet.from_node_longName) || packet.from_node_id || packet.from_node
                            )}
                          </td>
                          <td
                            className="to-node"
                            style={{ width: '140px' }}
                            title={packet.to_node_longName || packet.to_node_id || ''}
                          >
                            {packet.to_node_id === '!ffffffff' ? (
                              t('packet_monitor.broadcast')
                            ) : packet.to_node_id && onNodeClick ? (
                              <span className="node-id-link" onClick={e => handleNodeClick(packet.to_node_id!, e)}>
                                {truncateLongName(packet.to_node_longName) || packet.to_node_id}
                              </span>
                            ) : (
                              truncateLongName(packet.to_node_longName) || packet.to_node_id || packet.to_node || t('common.na')
                            )}
                          </td>
                          <td
                            className="portnum"
                            style={{ width: '120px', color: getPortnumColor(packet.portnum) }}
                            title={packet.portnum_name || ''}
                          >
                            {packet.portnum_name || packet.portnum}
                          </td>
                          <td className="channel" style={{ width: '110px' }} title={packet.encrypted && packet.channel !== undefined && packet.channel > 7 ? `Encrypted channel (hash: ${packet.channel})` : undefined}>
                            {packet.encrypted && packet.channel !== undefined && packet.channel > 7 ? `?? (ch: ${packet.channel})` : (packet.channel ?? t('common.na'))}
                          </td>
                          <td className="snr" style={{ width: '60px' }}>
                            {packet.snr !== null && packet.snr !== undefined ? `${packet.snr.toFixed(1)}` : t('common.na')}
                          </td>
                          <td className="rssi" style={{ width: '60px' }}>
                            {packet.rssi !== null && packet.rssi !== undefined ? `${packet.rssi.toFixed(0)}` : t('common.na')}
                          </td>
                          <td className="hops" style={{ width: '60px' }}>
                            {hops !== null ? (
                              packet.relay_node !== undefined && packet.relay_node !== null ? (
                                <span
                                  className="hops-link"
                                  onClick={(e) => handleRelayClick(packet, e)}
                                  title={t('packet_monitor.click_for_relay')}
                                >
                                  {hops}
                                </span>
                              ) : (
                                hops
                              )
                            ) : (
                              t('common.na')
                            )}
                          </td>
                          <td className="last-hop" style={{ width: '80px' }}>
                            {(() => {
                              if (hops === 0) {
                                // Direct packet (0 hops)
                                return t('packet_monitor.direct');
                              } else if (hops !== null && hops > 0) {
                                // Relayed packet - show most likely relay name
                                const relayName = getMostLikelyRelayName(packet.relay_node, packet.rssi);
                                const isEstimate = packet.relay_node === 0 || packet.relay_node === undefined || packet.relay_node === null;
                                return (
                                  <span
                                    className={`relay-link ${isEstimate ? 'estimated' : ''}`}
                                    onClick={(e) => handleRelayClick(packet, e)}
                                    title={isEstimate ? t('packet_monitor.estimated_relay') : t('packet_monitor.click_for_relay')}
                                  >
                                    {relayName || '?'}
                                  </span>
                                );
                              } else {
                                return t('common.na');
                              }
                            })()}
                          </td>
                          <td className="size" style={{ width: '60px' }}>
                            {packet.payload_size ?? t('common.na')}
                          </td>
                          <td className="content" style={{ minWidth: '200px' }}>
                            {packet.encrypted ? (
                              <span className="encrypted-indicator">🔒 {t('packet_monitor.encrypted')}</span>
                            ) : (
                              <span className="content-preview">
                                {packet.decrypted_by === 'server' && (
                                  <span
                                    className="decryption-indicator server"
                                    title={t('packet_monitor.decrypted_by_server')}
                                    style={{
                                      marginRight: '0.25rem',
                                      color: 'var(--ctp-blue)',
                                      cursor: 'help'
                                    }}
                                  >
                                    🔑
                                  </span>
                                )}
                                {packet.decrypted_by === 'node' && (
                                  <span
                                    className="decryption-indicator node"
                                    title={t('packet_monitor.decrypted_by_node')}
                                    style={{
                                      marginRight: '0.25rem',
                                      color: 'var(--ctp-green)',
                                      cursor: 'help'
                                    }}
                                  >
                                    🔓
                                  </span>
                                )}
                                {packet.payload_preview || t('packet_monitor.no_preview')}
                              </span>
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
      {selectedPacket &&
        createPortal(
          <div className="packet-detail-modal" onClick={() => setSelectedPacket(null)}>
            <div className="packet-detail-content" onClick={e => e.stopPropagation()}>
              <div className="packet-detail-header">
                <h4>{t('packet_monitor.details_title')}</h4>
                <button className="close-btn" onClick={() => setSelectedPacket(null)}>
                  ×
                </button>
              </div>
              <div className="packet-detail-body">
                {(() => {
                  // Parse metadata if available
                  let parsedMetadata: Record<string, unknown> | null = null;
                  if (selectedPacket.metadata) {
                    try {
                      parsedMetadata = JSON.parse(selectedPacket.metadata);
                    } catch (e) {
                      // Ignore parse errors
                    }
                  }

                  // Build display object with packet fields and expanded metadata
                  const displayData: Record<string, unknown> = {
                    id: selectedPacket.id,
                    packet_id: selectedPacket.packet_id,
                    timestamp: selectedPacket.timestamp,
                    from_node: selectedPacket.from_node,
                    from_node_id: selectedPacket.from_node_id,
                    from_node_longName: selectedPacket.from_node_longName,
                    to_node: selectedPacket.to_node,
                    to_node_id: selectedPacket.to_node_id,
                    to_node_longName: selectedPacket.to_node_longName,
                    channel: selectedPacket.channel,
                    portnum: selectedPacket.portnum,
                    portnum_name: selectedPacket.portnum_name,
                    encrypted: selectedPacket.encrypted,
                    decrypted_by: selectedPacket.decrypted_by,
                    decrypted_channel_id: selectedPacket.decrypted_channel_id,
                    snr: selectedPacket.snr,
                    rssi: selectedPacket.rssi,
                    hop_limit: selectedPacket.hop_limit,
                    hop_start: selectedPacket.hop_start,
                    relay_node: selectedPacket.relay_node,
                    payload_size: selectedPacket.payload_size,
                    want_ack: selectedPacket.want_ack,
                    priority: selectedPacket.priority,
                    payload_preview: selectedPacket.payload_preview,
                  };

                  // Add metadata fields (decoded_payload, rx_time, via_mqtt, etc.)
                  if (parsedMetadata) {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { decoded_payload, ...otherMetadata } = parsedMetadata as Record<string, unknown>;
                    // Add other metadata fields
                    Object.assign(displayData, otherMetadata);
                    // Add decoded payload last so it appears at the bottom
                    if (decoded_payload) {
                      displayData.decoded_payload = decoded_payload;
                    }
                  }

                  // Remove undefined values for cleaner display
                  const cleanedData = Object.fromEntries(
                    Object.entries(displayData).filter(([, v]) => v !== undefined && v !== null)
                  );

                  return <pre className="packet-json">{JSON.stringify(cleanedData, null, 2)}</pre>;
                })()}
              </div>
            </div>
          </div>,
          document.body
        )}
      {/* Relay node modal */}
      {relayModalOpen && selectedRelayNode !== null && (
        <RelayNodeModal
          isOpen={relayModalOpen}
          onClose={() => {
            setRelayModalOpen(false);
            setSelectedRelayNode(null);
          }}
          relayNode={selectedRelayNode}
          rxTime={selectedRxTime}
          nodes={mappedNodes}
          messageRssi={selectedMessageRssi}
          onNodeClick={(nodeId) => {
            setRelayModalOpen(false);
            setSelectedRelayNode(null);
            if (onNodeClick) {
              onNodeClick(nodeId);
            }
          }}
        />
      )}
    </>
  );
};

export default PacketMonitorPanel;
