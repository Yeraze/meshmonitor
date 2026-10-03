/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const settings = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => settings.current }));

import { useBaseMapSettings } from './useBaseMapSettings';

describe('useBaseMapSettings (#5555)', () => {
  it('maps the user settings onto the BaseMap tile props, CARTO key included', () => {
    const customTilesets = [{ id: 'custom-1' }];
    const styleJson = { version: 8 };
    settings.current = {
      mapTileset: 'cartoDark',
      customTilesets,
      cartoApiKey: 'abc123',
      activeStyleJson: styleJson,
      overlayColors: {},
    };
    const { result } = renderHook(() => useBaseMapSettings());
    expect(result.current).toEqual({
      tilesetId: 'cartoDark',
      customTilesets,
      cartoApiKey: 'abc123',
      styleJson,
    });
  });

  it('turns a null style into undefined so BaseMap falls back to its default style', () => {
    settings.current = { mapTileset: 'osm', customTilesets: [], cartoApiKey: null, activeStyleJson: null };
    const { result } = renderHook(() => useBaseMapSettings());
    expect(result.current.styleJson).toBeUndefined();
    expect(result.current.cartoApiKey).toBeNull();
  });
});
