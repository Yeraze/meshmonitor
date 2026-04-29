import { createContext, useContext, useState, ReactNode } from 'react';
import { useMapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';

export interface SelectedTarget {
  type: 'node' | 'segment';
  nodeNum?: number;
  sourceId?: string;
  fromNodeNum?: number;
  toNodeNum?: number;
}

type CtxShape = ReturnType<typeof useMapAnalysisConfig> & {
  selected: SelectedTarget | null;
  setSelected: (s: SelectedTarget | null) => void;
};

const Ctx = createContext<CtxShape | null>(null);

export function MapAnalysisProvider({ children }: { children: ReactNode }) {
  const config = useMapAnalysisConfig();
  const [selected, setSelected] = useState<SelectedTarget | null>(null);
  return <Ctx.Provider value={{ ...config, selected, setSelected }}>{children}</Ctx.Provider>;
}

export function useMapAnalysisCtx() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMapAnalysisCtx must be used inside MapAnalysisProvider');
  return v;
}
