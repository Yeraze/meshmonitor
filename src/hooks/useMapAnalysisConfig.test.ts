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
});
