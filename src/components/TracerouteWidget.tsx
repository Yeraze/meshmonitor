/**
 * TracerouteWidget - Dashboard widget for displaying traceroute information
 *
 * Shows the last successful traceroute to and from a selected node
 * with an interactive mini-map visualization
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSettings } from '../contexts/SettingsContext';
import { useSource } from '../contexts/SourceContext';
import { darkOverlayColors } from '../config/overlayColors';
import { useWidgetTrace, type WidgetTraceHop } from '../hooks/useWidgetTrace';
import { isUnknownSnr } from '../utils/mapHelpers';
import type { TracerouteRenderSegment } from '../utils/tracerouteSegments';
import { RouteFlowMap, type RouteFlowPoint } from './map/RouteFlowMap';
import type { MapNodeInfo } from '../types/device';
import { UiIcon } from './icons';

/**
 * Extended NodeInfo with position data for map rendering
 * Re-exported for backward compatibility
 */
type NodeInfo = MapNodeInfo;

interface TracerouteWidgetProps {
  id: string;
  targetNodeId: string | null;
  currentNodeId: string | null;
  nodes: Map<string, NodeInfo>;
  onRemove: () => void;
  onSelectNode: (nodeId: string) => void;
  /** Source protocol; decides where the trace comes from. Default meshtastic. */
  sourceKind?: 'meshtastic' | 'meshcore' | 'reticulum';
  canEdit?: boolean;
}

const TracerouteWidget: React.FC<TracerouteWidgetProps> = ({
  id,
  targetNodeId,
  currentNodeId,
  nodes,
  onRemove,
  onSelectNode,
  sourceKind = 'meshtastic',
  canEdit = true,
}) => {
  const { t } = useTranslation();
  const settings = useSettings();
  const { sourceId } = useSource();
  const snrColors = settings.overlayColors?.snrColors ?? darkOverlayColors.snrColors;
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showMap, setShowMap] = useState(false); // Map hidden by default
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

  // One normalised trace for either protocol (#6263 S6).
  const { trace, isLoading } = useWidgetTrace(sourceKind, { sourceId, targetNodeId, currentNodeId, nodes });

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

  const formatTimestamp = (timestamp: number): string => {
    const ms = timestamp < 946684800000 ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    return date.toLocaleString();
  };

  // Map data for the shared RouteFlowMap: forward path, plus the return leg
  // when the trace has one. Only hops with a position are drawn.
  const mapData = useMemo(() => {
    if (!trace) return null;
    const unique = new Map<string, WidgetTraceHop>();
    const legs: Array<{ hops: WidgetTraceHop[]; leg: 'forward' | 'return' }> = [{ hops: trace.forward, leg: 'forward' }];
    if (trace.back) legs.push({ hops: trace.back, leg: 'return' });
    for (const { hops } of legs) {
      for (const h of hops) {
        if (h.lat !== null && h.lon !== null && !unique.has(h.key)) unique.set(h.key, h);
      }
    }
    if (unique.size < 2) return null;
    const lastIdx = trace.forward.length - 1;
    const endpointKeys = new Set([trace.forward[0]?.key, trace.forward[lastIdx]?.key]);
    const points: RouteFlowPoint[] = Array.from(unique.values()).map((h) => ({
      key: h.key,
      label: h.label,
      lat: h.lat as number,
      lon: h.lon as number,
      kind: endpointKeys.has(h.key) ? 'endpoint' : 'hop',
    }));
    const segments: TracerouteRenderSegment[] = [];
    for (const { hops, leg } of legs) {
      const placed = hops.filter((h) => h.lat !== null && h.lon !== null);
      for (let i = 1; i < placed.length; i++) {
        const a = placed[i - 1];
        const b = placed[i];
        segments.push({
          key: `${leg}-${i}`,
          from: [a.lat as number, a.lon as number],
          to: [b.lat as number, b.lon as number],
          fromKey: a.key,
          toKey: b.key,
          leg,
          avgSnr: b.snr !== null && !isUnknownSnr(b.snr) ? b.snr : null,
          isMqtt: b.snr !== null && isUnknownSnr(b.snr),
        });
      }
    }
    const placedCount = new Set([...trace.forward, ...(trace.back ?? [])].map((h) => h.key)).size;
    return { points, segments, someUnplaced: unique.size < placedCount };
  }, [trace]);

  const renderRoute = (label: string, hops: WidgetTraceHop[] | null): React.ReactNode => {
    if (!hops) {
      return (
        <div className="traceroute-path-section">
          <div className="traceroute-path-label">{label}</div>
          <div className="traceroute-no-data">{t('dashboard.widget.traceroute.no_route_data')}</div>
        </div>
      );
    }
    return (
      <div className="traceroute-path-section">
        <div className="traceroute-path-label">{label}</div>
        <div className="traceroute-path">
          {hops.map((hop, idx) => {
            const hasPosition = hop.lat !== null;
            return (
              <React.Fragment key={`${hop.key}-${idx}`}>
                <span
                  className={`traceroute-hop ${!hasPosition ? 'no-position' : ''}`}
                  title={!hasPosition ? 'No position data' : undefined}
                >
                  {hop.label}
                  {!hasPosition && (
                    <span className="traceroute-no-pos-icon" title="No position data">
                      <UiIcon name="location" size={13} />
                    </span>
                  )}
                  {hop.snr !== null && <span className="traceroute-snr" title={isUnknownSnr(hop.snr) ? 'Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)' : undefined}>{isUnknownSnr(hop.snr) ? '?' : `${hop.snr.toFixed(1)} dB`}</span>}
                </span>
                {idx < hops.length - 1 && <span className="traceroute-arrow"><UiIcon name="forward" size={14} /></span>}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    );
  };

  const targetNodeName = targetNodeId
    ? nodes.get(targetNodeId)?.user?.longName || nodes.get(targetNodeId)?.user?.shortName || targetNodeId
    : null;

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container traceroute-widget">
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <h3 className="dashboard-chart-title">
          {t('dashboard.widget.traceroute.title')}
          {targetNodeName ? `: ${targetNodeName}` : ''}
        </h3>
        <button className="dashboard-remove-btn" onClick={onRemove} title={t('dashboard.remove_widget')} aria-label={t('dashboard.remove_widget')}>
          ×
        </button>
      </div>

      <div className="traceroute-content">
        {/* Node selection - only show if user can edit */}
        {canEdit && (
          <div className="traceroute-select-section" ref={searchRef}>
            <div className="traceroute-search-container">
              <input
                type="text"
                className="traceroute-search"
                placeholder={
                  targetNodeId
                    ? t('dashboard.widget.traceroute.change_node')
                    : t('dashboard.widget.traceroute.select_node')
                }
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
        )}

        {/* Traceroute display */}
        {!targetNodeId ? (
          <div className="traceroute-empty">
            {canEdit ? t('dashboard.widget.traceroute.empty_editable') : t('dashboard.widget.traceroute.empty')}
          </div>
        ) : isLoading ? (
          <div className="traceroute-loading">{t('dashboard.widget.traceroute.loading')}</div>
        ) : !trace ? (
          <div className="traceroute-no-data">{t('dashboard.widget.traceroute.no_data')}</div>
        ) : (
          <div className="traceroute-details">
            <div className="traceroute-header-row">
              <div className="traceroute-timestamp">
                {t('dashboard.widget.traceroute.last_traceroute')}:{' '}
                {formatTimestamp(trace.timestamp)}
              </div>
              {mapData && (
                <button
                  className="traceroute-map-toggle-inline"
                  onClick={() => setShowMap(!showMap)}
                  title={
                    showMap ? t('dashboard.widget.traceroute.hide_map') : t('dashboard.widget.traceroute.show_map')
                  }
                >
                  {showMap ? t('dashboard.widget.traceroute.hide_map') : t('dashboard.widget.traceroute.show_map')}
                  {mapData.someUnplaced && (
                    <span
                      className="traceroute-map-warning"
                      title={t('dashboard.widget.traceroute.no_position_warning')}
                    >
                      <UiIcon name="alert" size={14} />
                    </span>
                  )}
                </button>
              )}
            </div>

            {/* Mini Map: the shared RouteFlowMap, same for both protocols */}
            {mapData && showMap && (
              <div className="traceroute-map-section">
                <div className="traceroute-map-container">
                  <RouteFlowMap points={mapData.points} segments={mapData.segments} snrColors={snrColors} />
                </div>
              </div>
            )}

            {/* Show text routes only when map is hidden */}
            {!showMap && (
              <>
                {renderRoute(`${t('dashboard.widget.traceroute.forward_path')}:`, trace.forward)}

                {renderRoute(`${t('dashboard.widget.traceroute.return_path')}:`, trace.back)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TracerouteWidget;
