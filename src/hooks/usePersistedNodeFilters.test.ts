/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistedNodeFilters } from './usePersistedNodeFilters';
import { DEFAULT_NODE_FILTERS } from '../utils/nodeAdvancedFilter';

describe('usePersistedNodeFilters', () => {
  beforeEach(() => localStorage.clear());

  it('defaults when nothing is saved', () => {
    const { result } = renderHook(() => usePersistedNodeFilters('k'));
    expect(result.current[0]).toEqual(DEFAULT_NODE_FILTERS);
  });

  it('loads a legacy value and fills gaps', () => {
    localStorage.setItem('k', JSON.stringify({ showMqtt: true, filterMode: '' }));
    const { result } = renderHook(() => usePersistedNodeFilters('k'));
    expect(result.current[0].showMqtt).toBe(true);
    expect(result.current[0].filterMode).toBe('show');
    expect(result.current[0].channels).toEqual([]);
  });

  it('falls back on corrupt JSON', () => {
    localStorage.setItem('k', '{nope');
    const { result } = renderHook(() => usePersistedNodeFilters('k'));
    expect(result.current[0]).toEqual(DEFAULT_NODE_FILTERS);
  });

  it('writes changes', () => {
    const { result } = renderHook(() => usePersistedNodeFilters('k'));
    act(() => result.current[1](f => ({ ...f, showFavorites: true })));
    expect(JSON.parse(localStorage.getItem('k')!).showFavorites).toBe(true);
  });

  it('survives throwing storage', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const { result } = renderHook(() => usePersistedNodeFilters('k'));
    act(() => result.current[1](f => ({ ...f, showMqtt: true })));
    expect(result.current[0].showMqtt).toBe(true);
    spy.mockRestore();
  });
});
