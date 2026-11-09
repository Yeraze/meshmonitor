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
import { UNRESOLVED_HOP_NUM } from '../../../utils/meshcoreTraceRun';
import {
  nodeLabel,
  nodeLongLabel,
  pathVariants,
  type ExplorerNodeWire,
  type ExplorerProtocol,
  type ExplorerRun,
  type ExplorerRunWire,
} from './explorerModel';
import styles from './TracerouteExplorer.module.css';

/** First synthetic number for an unresolved-hash hop; far from real node numbers. */
const PLACEHOLDER_BASE = 0xffe00000;
const NO_DEVICES: DeviceInfo[] = [];

/**
 * The strip and copy links read Meshtastic-shaped numbers. A MeshCore run
 * sends `UNRESOLVED_HOP_NUM` for every unresolved hop, which the strip would
 * draw as one anonymous "Unknown". Give each distinct unresolved hash its own
 * placeholder number (and a device entry) for THIS run only, so the strip
 * labels it `?a3` and says how many contacts matched.
 */
function withHashPlaceholders(
  run: ExplorerRun,
  base: DeviceInfo[],
  unresolvedLabel: (hash: string, candidates: number) => string,
): { wire: ExplorerRunWire; devices: DeviceInfo[] } {
  const w = run.wire;
  if (run.protocol !== 'meshcore' || !w.routeKeys) return { wire: w, devices: base };
  const meta = new Map((w.hopMeta ?? []).map(h => [h.key, h]));
  const assigned = new Map<string, number>();
  const extra: DeviceInfo[] = [];
  const numFor = (key: string, original: number): number => {
    if (!key.startsWith('mch:')) return original;
    let n = assigned.get(key);
    if (n === undefined) {
      n = PLACEHOLDER_BASE + assigned.size;
      assigned.set(key, n);
      const hash = key.slice(4);
      const candidates = meta.get(key)?.candidates ?? 0;
      extra.push({
        nodeNum: n,
        user: { id: key, shortName: `?${hash}`.slice(0, 5), longName: unresolvedLabel(hash, candidates) },
      } as DeviceInfo);
    }
    return n;
  };
  const remap = (json: string | null, keys: string[]): string | null => {
    if (json == null) return json;
    try {
      const nums = JSON.parse(json) as number[];
      return JSON.stringify(nums.map((n, i) => (n === UNRESOLVED_HOP_NUM && keys[i] ? numFor(keys[i], n) : n)));
    } catch {
      return json;
    }
  };
  // Route entries are the nodes between `from` and `to`.
  const fwd = w.routeKeys.slice(1, w.reachedTarget === false ? undefined : -1);
  const back = w.routeBackKeys ? w.routeBackKeys.slice(w.reachedTarget === false ? 0 : 1, -1) : [];
  const wire = { ...w, route: remap(w.route, fwd), routeBack: remap(w.routeBack, back) };
  return { wire, devices: extra.length > 0 ? [...base, ...extra] : base };
}

export interface ExplorerDetailProps {
  run: ExplorerRun | null;
  /** Every loaded run of the selected run's pair (unfiltered), newest first. */
  pairRuns: ExplorerRun[];
  nodes: Map<string, ExplorerNodeWire>;
  /** Per protocol, so a synthetic MeshCore number can never match a Meshtastic node. */
  devicesByProtocol: Record<ExplorerProtocol, DeviceInfo[]>;
  sourceNames: Map<string, string>;
}

export const ExplorerDetail: React.FC<ExplorerDetailProps> = ({ run, pairRuns, nodes, devicesByProtocol, sourceNames }) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat, distanceUnit, nodeHopsCalculation } = useSettings();
  const [historyOpen, setHistoryOpen] = useState(false);

  const shaped = useMemo(() => {
    if (!run) return null;
    return withHashPlaceholders(run, devicesByProtocol[run.protocol], (hash, candidates) =>
      candidates > 1
        ? t('analysis.traceroute_explorer.unresolved_hash_many', 'Unresolved hash {{hash}} ({{count}} matches)', { hash, count: candidates })
        : t('analysis.traceroute_explorer.unresolved_hash', 'Unresolved hash {{hash}}', { hash }),
    );
  }, [run, devicesByProtocol, t]);
  const devices = shaped?.devices ?? NO_DEVICES;

  const strip = useMemo(() => {
    if (!run || !shaped) return null;
    const graph = buildTracerouteStripGraph(shaped.wire);
    if (graph.isEmpty) return null;
    const meta = buildStripNodeMeta(graph, devices, {
      hopsCalculation: nodeHopsCalculation,
      traceroutes: [],
      currentNodeNum: null,
    });
    return { graph, meta };
  }, [run, shaped, devices, nodeHopsCalculation]);

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
          {nodeLongLabel(nodes, run.fromKey)}
          <UiIcon name="forward" size={16} className={styles.titleArrow} />
          {nodeLongLabel(nodes, run.toKey)}
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
        {run.protocol === 'meshcore' && run.answered && !run.reachedTarget && run.turnaroundKey && (
          <p className={styles.muted} data-testid="explorer-turnaround-note">
            {t('analysis.traceroute_explorer.turnaround_note', 'Turned at {{turnaround}}; {{target}} does not forward traces', {
              turnaround: nodeLongLabel(nodes, run.turnaroundKey),
              target: nodeLongLabel(nodes, run.toKey),
            })}
          </p>
        )}
        <div className={styles.detailActions}>
          {run.protocol === 'meshtastic' && (
            <button type="button" className="reports-btn reports-btn--ghost" onClick={() => setHistoryOpen(true)}>
              {t('analysis.traceroute_explorer.pair_history', 'Pair history')}
            </button>
          )}
          {run.answered && (
            <TracerouteCopyLinks
              route={shaped!.wire.route}
              routeBack={shaped!.wire.routeBack}
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
      {historyOpen && run.protocol === 'meshtastic' && (
        <TracerouteHistoryModal
          fromNodeNum={run.fromNodeNum}
          toNodeNum={run.toNodeNum}
          fromNodeName={nodeLongLabel(nodes, run.fromKey)}
          toNodeName={nodeLongLabel(nodes, run.toKey)}
          nodes={devices}
          sourceId={run.sourceIds[0]}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
};

export default ExplorerDetail;
