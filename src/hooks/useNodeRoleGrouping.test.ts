/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNodeRoleGrouping } from './useNodeRoleGrouping';

const nodes = [{ isMeshCore: true, advType: 2 }, { isMeshCore: true, advType: 1 }] as any[];

describe('useNodeRoleGrouping', () => {
  it('returns the flat list when disabled', () => {
    const { result } = renderHook(() => useNodeRoleGrouping(nodes, (x) => x, false, nodes));
    expect(result.current.distribution).toBeNull();
    expect(result.current.items.every((i) => i.type === 'node')).toBe(true);
  });
  it('groups and collapses when enabled', () => {
    const { result } = renderHook(() => useNodeRoleGrouping(nodes, (x) => x, true, nodes));
    const headers = result.current.items.filter((i) => i.type === 'header') as any[];
    expect(headers.length).toBeGreaterThan(0);
    act(() => result.current.toggleCollapsed(headers[0].category));
    const after = result.current.items.filter((i) => i.type === 'node').length;
    expect(after).toBeLessThan(nodes.length);
  });
});
