import { describe, it, expect } from 'vitest';
import { getLatestValue } from './telemetry';
import type { TelemetryData } from '../hooks/useTelemetry';

const makePoint = (timestamp: number, value: number): TelemetryData => ({
  timestamp,
  value,
  telemetryType: 'temperature',
  unit: 'C',
  nodeNum: 1,
  nodeId: '!00000001',
});

describe('getLatestValue', () => {
  it('returns null for empty array', () => {
    expect(getLatestValue([])).toBeNull();
  });

  it('returns the single element for single-item array', () => {
    const data = [makePoint(1000, 25)];
    const result = getLatestValue(data);
    expect(result).not.toBeNull();
    expect(result!.value).toBe(25);
    expect(result!.timestamp).toBe(1000);
  });

  it('returns element with highest timestamp', () => {
    const data = [makePoint(1000, 10), makePoint(3000, 30), makePoint(2000, 20)];
    const result = getLatestValue(data);
    expect(result!.timestamp).toBe(3000);
    expect(result!.value).toBe(30);
  });
});
