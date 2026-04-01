import { useState } from 'react';

export type WidgetMode = 'chart' | 'gauge' | 'numeric';

export function useWidgetMode(nodeId: string, type: string): [WidgetMode, (m: WidgetMode) => void] {
  const key = `telemetry_widget_mode_${nodeId}_${type}`;
  const [mode, setModeState] = useState<WidgetMode>(
    () => (localStorage.getItem(key) as WidgetMode | null) ?? 'chart'
  );
  const setMode = (m: WidgetMode) => {
    localStorage.setItem(key, m);
    setModeState(m);
  };
  return [mode, setMode];
}
