/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const api = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./useMapMarkers', () => ({
  useMapMarkers: vi.fn(() => ({ markers: [], isLoading: false, ...api })),
}));

import { useMapMarkers } from './useMapMarkers';
import { useLocalMarkerAuthoring } from './useLocalMarkerAuthoring';
import type { MapMarker, MapMarkerInput } from '../types/mapMarker';

const marker = { id: 7, sourceId: 's1', label: 'Hill', latitude: 1, longitude: 2 } as unknown as MapMarker;
const input = { label: 'New' } as unknown as MapMarkerInput;

describe('useLocalMarkerAuthoring', () => {
  beforeEach(() => {
    api.create.mockClear();
    api.update.mockClear();
    api.remove.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses the mutation-only marker API for the source', () => {
    renderHook(() => useLocalMarkerAuthoring('s1', true));
    expect(useMapMarkers).toHaveBeenCalledWith('s1', false);
  });

  it('opens the editor at the picked spot and stops placing', () => {
    const { result } = renderHook(() => useLocalMarkerAuthoring('s1', true));
    act(() => result.current.setPlacing(true));
    expect(result.current.placing).toBe(true);
    act(() => result.current.pickSpot(10, 20));
    expect(result.current.placing).toBe(false);
    expect(result.current.editor.open).toBe(true);
    expect(result.current.editor.initial).toBeNull();
    expect(result.current.editor.defaultCoords).toEqual({ lat: 10, lon: 20 });
  });

  it('creates for a new spot and updates when editing', async () => {
    const { result } = renderHook(() => useLocalMarkerAuthoring('s1', true));
    act(() => result.current.pickSpot(1, 2));
    await act(async () => { await result.current.editor.save(input); });
    expect(api.create).toHaveBeenCalledWith(input);

    act(() => result.current.actions.onEdit(marker));
    expect(result.current.editor.initial).toBe(marker);
    expect(result.current.editor.defaultCoords).toBeNull();
    await act(async () => { await result.current.editor.save(input); });
    expect(api.update).toHaveBeenCalledWith({ id: 7, input });

    act(() => result.current.editor.close());
    expect(result.current.editor.open).toBe(false);
  });

  it('exposes the write grant as canEdit', () => {
    expect(renderHook(() => useLocalMarkerAuthoring('s1', true)).result.current.actions.canEdit).toBe(true);
    expect(renderHook(() => useLocalMarkerAuthoring('s1', false)).result.current.actions.canEdit).toBe(false);
  });

  it('deletes only after confirmation', () => {
    const { result } = renderHook(() => useLocalMarkerAuthoring('s1', true));
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    act(() => result.current.actions.onDelete(marker));
    expect(api.remove).not.toHaveBeenCalled();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    act(() => result.current.actions.onDelete(marker));
    expect(api.remove).toHaveBeenCalledWith(7);
  });

  it('cancels placing on Escape', () => {
    const { result } = renderHook(() => useLocalMarkerAuthoring('s1', true));
    act(() => result.current.setPlacing(true));
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(result.current.placing).toBe(false);
  });
});
