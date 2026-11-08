/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistedListSort } from './usePersistedListSort';

const FIELDS = ['a', 'b'] as const;
const DEF = { field: 'a' as const, direction: 'asc' as const };

describe('usePersistedListSort', () => {
  beforeEach(() => localStorage.clear());
  it('uses defaults, then persists changes across remount', () => {
    const { result, unmount } = renderHook(() => usePersistedListSort('k', FIELDS, DEF));
    expect(result.current.field).toBe('a');
    act(() => result.current.setField('b'));
    act(() => result.current.toggleDirection());
    unmount();
    const again = renderHook(() => usePersistedListSort('k', FIELDS, DEF));
    expect(again.result.current.field).toBe('b');
    expect(again.result.current.direction).toBe('desc');
  });
  it('falls back for invalid or garbage values', () => {
    localStorage.setItem('k', JSON.stringify({ field: 'zzz', direction: 'desc' }));
    expect(renderHook(() => usePersistedListSort('k', FIELDS, DEF)).result.current.field).toBe('a');
    localStorage.setItem('k', '{not json');
    expect(renderHook(() => usePersistedListSort('k', FIELDS, DEF)).result.current.direction).toBe('asc');
  });
});
