import type { TelemetryData } from '../hooks/useTelemetry';

/**
 * Returns the most recent telemetry data point from an array.
 * Returns null if the array is empty.
 */
export function getLatestValue(data: TelemetryData[]): { value: number; timestamp: number } | null {
  if (!data.length) return null;
  return data.reduce((latest, d) => (d.timestamp > latest.timestamp ? d : latest));
}
