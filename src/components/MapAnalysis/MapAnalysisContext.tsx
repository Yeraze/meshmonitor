import { createContext, useContext, useRef, useState, ReactNode, type RefObject } from 'react';
import { useMapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';
import type { LinkEndpoint, LinkVerdict } from '../../utils/linkProfile';
import type { SitePlannerOrigin } from './SitePlannerOriginController';
import type { PredictedCoverage } from '../map/layers/predictedCoverageGeometry';
import type { GnssDopMeta, GnssDopUiParams } from '../map/layers/gnssDopGeometry';
import type { LatLng } from './followMath';

export interface SelectedTarget {
  type: 'node' | 'segment' | 'neighbor' | 'trail';
  nodeNum?: number;
  sourceId?: string;
  fromNodeNum?: number;
  toNodeNum?: number;
  // neighbor-specific
  neighborNum?: number;
  snr?: number | null;
  timestamp?: number;
  // MeshCore neighbor-specific
  publicKey?: string;
  neighborPublicKey?: string;
  nodeName?: string | null;
  neighborName?: string | null;
  // trail-specific
  pointCount?: number;
  startMs?: number;
  endMs?: number;
  // route-segment extras (issue #3399)
  direction?: 'inbound' | 'outbound' | 'neutral';
  occurrences?: number;
  avgSnr?: number | null;
}

/**
 * `CtxShape` inherits `config.viewMode` / `setViewMode` (2D vs 3D map
 * rendering on Map Analysis, #3826 Phase 2) automatically via
 * `ReturnType<typeof useMapAnalysisConfig>` below, the same way
 * `config.followMode` / `setFollowMode` already do — no extra field needed
 * here; the `...config` spread in `MapAnalysisProvider` carries it through.
 */
type CtxShape = ReturnType<typeof useMapAnalysisConfig> & {
  selected: SelectedTarget | null;
  setSelected: (s: SelectedTarget | null) => void;
  /** Free-text node search term; empty = no filter (issue #3399). */
  nodeFilter: string;
  setNodeFilter: (s: string) => void;
  /** Follow/Auto-zoom paused by a manual pan/zoom; cleared by Resume or retargeting (issue #3788 P2). */
  followPaused: boolean;
  setFollowPaused: (p: boolean) => void;
  /** Node-to-node LOS distance measurement tool active (issue #3636); transient, not persisted. */
  measureMode: boolean;
  setMeasureMode: (m: boolean) => void;
  /**
   * Terrain Link Profile two-point picker active (#4111 Phase 2); transient,
   * not persisted. Mutually exclusive with `measureMode` — enforced by the
   * toolbar's button handlers, not here (see `MapAnalysisToolbar.tsx`).
   */
  linkProfileMode: boolean;
  /** Site Planner (#4727): origin-pick mode, chosen origin, and the last result. */
  sitePlannerMode: boolean;
  setSitePlannerMode: (v: boolean) => void;
  sitePlannerOrigin: SitePlannerOrigin | null;
  setSitePlannerOrigin: (v: SitePlannerOrigin | null) => void;
  predictedCoverage: PredictedCoverage | null;
  setPredictedCoverage: (v: PredictedCoverage | null) => void;
  /**
   * GNSS DOP overlay (#4729): on/off mode, the user-set params (elevation mask,
   * time, constellations), and the last fetch's meta (clamp/loading/error) that
   * the layer reports up for the panel's legend + "resolution reduced" notice.
   * Off by default and mutually exclusive with the other click-capturing tools
   * only insofar as it needs no map clicks — it is a passive overlay, so it can
   * coexist, but the toolbar keeps it a simple toggle.
   */
  gnssDopMode: boolean;
  setGnssDopMode: (v: boolean) => void;
  gnssDopParams: GnssDopUiParams;
  setGnssDopParams: (v: GnssDopUiParams) => void;
  gnssDopMeta: GnssDopMeta | null;
  setGnssDopMeta: (v: GnssDopMeta | null) => void;
  setLinkProfileMode: (m: boolean) => void;
  /** Picked endpoints (0..2) for the Link Profile tool; transient, not persisted. */
  linkEndpoints: LinkEndpoint[];
  setLinkEndpoints: (e: LinkEndpoint[]) => void;
  /**
   * Computed verdict for the current Link Profile analysis (#4111 Phase 3
   * WP-3); written by `LinkProfileDrawer` once `analyzeLinkProfile` resolves
   * and cleared when the drawer unmounts/endpoints reset. Read by the Canvas
   * to color the map-path Polyline drawn by `LinkProfileController`.
   */
  linkVerdict: LinkVerdict | null;
  setLinkVerdict: (v: LinkVerdict | null) => void;
  /**
   * Geographic point under the cursor on the Link Profile elevation graph
   * (#4111 follow-up). `LinkProfileDrawer` sets it on chart mousemove (from the
   * hovered sample's lat/lng) and clears it on mouseleave / reset; the Canvas
   * renders a marker there via `LinkProfileHoverLayer` so the graph cursor maps
   * to a spot on the terrain.
   */
  hoverPoint: { lat: number; lng: number } | null;
  setHoverPoint: (p: { lat: number; lng: number } | null) => void;
  /** Bounding box of trails for selected/followed nodes; consumed by FollowController to include trails in autozoom. */
  trailBounds: [LatLng, LatLng] | null;
  setTrailBounds: (b: [LatLng, LatLng] | null) => void;
  /**
   * Live camera state of the mounted map, republished on every `moveend` by
   * `MapViewStateController` (2D) / `Base3DMap`'s `onViewChange` (3D), and
   * read once at mount by whichever branch takes over (#4371 A).
   *
   * A **ref**, not state, on purpose: a pan fires `moveend` continuously, and
   * re-rendering every context consumer (all map layers) on each one would be
   * a real cost for a value nothing renders from. `null` until a map has
   * mounted and reported, in which case the caller falls back to the Default
   * Map Center.
   */
  mapViewRef: RefObject<MapViewState | null>;
};

/**
 * Live camera state of whichever map surface is currently mounted (#4371 A).
 * Shared between the 2D (Leaflet) and 3D (MapLibre) branches so switching
 * view modes keeps the view the user is looking at instead of snapping back
 * to the Default Map Center. `pitch`/`bearing` are 3D-only and carried
 * through a 3D→2D→3D round-trip untouched (Leaflet has no equivalent).
 */
export interface MapViewState {
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
}

const Ctx = createContext<CtxShape | null>(null);

export function MapAnalysisProvider({ children }: { children: ReactNode }) {
  const config = useMapAnalysisConfig();
  const [selected, setSelected] = useState<SelectedTarget | null>(null);
  const [nodeFilter, setNodeFilter] = useState('');
  const [followPaused, setFollowPaused] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [linkProfileMode, setLinkProfileMode] = useState(false);
  const [sitePlannerMode, setSitePlannerMode] = useState(false);
  const [sitePlannerOrigin, setSitePlannerOrigin] = useState<SitePlannerOrigin | null>(null);
  const [predictedCoverage, setPredictedCoverage] = useState<PredictedCoverage | null>(null);
  const [gnssDopMode, setGnssDopMode] = useState(false);
  const [gnssDopParams, setGnssDopParams] = useState<GnssDopUiParams>(() => ({
    maskDeg: 5,
    timeMs: Date.now(),
    constellations: ['gps'],
  }));
  const [gnssDopMeta, setGnssDopMeta] = useState<GnssDopMeta | null>(null);
  const [linkEndpoints, setLinkEndpoints] = useState<LinkEndpoint[]>([]);
  const [linkVerdict, setLinkVerdict] = useState<LinkVerdict | null>(null);
  const [hoverPoint, setHoverPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [trailBounds, setTrailBounds] = useState<[LatLng, LatLng] | null>(null);
  const mapViewRef = useRef<MapViewState | null>(null);
  return (
    <Ctx.Provider
      value={{
        ...config,
        selected,
        setSelected,
        nodeFilter,
        setNodeFilter,
        followPaused,
        setFollowPaused,
        measureMode,
        setMeasureMode,
        linkProfileMode,
        sitePlannerMode,
        setSitePlannerMode,
        sitePlannerOrigin,
        setSitePlannerOrigin,
        predictedCoverage,
        setPredictedCoverage,
        gnssDopMode,
        setGnssDopMode,
        gnssDopParams,
        setGnssDopParams,
        gnssDopMeta,
        setGnssDopMeta,
        setLinkProfileMode,
        linkEndpoints,
        setLinkEndpoints,
        linkVerdict,
        setLinkVerdict,
        hoverPoint,
        setHoverPoint,
        trailBounds,
        setTrailBounds,
        mapViewRef,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useMapAnalysisCtx() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMapAnalysisCtx must be used inside MapAnalysisProvider');
  return v;
}
