import React from 'react';

interface TelemetryNumericLabelProps {
  value: number;
  unit: string;
  color: string;
  timestamp: number;
}

const TelemetryNumericLabel: React.FC<TelemetryNumericLabelProps> = ({ value, unit, color, timestamp }) => {
  const date = new Date(timestamp);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const displayValue = Number.isInteger(value) ? value.toString() : value.toFixed(2);

  return (
    <div className="telemetry-numeric" aria-label={`${value} ${unit}`}>
      <span className="telemetry-numeric-value" style={{ color }}>
        {displayValue}
      </span>
      {unit && <span className="telemetry-numeric-unit">{unit}</span>}
      <span className="telemetry-numeric-time">{timeStr}</span>
    </div>
  );
};

export default TelemetryNumericLabel;
