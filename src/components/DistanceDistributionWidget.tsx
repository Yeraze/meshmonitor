/**
 * DistanceDistributionWidget - Dashboard widget showing node count by distance
 *
 * Displays a horizontal bar chart of how many nodes fall into each distance
 * bucket from the current node, with a configurable bucket size.
 */

import React, { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type NodeInfo } from './TelemetryChart';
import { calculateDistance, kmToMiles } from '../utils/distance';

interface DistanceDistributionWidgetProps {
  id: string;
  bucketSize: number;
  nodes: Map<string, NodeInfo>;
  currentNodeId: string | null;
  distanceUnit: 'km' | 'mi';
  onRemove: () => void;
  onBucketSizeChange: (size: number) => void;
  canEdit?: boolean;
}

interface DistanceBucket {
  label: string;
  count: number;
  index: number;
}

const BUCKET_SIZE_OPTIONS = [1, 2, 5, 10, 15, 20, 25, 50, 100];

const DistanceDistributionWidget: React.FC<DistanceDistributionWidgetProps> = ({
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

  const unitLabel = distanceUnit === 'mi' ? t('dashboard.widget.distance_distribution.miles') : t('dashboard.widget.distance_distribution.km');

  // Find the current/home node
  const homeNode = useMemo(() => {
    if (!currentNodeId) return null;
    for (const [, node] of nodes) {
      if (node.user?.id === currentNodeId) return node;
    }
    return null;
  }, [nodes, currentNodeId]);

  const { buckets, noPositionCount, totalWithPosition, maxDistance, avgDistance } = useMemo(() => {
    const homeLat = homeNode?.position?.latitude;
    const homeLon = homeNode?.position?.longitude;

    if (homeLat == null || homeLon == null) {
      return { buckets: [], noPositionCount: 0, totalWithPosition: 0, maxDistance: 0, avgDistance: 0 };
    }

    const distances: number[] = [];
    let noPos = 0;

    for (const [, node] of nodes) {
      // Skip self
      if (node.user?.id === currentNodeId) continue;

      const lat = node.position?.latitude;
      const lon = node.position?.longitude;

      if (lat == null || lon == null) {
        noPos++;
        continue;
      }

      let distKm = calculateDistance(homeLat, homeLon, lat, lon);
      const dist = distanceUnit === 'mi' ? kmToMiles(distKm) : distKm;
      distances.push(dist);
    }

    if (distances.length === 0) {
      return { buckets: [], noPositionCount: noPos, totalWithPosition: 0, maxDistance: 0, avgDistance: 0 };
    }

    const maxDist = Math.max(...distances);
    const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;

    // Build buckets
    const numBuckets = Math.ceil(maxDist / bucketSize) || 1;
    const bucketCounts = new Array(numBuckets).fill(0);

    for (const d of distances) {
      const idx = Math.min(Math.floor(d / bucketSize), numBuckets - 1);
      bucketCounts[idx]++;
    }

    const result: DistanceBucket[] = bucketCounts.map((count, i) => {
      const from = i * bucketSize;
      const to = (i + 1) * bucketSize;
      return {
        label: `${from}–${to}`,
        count,
        index: i,
      };
    });

    return {
      buckets: result,
      noPositionCount: noPos,
      totalWithPosition: distances.length,
      maxDistance: maxDist,
      avgDistance: avgDist,
    };
  }, [nodes, homeNode, currentNodeId, distanceUnit, bucketSize]);

  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  const handleBucketSizeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    onBucketSizeChange(Number(e.target.value));
    setShowSettings(false);
  }, [onBucketSizeChange]);

  // Color gradient based on distance
  const getBarColor = (index: number, total: number): string => {
    const colors = [
      'var(--ctp-green)',
      'var(--ctp-teal)',
      'var(--ctp-blue)',
      'var(--ctp-lavender)',
      'var(--ctp-mauve)',
      'var(--ctp-pink)',
      'var(--ctp-red)',
    ];
    if (total <= 1) return colors[0];
    const colorIndex = Math.round((index / (total - 1)) * (colors.length - 1));
    return colors[colorIndex];
  };

  const hasHomePosition = homeNode?.position?.latitude != null && homeNode?.position?.longitude != null;

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container distance-distribution-widget">
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <h3 className="dashboard-chart-title">
          {t('dashboard.widget.distance_distribution.title')}
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

      {/* Settings dropdown */}
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

      <div className="hop-distribution-content">
        {!hasHomePosition ? (
          <div className="node-status-empty">
            {t('dashboard.widget.distance_distribution.no_home_position')}
          </div>
        ) : buckets.length === 0 ? (
          <div className="node-status-empty">
            {t('dashboard.widget.distance_distribution.no_position_data')}
          </div>
        ) : (
          <>
            {/* Summary stats */}
            <div className="hop-distribution-summary">
              <div className="hop-stat">
                <span className="hop-stat-value">{totalWithPosition}</span>
                <span className="hop-stat-label">{t('dashboard.widget.distance_distribution.with_position')}</span>
              </div>
              <div className="hop-stat">
                <span className="hop-stat-value">{avgDistance.toFixed(1)}</span>
                <span className="hop-stat-label">{t('dashboard.widget.distance_distribution.avg_distance', { unit: unitLabel })}</span>
              </div>
              <div className="hop-stat">
                <span className="hop-stat-value">{maxDistance.toFixed(1)}</span>
                <span className="hop-stat-label">{t('dashboard.widget.distance_distribution.max_distance', { unit: unitLabel })}</span>
              </div>
            </div>

            {/* Bar chart */}
            <div className="hop-distribution-chart">
              {buckets.map(bucket => (
                <div key={bucket.index} className="hop-bar-row">
                  <span className="hop-bar-label">{bucket.label}</span>
                  <div className="hop-bar-track">
                    <div
                      className="hop-bar-fill"
                      style={{
                        width: `${(bucket.count / maxCount) * 100}%`,
                        backgroundColor: getBarColor(bucket.index, buckets.length),
                      }}
                    />
                  </div>
                  <span className="hop-bar-count">{bucket.count}</span>
                </div>
              ))}
              {noPositionCount > 0 && (
                <div className="hop-bar-row">
                  <span className="hop-bar-label">{t('dashboard.widget.distance_distribution.no_gps')}</span>
                  <div className="hop-bar-track">
                    <div
                      className="hop-bar-fill"
                      style={{
                        width: `${(noPositionCount / maxCount) * 100}%`,
                        backgroundColor: 'var(--ctp-overlay1)',
                      }}
                    />
                  </div>
                  <span className="hop-bar-count">{noPositionCount}</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DistanceDistributionWidget;
