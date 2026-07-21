import { useMemo, type ReactNode } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../hooks/useDashboardData';
import { useHopCounts, useTraceroutes } from '../../hooks/useMapAnalysisData';
import { useLinkQuality } from '../../hooks/useLinkQuality';
import {
  useTracerouteAnalysis,
  type TracerouteAnalysisInput,
} from '../../hooks/useTracerouteAnalysis';
import { getTracerouteOptions } from '../../hooks/useMapAnalysisConfig';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from './nodePositionUtil';
import { useSettings } from '../../contexts/SettingsContext';
import { useElevationEnabled } from '../../hooks/useElevationEnabled';
import { useElevationProfile } from '../../hooks/useElevationProfile';
import { calculateDistance, formatDistance } from '../../utils/distance';
import {
  resolveNeighborEndpoints,
  resolveSegmentEndpoints,
  type EndpointNodeRecord,
} from './neighborLinkEndpoints';
import { UiIcon } from '../icons';

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
  hideFromMap?: boolean | null;
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
  const {
    config,
    selected,
    setInspectorOpen,
    setLinkEndpoints,
    setLinkProfileMode,
    setMeasureMode,
    setViewMode,
  } = useMapAnalysisCtx();
  const { distanceUnit } = useSettings();
  const elevationEnabled = useElevationEnabled();
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

  // Per-node traceroute summary (issue #3399). Shares the React Query cache with
  // the traceroute layer when the same source/lookback args are in use.
  const tracerouteOptions = useMemo(
    () => getTracerouteOptions(config),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.layers.traceroutes.options],
  );
  const isNodeSelected = selected?.type === 'node' && selected.nodeNum !== undefined;
  const { items: tracerouteItems } = useTraceroutes({
    enabled: isNodeSelected && sourceIds.length > 0,
    sources: sourceIds,
    lookbackHours: config.layers.traceroutes.lookbackHours ?? 24,
  });
  const positionByKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      // #4162/#3549: exclude "Hide from Map" nodes so the traceroute summary
      // (distinct links / observations) counts only marker-visible neighbours,
      // matching the rendered map.
      if (n.hideFromMap) continue;
      const ll = resolveNodeLatLng(n);
      if (ll) map.set(`${n.sourceId ?? ''}:${Number(n.nodeNum)}`, ll);
    }
    return map;
  }, [nodes]);
  const { summary: tracerouteSummary } = useTracerouteAnalysis({
    traceroutes: tracerouteItems as TracerouteAnalysisInput[],
    positionByKey,
    selectedNodeNum: isNodeSelected ? selected!.nodeNum! : null,
    selectedSourceId: isNodeSelected ? selected!.sourceId ?? null : null,
    options: tracerouteOptions,
    visibleNodeNums: null,
    timeWindow: null,
  });

  // Link terrain integration (epic #3826 Phase 1 for neighbor links; extended
  // to traceroute route segments). Resolved unconditionally (top-level hook,
  // before the early returns) — the memo itself returns null for other
  // selection types.
  const neighborEndpoints = useMemo(() => {
    if (selected?.type === 'neighbor') {
      return resolveNeighborEndpoints(selected, (nodes ?? []) as EndpointNodeRecord[]);
    }
    if (selected?.type === 'segment') {
      return resolveSegmentEndpoints(selected, (nodes ?? []) as EndpointNodeRecord[]);
    }
    return null;
  }, [selected, nodes]);
  // Same query key as LinkProfileDrawer's useElevationProfile call ⇒ shared
  // cache (§2.1 of the spec). Disabled (undefined endpoints) unless elevation
  // is enabled AND both endpoints resolved, so browsing with elevation off or
  // over unpositioned links issues no elevation requests at all.
  const profileEndpointA = elevationEnabled ? neighborEndpoints?.a : undefined;
  const profileEndpointB = elevationEnabled ? neighborEndpoints?.b : undefined;
  const { data: neighborProfile, isLoading: neighborElevLoading } =
    useElevationProfile(profileEndpointA, profileEndpointB);

  if (!config.inspectorOpen) {
    return (
      <button
        type="button"
        className="map-analysis-inspector-expand"
        aria-label="Expand detail pane"
        onClick={() => setInspectorOpen(true)}
      >
        <UiIcon name="back" />
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
        <UiIcon name="forward" />
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

  const formatElevation = (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return `${Math.round(v)} m`;
  };

  // Shared terrain block for link-shaped selections (neighbor links and
  // traceroute route segments — epic #3826 Phase 1, extended to segments):
  // distance is shown whenever both endpoints resolve to a position; endpoint
  // elevations + the "View terrain profile" action are additionally gated on
  // `elevationEnabled`, mirroring the toolbar's Link Profile button.
  const terrainDistKm = neighborEndpoints
    ? calculateDistance(
        neighborEndpoints.a.lat,
        neighborEndpoints.a.lng,
        neighborEndpoints.b.lat,
        neighborEndpoints.b.lng,
      )
    : null;
  const terrainSamples = neighborProfile?.samples;
  const terrainElevA =
    terrainSamples && terrainSamples.length > 0 ? terrainSamples[0].elevation : undefined;
  const terrainElevB =
    terrainSamples && terrainSamples.length > 0
      ? terrainSamples[terrainSamples.length - 1].elevation
      : undefined;
  const terrainRows = (labelA: string, labelB: string) => (
    <>
      {neighborEndpoints && (
        <>
          <dt>Distance</dt>
          <dd>{terrainDistKm !== null ? formatDistance(terrainDistKm, distanceUnit) : '—'}</dd>
        </>
      )}
      {elevationEnabled && neighborEndpoints && (
        <>
          <dt>{labelA}</dt>
          <dd>{neighborElevLoading ? '…' : formatElevation(terrainElevA)}</dd>
          <dt>{labelB}</dt>
          <dd>{neighborElevLoading ? '…' : formatElevation(terrainElevB)}</dd>
        </>
      )}
    </>
  );
  const terrainAction =
    elevationEnabled && neighborEndpoints ? (
      <button
        type="button"
        className="map-analysis-link-profile-action"
        onClick={() => {
          // #3826 Phase 3 §2.5: triggering the profile action while in 3D
          // auto-switches to 2D, where the drawer + on-map verdict
          // polyline/endpoint rings actually render.
          if (config.viewMode === '3d') setViewMode('2d');
          setMeasureMode(false);
          setLinkEndpoints([neighborEndpoints.a, neighborEndpoints.b]);
          setLinkProfileMode(true);
        }}
      >
        View terrain profile
      </button>
    ) : null;

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
        {tracerouteSummary && tracerouteSummary.distinctLinks > 0 && (
          <>
            <hr />
            <div className="map-analysis-tr-summary-title">Traceroute Links</div>
            <dl>
              <dt>Distinct Links</dt>
              <dd>{tracerouteSummary.distinctLinks}</dd>
              <dt>Outbound</dt>
              <dd>{tracerouteSummary.outboundLinks}</dd>
              <dt>Inbound</dt>
              <dd>{tracerouteSummary.inboundLinks}</dd>
              <dt>Observations</dt>
              <dd>{tracerouteSummary.totalObservations}</dd>
              <dt>Avg SNR</dt>
              <dd>{formatNumber(tracerouteSummary.avgSnr, ' dB', 1)}</dd>
            </dl>
          </>
        )}
      </>,
    );
  }

  if (selected.type === 'neighbor') {
    const isMeshCore = !!selected.publicKey;
    const fromName = isMeshCore
      ? (selected.nodeName ?? selected.publicKey?.substring(0, 12) ?? '?')
      : nodeName(findNode(selected.nodeNum ?? 0, selected.sourceId), selected.nodeNum ?? 0);
    const toName = isMeshCore
      ? (selected.neighborName ?? selected.neighborPublicKey?.substring(0, 12) ?? '?')
      : nodeName(findNode(selected.neighborNum ?? 0, selected.sourceId), selected.neighborNum ?? 0);
    const subtitle = isMeshCore
      ? `${selected.publicKey?.substring(0, 8) ?? ''} ↔ ${selected.neighborPublicKey?.substring(0, 8) ?? ''}`
      : `!${(selected.nodeNum ?? 0).toString(16)} ↔ !${(selected.neighborNum ?? 0).toString(16)}`;
    const snr = selected.snr;
    return wrap(
      <>
        <h3>Neighbor Link</h3>
        <div className="subtitle">{subtitle}</div>
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
          {terrainRows('Node Elevation', 'Neighbor Elevation')}
        </dl>
        {terrainAction}
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
        !{(selected.fromNodeNum ?? 0).toString(16)} <UiIcon name="forward" size={14} /> !{(selected.toNodeNum ?? 0).toString(16)}
      </div>
      <hr />
      <dl>
        <dt>From (TX)</dt>
        <dd>{fromName}</dd>
        <dt>To (RX)</dt>
        <dd>{toName}</dd>
        {selected.direction && selected.direction !== 'neutral' && (
          <>
            <dt>Direction</dt>
            <dd>{selected.direction === 'outbound' ? 'Outbound (TX)' : 'Inbound (RX)'}</dd>
          </>
        )}
        {selected.occurrences !== undefined && (
          <>
            <dt>Observations</dt>
            <dd>{selected.occurrences}</dd>
          </>
        )}
        {selected.avgSnr !== undefined && (
          <>
            <dt>Avg SNR</dt>
            <dd>{selected.avgSnr === null ? '— (unknown)' : `${selected.avgSnr.toFixed(1)} dB`}</dd>
          </>
        )}
        {terrainRows('From Elevation', 'To Elevation')}
      </dl>
      {terrainAction}
    </>,
  );
}
