import { createContext, useContext, useState, ReactNode } from 'react';
import { useMapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';
import type { LinkEndpoint, LinkVerdict } from '../../utils/linkProfile';

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
};

const Ctx = createContext<CtxShape | null>(null);

export function MapAnalysisProvider({ children }: { children: ReactNode }) {
  const config = useMapAnalysisConfig();
  const [selected, setSelected] = useState<SelectedTarget | null>(null);
  const [nodeFilter, setNodeFilter] = useState('');
  const [followPaused, setFollowPaused] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [linkProfileMode, setLinkProfileMode] = useState(false);
  const [linkEndpoints, setLinkEndpoints] = useState<LinkEndpoint[]>([]);
  const [linkVerdict, setLinkVerdict] = useState<LinkVerdict | null>(null);
  const [hoverPoint, setHoverPoint] = useState<{ lat: number; lng: number } | null>(null);
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
        setLinkProfileMode,
        linkEndpoints,
        setLinkEndpoints,
        linkVerdict,
        setLinkVerdict,
        hoverPoint,
        setHoverPoint,
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
