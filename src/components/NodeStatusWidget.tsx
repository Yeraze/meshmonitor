/**
 * NodeStatusWidget - Dashboard widget for monitoring node status
 *
 * Displays a table showing:
 * - Node Name
 * - Last Heard time
 * - Number of Hops
 *
 * Supports multiple nodes with search-based adding
 * Sorted by Last Heard time (most recent first)
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type NodeInfo } from './TelemetryChart';

interface NodeStatusWidgetProps {
  id: string;
  nodeIds: string[];
  nodes: Map<string, NodeInfo>;
  onRemove: () => void;
  onAddNode: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  canEdit?: boolean;
}

interface NodeStatusRow {
  nodeId: string;
  name: string;
  lastHeard: number | null;
  hopsAway: number | null;
}

const NodeStatusWidget: React.FC<NodeStatusWidgetProps> = ({
  id,
  nodeIds,
  nodes,
  onRemove,
  onAddNode,
  onRemoveNode,
  canEdit = true,
}) => {
  const { t } = useTranslation();
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

  // Build node status rows sorted by last heard (most recent first)
  const nodeRows = useMemo((): NodeStatusRow[] => {
    return nodeIds
      .map(nodeId => {
        const node = nodes.get(nodeId);
        return {
          nodeId,
          name: node?.user?.longName || node?.user?.shortName || nodeId,
          lastHeard: node?.lastHeard ?? null,
          hopsAway: node?.hopsAway ?? null,
        };
      })
      .sort((a, b) => {
        // Sort by last heard descending (most recent first)
        if (a.lastHeard === null && b.lastHeard === null) return 0;
        if (a.lastHeard === null) return 1;
        if (b.lastHeard === null) return -1;
        return b.lastHeard - a.lastHeard;
      });
  }, [nodeIds, nodes]);

  // Filter available nodes for search
  const availableNodes = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return Array.from(nodes.entries())
      .filter(([nodeId, node]) => {
        // Exclude nodes already added
        if (nodeIds.includes(nodeId)) return false;
        // Filter by search query
        const name = (node?.user?.longName || node?.user?.shortName || nodeId).toLowerCase();
        return name.includes(query) || nodeId.toLowerCase().includes(query);
      })
      .map(([nodeId, node]) => ({
        nodeId,
        name: node?.user?.longName || node?.user?.shortName || nodeId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20); // Limit to 20 results
  }, [nodes, nodeIds, searchQuery]);

  const handleAddNode = useCallback(
    (nodeId: string) => {
      onAddNode(nodeId);
      setSearchQuery('');
      setShowSearch(false);
    },
    [onAddNode]
  );

  const formatLastHeard = (timestamp: number | null): string => {
    if (timestamp === null) return t('common.unknown');

    // Convert seconds to milliseconds if needed (timestamps < year 2000 are in seconds)
    const ms = timestamp < 946684800000 ? timestamp * 1000 : timestamp;
    const now = Date.now();
    const diff = now - ms;

    if (diff < 0) return t('common.just_now');
    if (diff < 60000) return t('common.seconds_ago', { count: Math.floor(diff / 1000) });
    if (diff < 3600000) return t('common.minutes_ago', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('common.hours_ago', { count: Math.floor(diff / 3600000) });
    return t('common.days_ago', { count: Math.floor(diff / 86400000) });
  };

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container node-status-widget">
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <h3 className="dashboard-chart-title">{t('dashboard.widget.node_status.title')}</h3>
        <button className="dashboard-remove-btn" onClick={onRemove} title={t('dashboard.remove_widget')}>
          ×
        </button>
      </div>

      <div className="node-status-content">
        {/* Add node search - only show if user can edit */}
        {canEdit && (
          <div className="node-status-add-section" ref={searchRef}>
            <div className="node-status-search-container">
              <input
                type="text"
                className="node-status-search"
                placeholder={t('dashboard.widget.node_status.search_placeholder')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => setShowSearch(true)}
              />
              {showSearch && availableNodes.length > 0 && (
                <div className="node-status-search-dropdown">
                  {availableNodes.map(node => (
                    <div key={node.nodeId} className="node-status-search-item" onClick={() => handleAddNode(node.nodeId)}>
                      {node.name}
                      <span className="node-status-search-id">{node.nodeId}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Node status table */}
        {nodeRows.length > 0 ? (
          <table className="node-status-table">
            <thead>
              <tr>
                <th>{t('nodes.node')}</th>
                <th>{t('nodes.last_heard')}</th>
                <th>{t('nodes.hops')}</th>
                {canEdit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {nodeRows.map(row => (
                <tr key={row.nodeId}>
                  <td className="node-status-name">{row.name}</td>
                  <td className="node-status-time">{formatLastHeard(row.lastHeard)}</td>
                  <td className="node-status-hops">{row.hopsAway !== null ? row.hopsAway : '-'}</td>
                  {canEdit && (
                    <td className="node-status-actions">
                      <button
                        className="node-status-remove-node"
                        onClick={() => onRemoveNode(row.nodeId)}
                        title={t('dashboard.widget.node_status.remove_node')}
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="node-status-empty">
            {canEdit ? t('dashboard.widget.node_status.empty_editable') : t('dashboard.widget.node_status.empty')}
          </div>
        )}
      </div>
    </div>
  );
};

export default NodeStatusWidget;
