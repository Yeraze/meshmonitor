import { useState } from 'react';

export interface WidgetRange {
  min: number;
  max: number;
}

export const DEFAULT_GAUGE_RANGES: Record<string, WidgetRange> = {
  batteryLevel: { min: 0, max: 100 },
  temperature: { min: -20, max: 50 },
  humidity: { min: 0, max: 100 },
  voltage: { min: 0, max: 5 },
  pressure: { min: 950, max: 1050 },
};

const DEFAULT_RANGE: WidgetRange = { min: 0, max: 100 };

export function useWidgetRange(nodeId: string, type: string): [WidgetRange, (r: WidgetRange) => void] {
  const key = `telemetry_widget_range_${nodeId}_${type}`;
  const [range, setRangeState] = useState<WidgetRange>(() => {
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        return JSON.parse(stored) as WidgetRange;
      } catch {
        // fall through to default
      }
    }
    return DEFAULT_GAUGE_RANGES[type] ?? DEFAULT_RANGE;
  });

  const setRange = (r: WidgetRange) => {
    localStorage.setItem(key, JSON.stringify(r));
    setRangeState(r);
  };

  return [range, setRange];
}
