import { describe, it, expect } from 'vitest';
import { compareTelemetryGraphs } from './telemetryGraphOrder';

// Simple label map standing in for getTelemetryLabel.
const LABELS: Record<string, string> = {
  batteryLevel: 'Battery Level',
  channelUtilization: 'Channel Utilization',
  temperature: 'Temperature',
  voltage: 'Voltage',
  humidity: 'Relative Humidity',
};
const getLabel = (t: string) => LABELS[t] ?? t;

function sortTypes(types: string[], favorites: Set<string>): string[] {
  return [...types].sort((a, b) => compareTelemetryGraphs(a, b, favorites, getLabel));
}

describe('compareTelemetryGraphs', () => {
  const all = ['temperature', 'batteryLevel', 'voltage', 'channelUtilization', 'humidity'];

  it('orders alphabetically by display label when there are no favorites', () => {
    expect(sortTypes(all, new Set())).toEqual([
      'batteryLevel',        // Battery Level
      'channelUtilization',  // Channel Utilization
      'humidity',            // Relative Humidity
      'temperature',         // Temperature
      'voltage',             // Voltage
    ]);
  });

  it('puts favorites first, each group alphabetical by label', () => {
    const favorites = new Set(['voltage', 'temperature']);
    expect(sortTypes(all, favorites)).toEqual([
      // favorites, alphabetical by label: Temperature, Voltage
      'temperature',
      'voltage',
      // rest, alphabetical by label
      'batteryLevel',
      'channelUtilization',
      'humidity',
    ]);
  });

  it('is stable regardless of the input (insertion) order', () => {
    const favorites = new Set(['batteryLevel']);
    const orderA = sortTypes(['humidity', 'temperature', 'batteryLevel', 'voltage', 'channelUtilization'], favorites);
    const orderB = sortTypes(['voltage', 'channelUtilization', 'humidity', 'batteryLevel', 'temperature'], favorites);
    expect(orderA).toEqual(orderB);
    expect(orderA[0]).toBe('batteryLevel'); // favorite stays on top
  });

  it('slots a newly-available metric into its alphabetical position, not the top', () => {
    const favorites = new Set<string>();
    const before = sortTypes(['batteryLevel', 'voltage'], favorites);
    expect(before).toEqual(['batteryLevel', 'voltage']);
    // "humidity" => "Relative Humidity" sorts between Battery Level and Voltage
    const after = sortTypes(['batteryLevel', 'voltage', 'humidity'], favorites);
    expect(after).toEqual(['batteryLevel', 'humidity', 'voltage']);
  });

  it('falls back to the raw type when no label is known', () => {
    const favorites = new Set<string>();
    expect(sortTypes(['zzz_unknown', 'batteryLevel'], favorites)).toEqual(['batteryLevel', 'zzz_unknown']);
  });
});
