import { useMemo } from 'react';
import { Base3DMap, type Node3DFeature, type Line3DFeature } from './Base3DMap';
import type { ReactNode } from 'react';
import type { Basemap3DSource } from '../../config/basemap3d';
import { use3DNeighborLines } from '../MapAnalysis/use3DNeighborLines';
import { use3DTracerouteLines } from '../MapAnalysis/use3DTracerouteLines';

export interface Map3DViewProps {
  /** Initial center, [lat, lng]. Mount-only (Base3DMap convention). */
  center: [number, number];
  /** Initial zoom. Mount-only. */
  zoom: number;
  /** Raster basemap source, from `resolve3DBasemap`. */
  basemap: Basemap3DSource;
  /** Same-origin DEM tile URL template, from `buildTerrainTileUrl`. */
  terrainTileUrl: string;
  /** Node markers to render. */
  nodes: Node3DFeature[];
  /**
   * Sources whose neighbor/traceroute edges to render — a single `[sourceId]`
   * for a per-source map, or every source id for a unified map. NOTE: an empty
   * array resolves to "all sources" (the generalized hooks' convention), so a
   * host with no source should instead gate `showNeighbors`/`showTraceroutes`
   * off to render nodes without any cross-source edges.
   */
  sourceIds: string[];
  /** Gate neighbor lines — mirrors the host's "Show Neighbors" toggle. */
  showNeighbors: boolean;
  /** Gate traceroute lines — mirrors the host's "Show Traceroute/Route" toggles. */
  showTraceroutes: boolean;
  /** Fetch lookback window in hours for the neighbor/traceroute data. */
  lookbackHours: number;
  /**
   * Visible node numbers (the host's rendered-marker set). When provided, the
   * neighbor/traceroute lines are gated so both endpoints are visible — 3D
   * lines then match the 2D map instead of dangling to nodes hidden by its
   * age/transport/estimated filters (#4808). Omit for MapAnalysis (all nodes).
   */
  visibleNodeNums?: Set<number>;
  /** Seed for the exaggeration slider (default `1.3`). */
  initialExaggeration?: number;
  /** Fired with the new exaggeration value whenever the slider changes. */
  onExaggerationChange?: (value: number) => void;
  /** WebGL unavailable — the host should switch back to its 2D map. */
  onUnsupported?: () => void;
  /** Fired with a node's `key` when its marker is clicked. */
  onNodeClick?: (key: string) => void;
  /** Render the popup body for a clicked node; portaled into a maplibre popup (#4808). */
  renderPopup?: (key: string) => ReactNode;
}

/**
 * Shared 3D map surface for the non-MapAnalysis maps (Dashboard Mesh Map,
 * Unified Map, classic `/nodes` map) — #4704. Wraps `Base3DMap` and feeds it
 * neighbor + traceroute lines from the generalized 3D data hooks, scoped to
 * the host's sources.
 *
 * v1 shows nodes + traceroute lines + neighbor lines only — no node filter, no
 * selection, no time window (static SNR coloring), matching the MapAnalysis 3D
 * non-goals. Mounted ONLY while its host is in 3D, so the data hooks (and their
 * fetches) never run in the 2D path.
 */
export function Map3DView({
  center,
  zoom,
  basemap,
  terrainTileUrl,
  nodes,
  sourceIds,
  showNeighbors,
  showTraceroutes,
  lookbackHours,
  visibleNodeNums,
  initialExaggeration,
  onExaggerationChange,
  onUnsupported,
  onNodeClick,
  renderPopup,
}: Map3DViewProps) {
  // Static coloring for v1: the time slider is always off, so the 3D hooks
  // fall back to SNR/direction coloring over the full lookback window.
  const timeSlider = useMemo(() => ({ enabled: false }), []);

  const neighborLines = use3DNeighborLines({
    layer: { enabled: showNeighbors, lookbackHours },
    sources: sourceIds,
    timeSlider,
    visibleNodeNums,
  });
  const tracerouteLines = use3DTracerouteLines({
    layer: { enabled: showTraceroutes, lookbackHours },
    sources: sourceIds,
    timeSlider,
    selected: null,
    nodeFilter: '',
    visibleNodeNums,
  });

  const lines: Line3DFeature[] = useMemo(
    () => [...neighborLines.lines, ...tracerouteLines.lines],
    [neighborLines.lines, tracerouteLines.lines],
  );

  return (
    <Base3DMap
      center={center}
      zoom={zoom}
      basemap={basemap}
      terrainTileUrl={terrainTileUrl}
      nodes={nodes}
      lines={lines}
      onNodeClick={onNodeClick}
      renderPopup={renderPopup}
      onUnsupported={onUnsupported}
      initialExaggeration={initialExaggeration}
      onExaggerationChange={onExaggerationChange}
    />
  );
}

export default Map3DView;
