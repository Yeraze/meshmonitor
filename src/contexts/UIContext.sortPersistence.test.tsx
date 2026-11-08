/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UIProvider, useUI } from './UIContext';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter><UIProvider>{children}</UIProvider></MemoryRouter>
);

describe('UIContext toolbar sort persistence (Q1)', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to the Settings preferred sort', () => {
    localStorage.setItem('preferredSortField', 'snr');
    localStorage.setItem('preferredSortDirection', 'desc');
    const { result } = renderHook(() => useUI(), { wrapper });
    expect(result.current.sortField).toBe('snr');
    expect(result.current.sortDirection).toBe('desc');
  });

  it('saved toolbar choice wins after remount', () => {
    localStorage.setItem('preferredSortField', 'snr');
    const first = renderHook(() => useUI(), { wrapper });
    act(() => first.result.current.setSortField('battery'));
    act(() => first.result.current.setSortDirection('desc'));
    first.unmount();
    const second = renderHook(() => useUI(), { wrapper });
    expect(second.result.current.sortField).toBe('battery');
    expect(second.result.current.sortDirection).toBe('desc');
  });
});
