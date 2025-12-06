/**
 * TracerouteWidget - Dashboard widget for displaying traceroute information
 *
 * Shows the last successful traceroute to and from a selected node
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api';
import { type NodeInfo } from './TelemetryChart';

interface TracerouteData {
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string;
  routeBack: string;
  snrTowards?: string;
  snrBack?: string;
  timestamp: number;
  createdAt?: number;
}

interface TracerouteWidgetProps {
  id: string;
  targetNodeId: string | null;
  currentNodeId: string | null;
  nodes: Map<string, NodeInfo>;
  onRemove: () => void;
  onSelectNode: (nodeId: string) => void;
}

const TracerouteWidget: React.FC<TracerouteWidgetProps> = ({
  id,
  targetNodeId,
  currentNodeId,
  nodes,
  onRemove,
  onSelectNode,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Close search dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSearch(false);
      }
    };

    if (showSearch) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSearch]);

  // Fetch all traceroutes using the internal API (not v1 which requires auth)
  const { data: tracerouteData, isLoading } = useQuery<TracerouteData[]>({
    queryKey: ['traceroutes-recent'],
    queryFn: () => api.get('/api/traceroutes/recent'),
    refetchInterval: 60000, // Refresh every minute
    staleTime: 30000,
  });

  // Find traceroute to/from selected node
  const traceroute = useMemo(() => {
    if (!targetNodeId || !tracerouteData) return null;

    // Find traceroutes involving the target node
    const relevantTraceroutes = tracerouteData.filter(
      tr => tr.toNodeId === targetNodeId || tr.fromNodeId === targetNodeId
    );

    if (relevantTraceroutes.length === 0) return null;

    // Get the most recent one
    return relevantTraceroutes.sort((a, b) => {
      const aTime = a.timestamp || a.createdAt || 0;
      const bTime = b.timestamp || b.createdAt || 0;
      return bTime - aTime;
    })[0];
  }, [targetNodeId, tracerouteData]);

  // Filter available nodes for search
  const availableNodes = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return Array.from(nodes.entries())
      .filter(([nodeId, node]) => {
        // Exclude current node
        if (nodeId === currentNodeId) return false;
        // Filter by search query
        const name = (node?.user?.longName || node?.user?.shortName || nodeId).toLowerCase();
        return name.includes(query) || nodeId.toLowerCase().includes(query);
      })
      .map(([nodeId, node]) => ({
        nodeId,
        name: node?.user?.longName || node?.user?.shortName || nodeId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
  }, [nodes, currentNodeId, searchQuery]);

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      onSelectNode(nodeId);
      setSearchQuery('');
      setShowSearch(false);
    },
    [onSelectNode]
  );

  const getNodeName = useCallback(
    (nodeNum: number): string => {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      const node = nodes.get(nodeId);
      return node?.user?.longName || node?.user?.shortName || nodeId;
    },
    [nodes]
  );

  const formatTimestamp = (timestamp: number): string => {
    const ms = timestamp < 946684800000 ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    return date.toLocaleString();
  };

  const parseRoute = (routeJson: string, snrJson?: string): { nodeNum: number; snr?: number }[] => {
    try {
      const route = JSON.parse(routeJson);
      const snrs = snrJson ? JSON.parse(snrJson) : [];
      return route.map((nodeNum: number, idx: number) => ({
        nodeNum,
        snr: snrs[idx] !== undefined ? snrs[idx] / 4 : undefined,
      }));
    } catch {
      return [];
    }
  };

  const renderRoute = (
    label: string,
    fromNum: number,
    toNum: number,
    routeJson: string | null,
    snrJson?: string
  ): React.ReactNode => {
    if (!routeJson || routeJson === 'null' || routeJson === '') {
      return (
        <div className="traceroute-path-section">
          <div className="traceroute-path-label">{label}</div>
          <div className="traceroute-no-data">No route data available</div>
        </div>
      );
    }

    const hops = parseRoute(routeJson, snrJson);
    const fullPath = [
      { nodeNum: fromNum, snr: undefined },
      ...hops,
      { nodeNum: toNum, snr: hops.length > 0 ? hops[hops.length - 1]?.snr : undefined },
    ];

    return (
      <div className="traceroute-path-section">
        <div className="traceroute-path-label">{label}</div>
        <div className="traceroute-path">
          {fullPath.map((hop, idx) => (
            <React.Fragment key={`${hop.nodeNum}-${idx}`}>
              <span className="traceroute-hop">
                {getNodeName(hop.nodeNum)}
                {hop.snr !== undefined && <span className="traceroute-snr">{hop.snr.toFixed(1)} dB</span>}
              </span>
              {idx < fullPath.length - 1 && <span className="traceroute-arrow">→</span>}
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  };

  const targetNodeName = targetNodeId ? nodes.get(targetNodeId)?.user?.longName || nodes.get(targetNodeId)?.user?.shortName || targetNodeId : null;

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container traceroute-widget">
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <h3 className="dashboard-chart-title">
          Traceroute{targetNodeName ? `: ${targetNodeName}` : ''}
        </h3>
        <button className="dashboard-remove-btn" onClick={onRemove} title="Remove widget">
          ×
        </button>
      </div>

      <div className="traceroute-content">
        {/* Node selection */}
        <div className="traceroute-select-section" ref={searchRef}>
          <div className="traceroute-search-container">
            <input
              type="text"
              className="traceroute-search"
              placeholder={targetNodeId ? 'Change node...' : 'Select a node...'}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onFocus={() => setShowSearch(true)}
            />
            {showSearch && availableNodes.length > 0 && (
              <div className="traceroute-search-dropdown">
                {availableNodes.map(node => (
                  <div
                    key={node.nodeId}
                    className="traceroute-search-item"
                    onClick={() => handleSelectNode(node.nodeId)}
                  >
                    {node.name}
                    <span className="traceroute-search-id">{node.nodeId}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Traceroute display */}
        {!targetNodeId ? (
          <div className="traceroute-empty">Select a node above to view traceroute information.</div>
        ) : isLoading ? (
          <div className="traceroute-loading">Loading traceroute data...</div>
        ) : !traceroute ? (
          <div className="traceroute-no-data">No traceroute data available for this node.</div>
        ) : (
          <div className="traceroute-details">
            <div className="traceroute-timestamp">
              Last traceroute: {formatTimestamp(traceroute.timestamp || traceroute.createdAt || 0)}
            </div>

            {renderRoute(
              'Forward Path:',
              traceroute.fromNodeNum,
              traceroute.toNodeNum,
              traceroute.route,
              traceroute.snrTowards
            )}

            {renderRoute(
              'Return Path:',
              traceroute.toNodeNum,
              traceroute.fromNodeNum,
              traceroute.routeBack,
              traceroute.snrBack
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TracerouteWidget;
