import { useEffect, useState } from 'react';
import { useMapAnalysisCtx } from './MapAnalysisContext';

/**
 * Floating time-window slider that overlays the map. When enabled, drives the
 * `timeSlider.windowStartMs` / `windowEndMs` in MapAnalysisContext so timed
 * layers can filter their already-loaded data client-side. Hidden when
 * `timeSlider.enabled` is false.
 */
export default function TimeSliderControl() {
  const { config, setTimeSlider } = useMapAnalysisCtx();
  const [start, setStart] = useState<number>(
    config.timeSlider.windowStartMs ?? Date.now() - 86_400_000,
  );
  const [end, setEnd] = useState<number>(
    config.timeSlider.windowEndMs ?? Date.now(),
  );

  useEffect(() => {
    setTimeSlider({ windowStartMs: start, windowEndMs: end });
    // intentionally not depending on setTimeSlider — referential stability via useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end]);

  if (!config.timeSlider.enabled) return null;

  const min = Date.now() - 30 * 86_400_000;
  const max = Date.now();

  return (
    <div className="map-analysis-time-slider" data-testid="time-slider">
      <div className="map-analysis-time-slider-label">
        Window: {new Date(start).toLocaleString()} → {new Date(end).toLocaleString()}
      </div>
      <input
        aria-label="Window start"
        type="range"
        min={min}
        max={max}
        value={start}
        onChange={(e) => setStart(Math.min(end, Number(e.target.value)))}
      />
      <input
        aria-label="Window end"
        type="range"
        min={min}
        max={max}
        value={end}
        onChange={(e) => setEnd(Math.max(start, Number(e.target.value)))}
      />
    </div>
  );
}
