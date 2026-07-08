import { createContext, useContext, useState, ReactNode } from 'react';
import { useMapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';

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
};

const Ctx = createContext<CtxShape | null>(null);

export function MapAnalysisProvider({ children }: { children: ReactNode }) {
  const config = useMapAnalysisConfig();
  const [selected, setSelected] = useState<SelectedTarget | null>(null);
  const [nodeFilter, setNodeFilter] = useState('');
  const [followPaused, setFollowPaused] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
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
