import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../hooks/useDashboardData';
import { useHopCounts } from '../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from './nodePositionUtil';

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  longName?: string | null;
  shortName?: string | null;
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
  const sourceList = sources as Array<{ id: string; name: string }>;
  const sourceIds =
    config.sources.length === 0
      ? sourceList.map((s) => s.id)
      : config.sources;
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);
  const hop = useHopCounts({ enabled: true, sources: sourceIds });

  if (!config.inspectorOpen) return null;

  if (!selected) {
    return (
      <aside className="map-analysis-inspector">
        <div className="empty">Click a node, route segment, neighbor link, or trail</div>
      </aside>
    );
  }

  const formatTime = (ms: number | undefined): string => {
    if (!ms) return '—';
    return new Date(ms).toLocaleString();
  };

  const sourceName = (id: string | undefined): string => {
    if (!id) return '—';
    return sourceList.find((s) => s.id === id)?.name ?? id;
  };

  const nodeName = (n: NodeRecord | undefined, fallbackNum: number): string => {
    if (n?.longName) return n.longName;
    if (n?.shortName) return n.shortName;
    return `!${fallbackNum.toString(16)}`;
  };

  const findNode = (nodeNum: number, sourceId: string | undefined): NodeRecord | undefined => {
    return ((nodes ?? []) as NodeRecord[]).find(
      (n) =>
        Number(n.nodeNum) === nodeNum &&
        (sourceId === undefined || n.sourceId === sourceId),
    );
  };

  if (selected.type === 'node') {
    const node = findNode(selected.nodeNum ?? 0, selected.sourceId);
    if (!node) {
      return (
        <aside className="map-analysis-inspector">
          <div className="empty">Node not found</div>
        </aside>
      );
    }
    const entries = ((hop.data as { entries?: HopEntry[] } | undefined)?.entries ?? []);
    const hops = entries.find(
      (e) =>
        e.sourceId === selected.sourceId &&
        Number(e.nodeNum) === selected.nodeNum,
    )?.hops;
    const hex = (selected.nodeNum ?? 0).toString(16);
    const ll = resolveNodeLatLng(node);
    return (
      <aside className="map-analysis-inspector">
        <h3>{nodeName(node, selected.nodeNum ?? 0)}</h3>
        <div className="subtitle">!{hex} · {selected.nodeNum}</div>
        <hr />
        <dl>
          {node.shortName && (
            <>
              <dt>Short</dt>
              <dd>{node.shortName}</dd>
            </>
          )}
          <dt>Source</dt>
          <dd>{sourceName(node.sourceId)}</dd>
          <dt>Hops</dt>
          <dd>{hops ?? '—'}</dd>
          <dt>Position</dt>
          <dd>{ll ? `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}` : '—'}</dd>
        </dl>
      </aside>
    );
  }

  if (selected.type === 'neighbor') {
    const fromNode = findNode(selected.nodeNum ?? 0, selected.sourceId);
    const toNode = findNode(selected.neighborNum ?? 0, selected.sourceId);
    const fromName = nodeName(fromNode, selected.nodeNum ?? 0);
    const toName = nodeName(toNode, selected.neighborNum ?? 0);
    const snr = selected.snr;
    return (
      <aside className="map-analysis-inspector">
        <h3>Neighbor Link</h3>
        <div className="subtitle">
          !{(selected.nodeNum ?? 0).toString(16)} ↔ !{(selected.neighborNum ?? 0).toString(16)}
        </div>
        <hr />
        <dl>
          <dt>Node</dt>
          <dd>{fromName}</dd>
          <dt>Neighbor</dt>
          <dd>{toName}</dd>
          <dt>Source</dt>
          <dd>{sourceName(selected.sourceId)}</dd>
          <dt>SNR</dt>
          <dd>{snr === null || snr === undefined ? '—' : `${snr.toFixed(2)} dB`}</dd>
          <dt>Reported</dt>
          <dd>{formatTime(selected.timestamp)}</dd>
        </dl>
      </aside>
    );
  }

  if (selected.type === 'trail') {
    const node = findNode(selected.nodeNum ?? 0, selected.sourceId);
    const name = nodeName(node, selected.nodeNum ?? 0);
    const durationMs =
      selected.endMs !== undefined && selected.startMs !== undefined
        ? selected.endMs - selected.startMs
        : undefined;
    const durationStr =
      durationMs === undefined
        ? '—'
        : durationMs < 60_000
          ? `${Math.round(durationMs / 1000)}s`
          : durationMs < 3_600_000
            ? `${Math.round(durationMs / 60_000)}m`
            : `${(durationMs / 3_600_000).toFixed(1)}h`;
    return (
      <aside className="map-analysis-inspector">
        <h3>Position Trail</h3>
        <div className="subtitle">
          !{(selected.nodeNum ?? 0).toString(16)} · {selected.nodeNum}
        </div>
        <hr />
        <dl>
          <dt>Node</dt>
          <dd>{name}</dd>
          <dt>Source</dt>
          <dd>{sourceName(selected.sourceId)}</dd>
          <dt>Points</dt>
          <dd>{selected.pointCount ?? '—'}</dd>
          <dt>Start</dt>
          <dd>{formatTime(selected.startMs)}</dd>
          <dt>End</dt>
          <dd>{formatTime(selected.endMs)}</dd>
          <dt>Duration</dt>
          <dd>{durationStr}</dd>
        </dl>
      </aside>
    );
  }

  // segment
  const fromNode = findNode(selected.fromNodeNum ?? 0, undefined);
  const toNode = findNode(selected.toNodeNum ?? 0, undefined);
  const fromName = nodeName(fromNode, selected.fromNodeNum ?? 0);
  const toName = nodeName(toNode, selected.toNodeNum ?? 0);
  return (
    <aside className="map-analysis-inspector">
      <h3>Route Segment</h3>
      <div className="subtitle">
        !{(selected.fromNodeNum ?? 0).toString(16)} → !{(selected.toNodeNum ?? 0).toString(16)}
      </div>
      <hr />
      <dl>
        <dt>From</dt>
        <dd>{fromName}</dd>
        <dt>To</dt>
        <dd>{toName}</dd>
      </dl>
    </aside>
  );
}
