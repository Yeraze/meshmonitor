import React from 'react';
import type { WidgetRange } from '../hooks/useWidgetRange';

interface TelemetryGaugeProps {
  value: number;
  min: number;
  max: number;
  unit: string;
  color: string;
  timestamp: number;
  nodeId: string;
  onRangeChange: (range: WidgetRange) => void;
  canEditRange?: boolean;
  /**
   * Optional display formatter for the value and min/max labels (e.g.
   * formatDuration for uptime-in-seconds metrics, #3261). The range inputs
   * keep raw numbers so editing still works.
   */
  formatValue?: (value: number) => string;
}

const SWEEP_DEG = 200;
const START_DEG = 360 - SWEEP_DEG / 2; // 260 degrees — arc centered at top (12 o'clock), gap opens at bottom

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

const TelemetryGauge: React.FC<TelemetryGaugeProps> = ({
  value,
  min,
  max,
  unit,
  color,
  timestamp,
  onRangeChange,
  canEditRange = false,
  formatValue,
}) => {
  const cx = 100;
  const cy = 90;
  const r = 70;

  const clampedFraction = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
  const valueAngle = START_DEG + clampedFraction * SWEEP_DEG;
  const endAngle = START_DEG + SWEEP_DEG;

  const bgPath = arcPath(cx, cy, r, START_DEG, endAngle);
  const valuePath = clampedFraction > 0 ? arcPath(cx, cy, r, START_DEG, valueAngle) : null;

  const minLabel = polarToCartesian(cx, cy, r + 14, START_DEG);
  const maxLabel = polarToCartesian(cx, cy, r + 14, endAngle);

  const date = new Date(timestamp);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const displayValue = formatValue
    ? formatValue(value)
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(1);
  const displayMin = formatValue ? formatValue(min) : String(min);
  const displayMax = formatValue ? formatValue(max) : String(max);

  const handleMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) onRangeChange({ min: v, max });
  };

  const handleMaxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) onRangeChange({ min, max: v });
  };

  return (
    <div className="telemetry-gauge">
      <svg viewBox="0 0 200 160" width="100%" aria-label={`Gauge: ${displayValue}${unit ? ` ${unit}` : ''}`}>
        {/* Background arc */}
        <path d={bgPath} fill="none" stroke="var(--ctp-surface0)" strokeWidth={14} strokeLinecap="round" />
        {/* Value arc */}
        {valuePath && (
          <path d={valuePath} fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" />
        )}
        {/* Min label */}
        <text
          x={minLabel.x}
          y={minLabel.y}
          textAnchor="middle"
          fontSize="9"
          fill="var(--ctp-subtext0)"
        >
          {displayMin}
        </text>
        {/* Max label */}
        <text
          x={maxLabel.x}
          y={maxLabel.y}
          textAnchor="middle"
          fontSize="9"
          fill="var(--ctp-subtext0)"
        >
          {displayMax}
        </text>
        {/* Value */}
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="26" fontWeight="bold" fill="var(--ctp-text)">
          {displayValue}
        </text>
        {/* Unit */}
        <text x={cx} y={cy + 18} textAnchor="middle" fontSize="11" fill="var(--ctp-subtext0)">
          {unit}
        </text>
        {/* Timestamp */}
        <text x={cx} y={148} textAnchor="middle" fontSize="9" fontStyle="italic" fill="var(--ctp-subtext0)">
          {timeStr}
        </text>
      </svg>
      {canEditRange && (
        <div className="gauge-range-row">
          <input
            type="number"
            className="gauge-range-input"
            value={min}
            onChange={handleMinChange}
            aria-label="Gauge minimum"
          />
          <span className="gauge-range-dash">───</span>
          <input
            type="number"
            className="gauge-range-input"
            value={max}
            onChange={handleMaxChange}
            aria-label="Gauge maximum"
          />
        </div>
      )}
    </div>
  );
};

export default TelemetryGauge;
