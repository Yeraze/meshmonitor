/**
 * @vitest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useWidgetMode } from './useWidgetMode';

describe('useWidgetMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns chart as default mode', () => {
    const { result } = renderHook(() => useWidgetMode('node1', 'temperature'));
    expect(result.current[0]).toBe('chart');
  });

  it('persists mode to localStorage', () => {
    const { result } = renderHook(() => useWidgetMode('node1', 'temperature'));
    act(() => {
      result.current[1]('gauge');
    });
    expect(result.current[0]).toBe('gauge');
    expect(localStorage.getItem('telemetry_widget_mode_node1_temperature')).toBe('gauge');
  });

  it('reads persisted mode from localStorage on init', () => {
    localStorage.setItem('telemetry_widget_mode_node1_batteryLevel', 'numeric');
    const { result } = renderHook(() => useWidgetMode('node1', 'batteryLevel'));
    expect(result.current[0]).toBe('numeric');
  });

  it('uses separate keys per nodeId and type', () => {
    const { result: r1 } = renderHook(() => useWidgetMode('node1', 'temperature'));
    const { result: r2 } = renderHook(() => useWidgetMode('node2', 'temperature'));
    act(() => {
      r1.current[1]('gauge');
    });
    expect(r1.current[0]).toBe('gauge');
    expect(r2.current[0]).toBe('chart');
  });
});
