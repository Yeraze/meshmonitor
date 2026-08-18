/**
 * `NodeSkyView` — the GNSS sky-plot section shown inside Node Details (#4729).
 *
 * Given a node that has a position, it renders the theoretical GPS constellation
 * overhead (via `useSkyView`) and a reported-vs-theoretical diagnostic: the
 * node's most recent `sats_in_view` telemetry reading next to the count the
 * almanac says should be visible. A large gap hints at antenna, sky-view, or
 * receiver trouble.
 *
 * Self-contained and collapsible, and deliberately deferred: the data-fetching
 * body (`SkyViewBody`) only mounts once the user opens the section, so selecting
 * a node costs nothing — and, since the TanStack Query hooks live only in that
 * child, a collapsed section needs no QueryClient in its render tree.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceInfo } from '../../types/device';
import { useTelemetry } from '../../hooks/useTelemetry';
import { getLatestValue } from '../../utils/telemetry';
import { useSkyView } from '../../hooks/useSkyView';
import { UiIcon } from '../icons';
import { SkyPlot } from './SkyPlot';
import styles from './NodeSkyView.module.css';

export interface NodeSkyViewProps {
  node: DeviceInfo;
  sourceId?: string | null;
}

/** Node id in `!xxxxxxxx` form for the telemetry endpoint. */
function resolveNodeId(node: DeviceInfo): string | null {
  if (node.user?.id) return node.user.id;
  if (typeof node.nodeNum === 'number') {
    return `!${node.nodeNum.toString(16).padStart(8, '0')}`;
  }
  return null;
}

interface SkyViewBodyProps {
  node: DeviceInfo;
  sourceId?: string | null;
  lat: number;
  lon: number;
}

/** Data-fetching body — only mounted while the section is expanded. */
const SkyViewBody: React.FC<SkyViewBodyProps> = ({ node, sourceId, lat, lon }) => {
  const { t } = useTranslation();
  const { satellites, dop, visibleCount, isLoading, error } = useSkyView({ lat, lon });

  const nodeId = resolveNodeId(node);
  const { data: telemetry = [] } = useTelemetry({
    nodeId: nodeId ?? '',
    hours: 24,
    sourceId,
    enabled: !!nodeId,
  });

  // Most recent reported sats_in_view within the window (null when none).
  const satsRows = telemetry.filter((row) => row.telemetryType === 'sats_in_view');
  const reported = getLatestValue(satsRows);
  const reportedCount = reported ? Math.round(reported.value) : null;

  if (error) {
    return <div className={styles.message}>{t('gnss.sky_view_error', 'Sky view unavailable')}</div>;
  }
  if (isLoading) {
    return <div className={styles.message}>{t('common.loading', 'Loading…')}</div>;
  }

  return (
    <>
      <SkyPlot satellites={satellites} dop={dop} />
      <div className={styles.diagnostic}>
        <span className={styles.diagnosticLabel}>{t('gnss.gps_in_view', 'GPS in view')}</span>
        <span className={styles.diagnosticValues}>
          {t('gnss.reported', 'reported')}{' '}
          <strong>{reportedCount != null ? reportedCount : '—'}</strong>
          {' · '}
          {t('gnss.theoretical', 'theoretical')}{' '}
          <strong>{visibleCount != null ? visibleCount : '—'}</strong>
        </span>
      </div>
    </>
  );
};

export const NodeSkyView: React.FC<NodeSkyViewProps> = ({ node, sourceId }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const lat = node.position?.latitude;
  const lon = node.position?.longitude;
  const hasPosition = typeof lat === 'number' && typeof lon === 'number';

  if (!hasPosition) return null;

  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={styles.headerLabel}>
          <UiIcon name="location" size={14} />
          {t('gnss.sky_view', 'GNSS Sky View')}
        </span>
        <UiIcon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />
      </button>

      {expanded && (
        <div className={styles.body}>
          <SkyViewBody node={node} sourceId={sourceId} lat={lat!} lon={lon!} />
        </div>
      )}
    </div>
  );
};

export default NodeSkyView;
