/**
 * HopDistributionWidget - Dashboard widget showing node count by hop distance
 *
 * Displays a horizontal bar chart of how many nodes are at each hop level,
 * plus summary stats like total nodes, direct neighbors, and longest path.
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type NodeInfo } from './TelemetryChart';

interface HopDistributionWidgetProps {
  id: string;
  nodes: Map<string, NodeInfo>;
  onRemove: () => void;
  canEdit?: boolean;
}

interface HopBucket {
  label: string;
  count: number;
  hop: number | string;
}

const MIN_DISPLAY_HOPS = 3;

const HopDistributionWidget: React.FC<HopDistributionWidgetProps> = ({
  id,
  nodes,
  onRemove,
  canEdit = true,
}) => {
  const { t } = useTranslation();

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const { buckets, totalNodes, maxHop, unknownCount } = useMemo(() => {
    const hopCounts = new Map<number, number>();
    let unknown = 0;
    let total = 0;
    let maxH = 0;

    for (const [, node] of nodes) {
      total++;
      const hops = node.hopsAway;
      if (hops === undefined || hops === null) {
        unknown++;
      } else {
        hopCounts.set(hops, (hopCounts.get(hops) || 0) + 1);
        if (hops > maxH) maxH = hops;
      }
    }

    // Build buckets for 0 through maxHop (at least up to MIN_DISPLAY_HOPS for visual consistency)
    const displayMax = Math.max(maxH, MIN_DISPLAY_HOPS);
    const result: HopBucket[] = [];
    for (let h = 0; h <= displayMax; h++) {
      result.push({
        label: h === 0
          ? t('dashboard.widget.hop_distribution.direct')
          : t('dashboard.widget.hop_distribution.hops', { count: h }),
        count: hopCounts.get(h) || 0,
        hop: h,
      });
    }

    return {
      buckets: result,
      totalNodes: total,
      maxHop: maxH,
      unknownCount: unknown,
    };
  }, [nodes, t]);

  const maxCount = Math.max(...buckets.map(b => b.count), 1);

  // Color gradient from green (close) to yellow to red (far)
  const getBarColor = (hop: number | string): string => {
    if (typeof hop === 'string') return 'var(--ctp-overlay1)';
    const colors = [
      'var(--ctp-green)',
      'var(--ctp-teal)',
      'var(--ctp-blue)',
      'var(--ctp-lavender)',
      'var(--ctp-mauve)',
      'var(--ctp-pink)',
      'var(--ctp-red)',
    ];
    return colors[Math.min(hop, colors.length - 1)];
  };

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container hop-distribution-widget">
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <h3 className="dashboard-chart-title">{t('dashboard.widget.hop_distribution.title')}</h3>
        {canEdit && (
          <button className="dashboard-remove-btn" onClick={onRemove} title={t('dashboard.remove_widget')} aria-label={t('dashboard.remove_widget')}>
            ×
          </button>
        )}
      </div>

      <div className="hop-distribution-content">
        {/* Summary stats */}
        <div className="hop-distribution-summary">
          <div className="hop-stat">
            <span className="hop-stat-value">{totalNodes}</span>
            <span className="hop-stat-label">{t('dashboard.widget.hop_distribution.total_nodes')}</span>
          </div>
          <div className="hop-stat">
            <span className="hop-stat-value">{buckets[0]?.count || 0}</span>
            <span className="hop-stat-label">{t('dashboard.widget.hop_distribution.direct_neighbors')}</span>
          </div>
          <div className="hop-stat">
            <span className="hop-stat-value">{maxHop}</span>
            <span className="hop-stat-label">{t('dashboard.widget.hop_distribution.longest_path')}</span>
          </div>
        </div>

        {/* Bar chart */}
        <div className="hop-distribution-chart">
          {buckets.map(bucket => (
            <div key={String(bucket.hop)} className="hop-bar-row">
              <span className="hop-bar-label">{bucket.label}</span>
              <div className="hop-bar-track">
                <div
                  className="hop-bar-fill"
                  style={{
                    width: `${(bucket.count / maxCount) * 100}%`,
                    backgroundColor: getBarColor(bucket.hop),
                  }}
                />
              </div>
              <span className="hop-bar-count">{bucket.count}</span>
            </div>
          ))}
          {unknownCount > 0 && (
            <div className="hop-bar-row">
              <span className="hop-bar-label">{t('dashboard.widget.hop_distribution.unknown')}</span>
              <div className="hop-bar-track">
                <div
                  className="hop-bar-fill"
                  style={{
                    width: `${(unknownCount / maxCount) * 100}%`,
                    backgroundColor: 'var(--ctp-overlay1)',
                  }}
                />
              </div>
              <span className="hop-bar-count">{unknownCount}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default HopDistributionWidget;
