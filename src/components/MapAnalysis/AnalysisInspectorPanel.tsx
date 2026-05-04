import type { ReactNode } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../hooks/useDashboardData';
import { useHopCounts } from '../../hooks/useMapAnalysisData';
import { useLinkQuality } from '../../hooks/useLinkQuality';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from './nodePositionUtil';

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  nodeId?: string;
  sourceId?: string;
  longName?: string | null;
  shortName?: string | null;
  snr?: number | null;
  rssi?: number | null;
  lastHeard?: number | null;
  // Flat fields as returned by /api/sources/:id/nodes
  batteryLevel?: number | null;
  voltage?: number | null;
  channelUtilization?: number | null;
  airUtilTx?: number | null;
  uptimeSeconds?: number | null;
  // Nested fallback (DeviceInfo shape used by some hooks/mocks)
  deviceMetrics?: {
    batteryLevel?: number | null;
    voltage?: number | null;
    channelUtilization?: number | null;
    airUtilTx?: number | null;
    uptimeSeconds?: number | null;
  } | null;
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
  const { config, selected, setInspectorOpen } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();
  const sourceList = sources as Array<{ id: string; name: string }>;
  const sourceIds =
    config.sources.length === 0
      ? sourceList.map((s) => s.id)
      : config.sources;
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);
  const hop = useHopCounts({ enabled: true, sources: sourceIds });

  const findNode = (nodeNum: number, sourceId: string | undefined): NodeRecord | undefined => {
    return ((nodes ?? []) as NodeRecord[]).find(
      (n) =>
        Number(n.nodeNum) === nodeNum &&
        (sourceId === undefined || n.sourceId === sourceId),
    );
  };

  const selectedNode =
    selected?.type === 'node'
      ? findNode(selected.nodeNum ?? 0, selected.sourceId)
      : undefined;
  const selectedNodeId =
    selectedNode?.nodeId ??
    (selected?.type === 'node' && selected.nodeNum !== undefined
      ? `!${selected.nodeNum.toString(16)}`
      : '');
  const linkQualityQuery = useLinkQuality({
    nodeId: selectedNodeId,
    hours: 24,
    enabled: selected?.type === 'node' && !!selectedNodeId,
  });

  if (!config.inspectorOpen) {
    return (
      <button
        type="button"
        className="map-analysis-inspector-expand"
        aria-label="Expand detail pane"
        onClick={() => setInspectorOpen(true)}
      >
        ‹
      </button>
    );
  }

  const wrap = (body: ReactNode) => (
    <aside className="map-analysis-inspector">
      <button
        type="button"
        className="map-analysis-inspector-close"
        aria-label="Collapse detail pane"
        onClick={() => setInspectorOpen(false)}
      >
        ›
      </button>
      {body}
    </aside>
  );

  if (!selected) {
    return wrap(
      <div className="empty">Click a node, route segment, neighbor link, or trail</div>,
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

  const formatUptime = (s: number | null | undefined): string => {
    if (s === null || s === undefined || !Number.isFinite(s) || s < 0) return '—';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  };

  const formatBattery = (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    if (v === 101) return 'Powered';
    return `${Math.round(v)}%`;
  };

  const formatNumber = (v: number | null | undefined, suffix: string, digits = 2): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return `${v.toFixed(digits)}${suffix}`;
  };

  const formatLinkQuality = (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return `${v.toFixed(1)}/10`;
  };

  if (selected.type === 'node') {
    const node = selectedNode;
    if (!node) {
      return wrap(<div className="empty">Node not found</div>);
    }
    const entries = ((hop.data as { entries?: HopEntry[] } | undefined)?.entries ?? []);
    const hops = entries.find(
      (e) =>
        e.sourceId === selected.sourceId &&
        Number(e.nodeNum) === selected.nodeNum,
    )?.hops;
    const hex = (selected.nodeNum ?? 0).toString(16);
    const ll = resolveNodeLatLng(node);
    const dm = node.deviceMetrics ?? {};
    const battery = node.batteryLevel ?? dm.batteryLevel;
    const voltage = node.voltage ?? dm.voltage;
    const chUtil = node.channelUtilization ?? dm.channelUtilization;
    const airTx = node.airUtilTx ?? dm.airUtilTx;
    const uptime = node.uptimeSeconds ?? dm.uptimeSeconds;
    const lqList = linkQualityQuery.data ?? [];
    const latestLq = lqList.length > 0 ? lqList[lqList.length - 1].quality : undefined;
    return wrap(
      <>
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
          <dt>Last Heard</dt>
          <dd>{node.lastHeard ? formatTime(node.lastHeard * 1000) : '—'}</dd>
        </dl>
        <hr />
        <dl>
          <dt>Battery</dt>
          <dd>{formatBattery(battery)}</dd>
          <dt>Voltage</dt>
          <dd>{formatNumber(voltage, ' V', 2)}</dd>
          <dt>Uptime</dt>
          <dd>{formatUptime(uptime)}</dd>
          <dt>Air Util Tx</dt>
          <dd>{formatNumber(airTx, '%', 2)}</dd>
          <dt>Ch Util</dt>
          <dd>{formatNumber(chUtil, '%', 2)}</dd>
          <dt>Link Q</dt>
          <dd>{formatLinkQuality(latestLq)}</dd>
          <dt>SNR</dt>
          <dd>{formatNumber(node.snr, ' dB', 2)}</dd>
        </dl>
      </>,
    );
  }

  if (selected.type === 'neighbor') {
    const fromNode = findNode(selected.nodeNum ?? 0, selected.sourceId);
    const toNode = findNode(selected.neighborNum ?? 0, selected.sourceId);
    const fromName = nodeName(fromNode, selected.nodeNum ?? 0);
    const toName = nodeName(toNode, selected.neighborNum ?? 0);
    const snr = selected.snr;
    return wrap(
      <>
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
      </>,
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
    return wrap(
      <>
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
      </>,
    );
  }

  // segment
  const fromNode = findNode(selected.fromNodeNum ?? 0, undefined);
  const toNode = findNode(selected.toNodeNum ?? 0, undefined);
  const fromName = nodeName(fromNode, selected.fromNodeNum ?? 0);
  const toName = nodeName(toNode, selected.toNodeNum ?? 0);
  return wrap(
    <>
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
    </>,
  );
}
