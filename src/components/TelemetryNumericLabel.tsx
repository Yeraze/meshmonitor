import React from 'react';
import { formatInTimeZone } from '../utils/datetime';

interface TelemetryNumericLabelProps {
  value: number;
  unit: string;
  color: string;
  timestamp: number;
  /** Zone to show the time in (#6523); the browser's when absent. */
  timeZone?: string;
  /**
   * Optional display formatter for the raw value (e.g. formatDuration for
   * uptime-in-seconds metrics, #3261). Defaults to the numeric rendering.
   */
  formatValue?: (value: number) => string;
}

const TelemetryNumericLabel: React.FC<TelemetryNumericLabelProps> = ({ value, unit, color, timestamp, timeZone, formatValue }) => {
  const date = new Date(timestamp);
  const timeStr = timeZone
    ? formatInTimeZone(date, { hour: '2-digit', minute: '2-digit' }, timeZone)
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const displayValue = formatValue
    ? formatValue(value)
    : Number.isInteger(value)
      ? value.toString()
      : value.toFixed(2);

  return (
    <div className="telemetry-numeric" aria-label={`${displayValue}${unit ? ` ${unit}` : ''}`}>
      <span className="telemetry-numeric-value" style={{ color }}>
        {displayValue}
      </span>
      {unit && <span className="telemetry-numeric-unit">{unit}</span>}
      <span className="telemetry-numeric-time">{timeStr}</span>
    </div>
  );
};

export default TelemetryNumericLabel;
