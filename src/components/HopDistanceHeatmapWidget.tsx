/**
 * HopDistanceHeatmapWidget - Dashboard widget showing a heatmap of hops vs distance
 *
 * Displays a grid where rows are hop counts and columns are distance buckets,
 * with cells colored by the number of nodes in each combination.
 */

import React, { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type NodeInfo } from './TelemetryChart';
import { calculateDistance, kmToMiles } from '../utils/distance';

interface HopDistanceHeatmapWidgetProps {
  id: string;
  bucketSize: number;
  nodes: Map<string, NodeInfo>;
  currentNodeId: string | null;
  distanceUnit: 'km' | 'mi';
  onRemove: () => void;
  onBucketSizeChange: (size: number) => void;
  canEdit?: boolean;
}

interface NodeEntry {
  hops: number;
  distance: number;
}

const BUCKET_SIZE_OPTIONS = [1, 2, 5, 10, 15, 20, 25, 50, 100];

const HopDistanceHeatmapWidget: React.FC<HopDistanceHeatmapWidgetProps> = ({
  id,
  bucketSize,
  nodes,
  currentNodeId,
  distanceUnit,
  onRemove,
  onBucketSizeChange,
  canEdit = true,
}) => {
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const unitLabel = distanceUnit === 'mi'
    ? t('dashboard.widget.distance_distribution.miles')
    : t('dashboard.widget.distance_distribution.km');

  // Find the current/home node
  const homeNode = useMemo(() => {
    if (!currentNodeId) return null;
    for (const [, node] of nodes) {
      if (node.user?.id === currentNodeId) return node;
    }
    return null;
  }, [nodes, currentNodeId]);

  const { grid, hopLabels, distLabels, maxCount, skippedCount } = useMemo(() => {
    const homeLat = homeNode?.position?.latitude;
    const homeLon = homeNode?.position?.longitude;

    if (homeLat == null || homeLon == null) {
      return { grid: [], hopLabels: [], distLabels: [], maxCount: 0, skippedCount: 0 };
    }

    // Collect entries with both hops and position
    const entries: NodeEntry[] = [];
    let skipped = 0;

    for (const [, node] of nodes) {
      if (node.user?.id === currentNodeId) continue;

      const hops = node.hopsAway;
      const lat = node.position?.latitude;
      const lon = node.position?.longitude;

      if (hops == null || lat == null || lon == null) {
        skipped++;
        continue;
      }

      const distKm = calculateDistance(homeLat, homeLon, lat, lon);
      const dist = distanceUnit === 'mi' ? kmToMiles(distKm) : distKm;
      entries.push({ hops, distance: dist });
    }

    if (entries.length === 0) {
      return { grid: [], hopLabels: [], distLabels: [], maxCount: 0, skippedCount: skipped };
    }

    // Determine axis ranges
    const maxHop = Math.max(...entries.map(e => e.hops));
    const maxDist = Math.max(...entries.map(e => e.distance));
    const numDistBuckets = Math.max(Math.ceil(maxDist / bucketSize), 1);
    const displayMaxHop = Math.max(maxHop, 3);

    // Build labels
    const hLabels: string[] = [];
    for (let h = 0; h <= displayMaxHop; h++) {
      hLabels.push(h === 0
        ? t('dashboard.widget.hop_distribution.direct')
        : String(h));
    }

    const dLabels: string[] = [];
    for (let d = 0; d < numDistBuckets; d++) {
      dLabels.push(`${d * bucketSize}–${(d + 1) * bucketSize}`);
    }

    // Build grid[hop][distBucket] = count
    const g: number[][] = [];
    for (let h = 0; h <= displayMaxHop; h++) {
      g.push(new Array(numDistBuckets).fill(0));
    }

    for (const { hops, distance } of entries) {
      const hopIdx = Math.min(hops, displayMaxHop);
      const distIdx = Math.min(Math.floor(distance / bucketSize), numDistBuckets - 1);
      g[hopIdx][distIdx]++;
    }

    const max = Math.max(...g.flat(), 1);

    return {
      grid: g,
      hopLabels: hLabels,
      distLabels: dLabels,
      maxCount: max,
      skippedCount: skipped,
    };
  }, [nodes, homeNode, currentNodeId, distanceUnit, bucketSize, t]);

  const handleBucketSizeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    onBucketSizeChange(Number(e.target.value));
    setShowSettings(false);
  }, [onBucketSizeChange]);

  // Intensity-based color with dark text for readability
  const getCellStyle = (count: number): { backgroundColor: string; color: string; opacity: number } => {
    if (count === 0) return { backgroundColor: 'transparent', color: 'var(--ctp-text)', opacity: 0 };
    const intensity = count / maxCount;
    if (intensity <= 0.25) return { backgroundColor: 'var(--ctp-surface1)', color: 'var(--ctp-text)', opacity: 1 };
    if (intensity <= 0.5) return { backgroundColor: 'var(--ctp-blue)', color: 'var(--ctp-crust)', opacity: 1 };
    if (intensity <= 0.75) return { backgroundColor: 'var(--ctp-sapphire)', color: 'var(--ctp-crust)', opacity: 1 };
    return { backgroundColor: 'var(--ctp-teal)', color: 'var(--ctp-crust)', opacity: 1 };
  };

  const hasHomePosition = homeNode?.position?.latitude != null && homeNode?.position?.longitude != null;

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container heatmap-widget">
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <h3 className="dashboard-chart-title">
          {t('dashboard.widget.hop_distance_heatmap.title')}
          <span className="distance-unit-badge">{unitLabel}</span>
        </h3>
        <div className="distance-header-actions">
          {canEdit && (
            <button
              className="distance-settings-btn"
              onClick={() => setShowSettings(!showSettings)}
              title={t('dashboard.widget.distance_distribution.settings')}
              aria-label={t('dashboard.widget.distance_distribution.settings')}
            >
              ⚙
            </button>
          )}
          {canEdit && (
            <button className="dashboard-remove-btn" onClick={onRemove} title={t('dashboard.remove_widget')} aria-label={t('dashboard.remove_widget')}>
              ×
            </button>
          )}
        </div>
      </div>

      {showSettings && (
        <div className="distance-settings-panel">
          <label className="distance-settings-label">
            {t('dashboard.widget.distance_distribution.bucket_size')}
            <select
              value={bucketSize}
              onChange={handleBucketSizeChange}
              className="distance-bucket-select"
            >
              {BUCKET_SIZE_OPTIONS.map(size => (
                <option key={size} value={size}>
                  {size} {unitLabel}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="heatmap-content">
        {!hasHomePosition ? (
          <div className="node-status-empty">
            {t('dashboard.widget.distance_distribution.no_home_position')}
          </div>
        ) : grid.length === 0 ? (
          <div className="node-status-empty">
            {t('dashboard.widget.hop_distance_heatmap.no_data')}
          </div>
        ) : (
          <>
            <div className="heatmap-scroll-container">
              <table className="heatmap-table">
                <thead>
                  <tr>
                    <th className="heatmap-corner">
                      <span className="heatmap-axis-label-y">{t('dashboard.widget.hop_distance_heatmap.distance_axis', { unit: unitLabel })}</span>
                      <span className="heatmap-axis-divider" />
                      <span className="heatmap-axis-label-x">{t('dashboard.widget.hop_distance_heatmap.hops_axis')}</span>
                    </th>
                    {hopLabels.map((label, i) => (
                      <th key={i} className="heatmap-col-header">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {distLabels.map((distLabel, distIdx) => (
                    <tr key={distIdx}>
                      <th className="heatmap-row-header">{distLabel}</th>
                      {hopLabels.map((hopLabel, hopIdx) => {
                        const count = grid[hopIdx]?.[distIdx] ?? 0;
                        return (
                          <td
                            key={hopIdx}
                            className="heatmap-cell"
                            style={getCellStyle(count)}
                            title={`${hopLabel} ${hopIdx > 0 ? (hopIdx === 1 ? 'hop' : 'hops') : ''}, ${distLabel} ${unitLabel}: ${count} ${count === 1 ? 'node' : 'nodes'}`}
                          >
                            {count > 0 ? count : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {skippedCount > 0 && (
              <div className="heatmap-skipped">
                {t('dashboard.widget.hop_distance_heatmap.skipped', { count: skippedCount })}
              </div>
            )}

            {/* Legend */}
            <div className="heatmap-legend">
              <span className="heatmap-legend-label">{t('dashboard.widget.hop_distance_heatmap.fewer')}</span>
              <div className="heatmap-legend-bar">
                <span className="heatmap-legend-cell" style={{ backgroundColor: 'var(--ctp-surface1)' }} />
                <span className="heatmap-legend-cell" style={{ backgroundColor: 'var(--ctp-blue)' }} />
                <span className="heatmap-legend-cell" style={{ backgroundColor: 'var(--ctp-sapphire)' }} />
                <span className="heatmap-legend-cell" style={{ backgroundColor: 'var(--ctp-teal)' }} />
              </div>
              <span className="heatmap-legend-label">{t('dashboard.widget.hop_distance_heatmap.more')}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default HopDistanceHeatmapWidget;
