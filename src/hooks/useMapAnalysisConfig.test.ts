/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMapAnalysisConfig, DEFAULT_CONFIG } from './useMapAnalysisConfig';

const KEY = 'mapAnalysis.config.v1';

describe('useMapAnalysisConfig', () => {
  beforeEach(() => localStorage.clear());

  it('returns DEFAULT_CONFIG when no stored value', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config).toEqual(DEFAULT_CONFIG);
  });

  it('toggles a layer and persists to localStorage', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setLayerEnabled('markers', false));
    expect(result.current.config.layers.markers.enabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY)!).layers.markers.enabled).toBe(false);
  });

  it('updates layer lookback and persists', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setLayerLookback('trails', 168));
    expect(result.current.config.layers.trails.lookbackHours).toBe(168);
  });

  it('updates selected sources', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setSources(['src-a', 'src-b']));
    expect(result.current.config.sources).toEqual(['src-a', 'src-b']);
  });

  it('survives malformed localStorage by falling back to defaults', () => {
    localStorage.setItem(KEY, '{not json');
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config).toEqual(DEFAULT_CONFIG);
  });

  it('defaults selectedNodeIds to an empty array', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config.selectedNodeIds).toEqual([]);
  });

  it('updates selectedNodeIds and persists to localStorage', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setSelectedNodeIds(['mt:1', 'mc:ab']));
    expect(result.current.config.selectedNodeIds).toEqual(['mt:1', 'mc:ab']);
    expect(JSON.parse(localStorage.getItem(KEY)!).selectedNodeIds).toEqual(['mt:1', 'mc:ab']);
  });

  it('loads an old config missing selectedNodeIds as an empty array without throwing', () => {
    const { selectedNodeIds: _omit, ...oldConfig } = DEFAULT_CONFIG;
    localStorage.setItem(KEY, JSON.stringify(oldConfig));
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config.selectedNodeIds).toEqual([]);
  });

  it('coerces a non-array selectedNodeIds to an empty array', () => {
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULT_CONFIG, selectedNodeIds: 'oops' }));
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config.selectedNodeIds).toEqual([]);
  });

  it('reset() clears selectedNodeIds back to an empty array', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setSelectedNodeIds(['mt:1']));
    expect(result.current.config.selectedNodeIds).toEqual(['mt:1']);
    act(() => result.current.reset());
    expect(result.current.config.selectedNodeIds).toEqual([]);
  });

  it('defaults followMode and autoZoom to false', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config.followMode).toBe(false);
    expect(result.current.config.autoZoom).toBe(false);
    expect(DEFAULT_CONFIG.followMode).toBe(false);
    expect(DEFAULT_CONFIG.autoZoom).toBe(false);
  });

  it('updates followMode and persists to localStorage', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setFollowMode(true));
    expect(result.current.config.followMode).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!).followMode).toBe(true);
  });

  it('updates autoZoom and persists to localStorage', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setAutoZoom(true));
    expect(result.current.config.autoZoom).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!).autoZoom).toBe(true);
  });

  it('loads an old config missing followMode/autoZoom as false without throwing', () => {
    const { followMode: _fm, autoZoom: _az, ...oldConfig } = DEFAULT_CONFIG;
    localStorage.setItem(KEY, JSON.stringify(oldConfig));
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config.followMode).toBe(false);
    expect(result.current.config.autoZoom).toBe(false);
  });

  it('coerces garbage followMode/autoZoom values to false', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...DEFAULT_CONFIG, followMode: 'yes', autoZoom: 1 }),
    );
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config.followMode).toBe(false);
    expect(result.current.config.autoZoom).toBe(false);
  });

  it('reset() clears followMode and autoZoom back to false', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setFollowMode(true));
    act(() => result.current.setAutoZoom(true));
    expect(result.current.config.followMode).toBe(true);
    expect(result.current.config.autoZoom).toBe(true);
    act(() => result.current.reset());
    expect(result.current.config.followMode).toBe(false);
    expect(result.current.config.autoZoom).toBe(false);
  });
});
