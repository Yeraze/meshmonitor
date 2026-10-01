/**
 * Traceroute Explorer (#5511) — detail drawer for the selected run.
 *
 * Reuses the app's existing traceroute pieces: `TracerouteStrip` for the
 * hop-by-hop view, `TracerouteCopyLinks` for plain-text copy, and
 * `TracerouteHistoryModal` for the pair's full stored history.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import TracerouteStrip from '../../traceroute/TracerouteStrip';
import { TracerouteCopyLinks } from '../../traceroute/TracerouteCopyLinks';
import TracerouteHistoryModal from '../../TracerouteHistoryModal';
import { buildTracerouteStripGraph } from '../../../utils/tracerouteStrip';
import { buildStripNodeMeta } from '../../../utils/tracerouteStripMeta';
import { formatDateTime } from '../../../utils/datetime';
import { useSettings } from '../../../contexts/SettingsContext';
import type { DeviceInfo } from '../../../types/device';
import { nodeLabel, nodeLongLabel, pathVariants, type ExplorerNodeWire, type ExplorerRun } from './explorerModel';
import styles from './TracerouteExplorer.module.css';

export interface ExplorerDetailProps {
  run: ExplorerRun | null;
  /** Every loaded run of the selected run's pair (unfiltered), newest first. */
  pairRuns: ExplorerRun[];
  nodes: Map<number, ExplorerNodeWire>;
  devices: DeviceInfo[];
  sourceNames: Map<string, string>;
}

export const ExplorerDetail: React.FC<ExplorerDetailProps> = ({ run, pairRuns, nodes, devices, sourceNames }) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat, distanceUnit, nodeHopsCalculation } = useSettings();
  const [historyOpen, setHistoryOpen] = useState(false);

  const strip = useMemo(() => {
    if (!run) return null;
    const graph = buildTracerouteStripGraph(run.wire);
    if (graph.isEmpty) return null;
    const meta = buildStripNodeMeta(graph, devices, {
      hopsCalculation: nodeHopsCalculation,
      traceroutes: [],
      currentNodeNum: null,
    });
    return { graph, meta };
  }, [run, devices, nodeHopsCalculation]);

  const variants = useMemo(() => pathVariants(pairRuns), [pairRuns]);
  const answeredTotal = variants.reduce((sum, v) => sum + v.count, 0);

  if (!run) {
    return (
      <div className={styles.detailEmpty}>
        {t(
          'analysis.traceroute_explorer.detail_empty',
          'Select a run in the table, or a link on the map, to see its hop-by-hop path and every path this pair has used.',
        )}
      </div>
    );
  }

  const sources = run.sourceIds.map(id => sourceNames.get(id) ?? id).join(', ');
  const packetHex = run.wire.packetId != null ? `0x${(run.wire.packetId >>> 0).toString(16)}` : null;

  return (
    <div className={styles.detail} data-testid="traceroute-explorer-detail">
      <div className={styles.detailMain}>
        <h3 className={styles.detailTitle}>
          {nodeLongLabel(nodes, run.fromNodeNum)}
          <UiIcon name="forward" size={16} className={styles.titleArrow} />
          {nodeLongLabel(nodes, run.toNodeNum)}
        </h3>
        <div className={styles.detailMeta}>
          {[
            formatDateTime(new Date(run.timestamp), timeFormat, dateFormat),
            sources,
            run.transport.toUpperCase(),
            packetHex && t('analysis.traceroute_explorer.packet', 'packet {{id}}', { id: packetHex }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {strip ? (
          <TracerouteStrip
            graph={strip.graph}
            meta={strip.meta}
            timeFormat={timeFormat}
            dateFormat={dateFormat}
            distanceUnit={distanceUnit}
          />
        ) : (
          <p className={styles.muted}>
            {t('analysis.traceroute_explorer.detail_no_route', 'The destination never answered, so no route was stored for this run.')}
          </p>
        )}
        <div className={styles.detailActions}>
          <button type="button" className="reports-btn reports-btn--ghost" onClick={() => setHistoryOpen(true)}>
            {t('analysis.traceroute_explorer.pair_history', 'Pair history')}
          </button>
          {run.answered && (
            <TracerouteCopyLinks
              route={run.wire.route}
              routeBack={run.wire.routeBack}
              snrTowards={run.wire.snrTowards}
              snrBack={run.wire.snrBack}
              fromNodeNum={run.fromNodeNum}
              toNodeNum={run.toNodeNum}
              nodes={devices}
            />
          )}
        </div>
      </div>
      <div className={styles.detailSide}>
        <div className={styles.eyebrow}>{t('analysis.traceroute_explorer.paths_used', 'Paths this pair has used')}</div>
        {variants.length === 0 ? (
          <p className={styles.muted}>{t('analysis.traceroute_explorer.no_answered_runs', 'No answered runs in this window.')}</p>
        ) : (
          <ul className={styles.variants}>
            {variants.map(v => (
              <li key={v.path.join('>')}>
                <span className={styles.variantPath}>{v.path.map(n => nodeLabel(nodes, n)).join(' › ')}</span>
                <span className={styles.bar}>
                  <span style={{ width: `${(v.count / answeredTotal) * 100}%` }} />
                </span>
                <span className={styles.muted}>
                  {t('analysis.traceroute_explorer.variant_count', '{{count}} of {{total}} answered runs', {
                    count: v.count,
                    total: answeredTotal,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {historyOpen && (
        <TracerouteHistoryModal
          fromNodeNum={run.fromNodeNum}
          toNodeNum={run.toNodeNum}
          fromNodeName={nodeLongLabel(nodes, run.fromNodeNum)}
          toNodeName={nodeLongLabel(nodes, run.toNodeNum)}
          nodes={devices}
          sourceId={run.sourceIds[0]}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
};

export default ExplorerDetail;
