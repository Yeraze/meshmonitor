import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../hooks/useDashboardData';
import { useHopCounts } from '../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from './MapAnalysisContext';

interface NodeRecord {
  nodeNum: number;
  sourceId?: string;
  longName?: string | null;
  shortName?: string | null;
  position?: { latitude?: number | null; longitude?: number | null } | null;
}

interface HopEntry {
  sourceId: string;
  nodeNum: number;
  hops: number;
}

/**
 * Right-side inspector. Shows node metadata (with hop count) when a node is
 * selected, segment endpoints when a route segment is selected, or an empty
 * placeholder otherwise. Hidden entirely when `inspectorOpen` is false.
 */
export default function AnalysisInspectorPanel() {
  const { config, selected } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);
  const hop = useHopCounts({ enabled: true, sources: sourceIds });

  if (!config.inspectorOpen) return null;

  if (!selected) {
    return (
      <aside className="map-analysis-inspector">
        <em>Click a node or route segment</em>
      </aside>
    );
  }

  if (selected.type === 'node') {
    const node = ((nodes ?? []) as NodeRecord[]).find(
      (n) =>
        Number(n.nodeNum) === selected.nodeNum &&
        n.sourceId === selected.sourceId,
    );
    if (!node) {
      return <aside className="map-analysis-inspector">Node not found</aside>;
    }
    const entries = ((hop.data as { entries?: HopEntry[] } | undefined)?.entries ?? []);
    const hops = entries.find(
      (e) =>
        e.sourceId === selected.sourceId &&
        Number(e.nodeNum) === selected.nodeNum,
    )?.hops;
    const hex = selected.nodeNum?.toString(16);
    return (
      <aside className="map-analysis-inspector">
        <h3>{node.longName ?? node.shortName ?? `!${hex}`}</h3>
        <dl>
          <dt>Node</dt>
          <dd>
            {selected.nodeNum} (!{hex})
          </dd>
          <dt>Source</dt>
          <dd>{node.sourceId}</dd>
          <dt>Hops</dt>
          <dd>{hops ?? '—'}</dd>
          <dt>Last position</dt>
          <dd>
            {node.position?.latitude?.toFixed(5)},{' '}
            {node.position?.longitude?.toFixed(5)}
          </dd>
        </dl>
      </aside>
    );
  }

  // segment
  return (
    <aside className="map-analysis-inspector">
      <h3>Route segment</h3>
      <div>
        {selected.fromNodeNum} → {selected.toNodeNum}
      </div>
    </aside>
  );
}
