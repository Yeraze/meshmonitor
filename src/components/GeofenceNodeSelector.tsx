import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { GeofenceNodeFilter } from './auto-responder/types';

interface NodeInfo {
  nodeNum: number;
  longName?: string;
  shortName?: string;
  nodeId?: string;
}

interface GeofenceNodeSelectorProps {
  nodeFilter: GeofenceNodeFilter;
  onFilterChange: (filter: GeofenceNodeFilter) => void;
  nodes: NodeInfo[];
}

const GeofenceNodeSelector: React.FC<GeofenceNodeSelectorProps> = ({
  nodeFilter,
  onFilterChange,
  nodes
}) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');

  const isAllNodes = nodeFilter.type === 'all';

  const handleToggleMode = (mode: 'all' | 'selected') => {
    if (mode === 'all') {
      onFilterChange({ type: 'all' });
    } else {
      onFilterChange({ type: 'selected', nodeNums: [] });
    }
  };

  const handleNodeToggle = (nodeNum: number) => {
    if (nodeFilter.type !== 'selected') return;

    const currentNodes = nodeFilter.nodeNums || [];
    const newNodes = currentNodes.includes(nodeNum)
      ? currentNodes.filter(n => n !== nodeNum)
      : [...currentNodes, nodeNum];

    onFilterChange({ type: 'selected', nodeNums: newNodes });
  };

  const filteredNodes = useMemo(() => {
    if (!searchTerm.trim()) return nodes;

    const term = searchTerm.toLowerCase();
    return nodes.filter(node => {
      const longName = (node.longName || '').toLowerCase();
      const shortName = (node.shortName || '').toLowerCase();
      const nodeId = (node.nodeId || '').toLowerCase();

      return longName.includes(term) ||
             shortName.includes(term) ||
             nodeId.includes(term);
    });
  }, [nodes, searchTerm]);

  const selectedNodeNums = nodeFilter.type === 'selected' ? nodeFilter.nodeNums || [] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Radio Toggle */}
      <div style={{ display: 'flex', gap: '16px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
          <input
            type="radio"
            checked={isAllNodes}
            onChange={() => handleToggleMode('all')}
            style={{ cursor: 'pointer' }}
          />
          <span style={{ color: 'var(--ctp-text)' }}>
            {t('automation.geofence_triggers.all_nodes', 'All Nodes')}
          </span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
          <input
            type="radio"
            checked={!isAllNodes}
            onChange={() => handleToggleMode('selected')}
            style={{ cursor: 'pointer' }}
          />
          <span style={{ color: 'var(--ctp-text)' }}>
            {t('automation.geofence_triggers.selected_nodes', 'Selected Nodes')}
          </span>
        </label>
      </div>

      {/* Node Selection */}
      {!isAllNodes && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '12px',
          backgroundColor: 'var(--ctp-surface0)',
          borderRadius: '6px',
          border: '1px solid var(--ctp-surface1)'
        }}>
          {/* Search Input */}
          <input
            type="text"
            placeholder={t('automation.geofence_triggers.search_nodes', 'Search nodes...')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              padding: '8px 12px',
              backgroundColor: 'var(--ctp-base)',
              color: 'var(--ctp-text)',
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '4px',
              fontSize: '14px',
              outline: 'none'
            }}
          />

          {/* Node List */}
          <div style={{
            maxHeight: '240px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px'
          }}>
            {filteredNodes.length === 0 ? (
              <div style={{
                padding: '12px',
                color: 'var(--ctp-subtext0)',
                textAlign: 'center',
                fontSize: '14px'
              }}>
                {searchTerm
                  ? t('automation.geofence_triggers.no_nodes_found', 'No nodes found')
                  : t('automation.geofence_triggers.no_nodes_available', 'No nodes available')
                }
              </div>
            ) : (
              filteredNodes.map(node => {
                const isChecked = selectedNodeNums.includes(node.nodeNum);
                const displayName = node.longName || node.shortName || 'Unknown';
                const nodeIdStr = node.nodeId || `#${node.nodeNum}`;

                return (
                  <label
                    key={node.nodeNum}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '8px',
                      backgroundColor: isChecked ? 'var(--ctp-surface1)' : 'transparent',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      transition: 'background-color 0.15s ease'
                    }}
                    onMouseEnter={(e) => {
                      if (!isChecked) {
                        e.currentTarget.style.backgroundColor = 'var(--ctp-surface0)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isChecked) {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => handleNodeToggle(node.nodeNum)}
                      style={{ cursor: 'pointer' }}
                    />
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      fontSize: '14px',
                      flex: 1
                    }}>
                      <div style={{
                        color: 'var(--ctp-text)',
                        fontWeight: 500
                      }}>
                        {displayName}
                        {node.shortName && node.longName && node.shortName !== node.longName && (
                          <span style={{
                            marginLeft: '6px',
                            color: 'var(--ctp-subtext0)',
                            fontWeight: 400
                          }}>
                            ({node.shortName})
                          </span>
                        )}
                      </div>
                      <div style={{
                        color: 'var(--ctp-subtext0)',
                        fontSize: '12px'
                      }}>
                        {nodeIdStr}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          {/* Selection Count */}
          {selectedNodeNums.length > 0 && (
            <div style={{
              padding: '8px',
              backgroundColor: 'var(--ctp-base)',
              borderRadius: '4px',
              color: 'var(--ctp-subtext0)',
              fontSize: '13px',
              textAlign: 'center'
            }}>
              {t('automation.geofence_triggers.nodes_selected', {
                count: selectedNodeNums.length,
                defaultValue: `${selectedNodeNums.length} node(s) selected`
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default GeofenceNodeSelector;
