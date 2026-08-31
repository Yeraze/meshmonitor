import { useEffect, useRef, useState } from 'react';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { UiIcon } from '../icons';

const LIVE_THRESHOLD_MS = 60_000;
const LIVE_TICK_MS = 10_000;

export default function TimeSliderControl() {
  const { config, setTimeSlider } = useMapAnalysisCtx();
  const [start, setStart] = useState<number>(
    config.timeSlider.windowStartMs ?? Date.now() - 86_400_000,
  );
  const [end, setEnd] = useState<number>(
    config.timeSlider.windowEndMs ?? Date.now(),
  );
  const liveRef = useRef(true);

  useEffect(() => {
    if (!liveRef.current) return;
    const id = setInterval(() => {
      setEnd(Date.now());
    }, LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [liveRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setTimeSlider({ windowStartMs: start, windowEndMs: end });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end]);

  if (!config.timeSlider.enabled) return null;

  const min = Date.now() - 30 * 86_400_000;
  const max = Date.now();

  return (
    <div className="map-analysis-time-slider" data-testid="time-slider">
      <div className="map-analysis-time-slider-label">
        Window: {new Date(start).toLocaleString()} <UiIcon name="forward" size={14} /> {new Date(end).toLocaleString()}
        {liveRef.current && <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.7 }}>(live)</span>}
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
        onChange={(e) => {
          const v = Math.max(start, Number(e.target.value));
          setEnd(v);
          liveRef.current = (max - v) < LIVE_THRESHOLD_MS;
        }}
      />
    </div>
  );
}
