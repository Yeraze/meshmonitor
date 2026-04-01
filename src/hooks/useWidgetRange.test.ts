/**
 * @vitest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useWidgetRange, DEFAULT_GAUGE_RANGES } from './useWidgetRange';

describe('useWidgetRange', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns default range for known type (batteryLevel)', () => {
    const { result } = renderHook(() => useWidgetRange('node1', 'batteryLevel'));
    expect(result.current[0]).toEqual({ min: 0, max: 100 });
  });

  it('returns default range for known type (temperature)', () => {
    const { result } = renderHook(() => useWidgetRange('node1', 'temperature'));
    expect(result.current[0]).toEqual(DEFAULT_GAUGE_RANGES.temperature);
  });

  it('returns fallback [0,100] for unknown type', () => {
    const { result } = renderHook(() => useWidgetRange('node1', 'unknownMetric'));
    expect(result.current[0]).toEqual({ min: 0, max: 100 });
  });

  it('persists range to localStorage', () => {
    const { result } = renderHook(() => useWidgetRange('node1', 'temperature'));
    act(() => {
      result.current[1]({ min: -40, max: 85 });
    });
    expect(result.current[0]).toEqual({ min: -40, max: 85 });
    const stored = JSON.parse(localStorage.getItem('telemetry_widget_range_node1_temperature')!);
    expect(stored).toEqual({ min: -40, max: 85 });
  });

  it('reads persisted range from localStorage on init', () => {
    localStorage.setItem('telemetry_widget_range_node1_humidity', JSON.stringify({ min: 10, max: 90 }));
    const { result } = renderHook(() => useWidgetRange('node1', 'humidity'));
    expect(result.current[0]).toEqual({ min: 10, max: 90 });
  });
});
