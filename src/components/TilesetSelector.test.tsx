/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TilesetSelector } from './TilesetSelector';

const settings = {
  activeMapTilesetMode: 'light' as 'light' | 'dark',
  customTilesets: [],
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => settings,
}));

vi.mock('./DraggableOverlay', () => ({
  DraggableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('TilesetSelector', () => {
  beforeEach(() => {
    settings.activeMapTilesetMode = 'light';
  });

  it('identifies the light-mode slot edited by the in-map selector', () => {
    render(<TilesetSelector selectedTilesetId="osm" onTilesetChange={vi.fn()} />);
    expect(screen.getByText('Map Style (Light mode)')).toBeDefined();
  });

  it('identifies the dark-mode slot edited by the in-map selector', () => {
    settings.activeMapTilesetMode = 'dark';
    render(<TilesetSelector selectedTilesetId="cartoDark" onTilesetChange={vi.fn()} />);
    expect(screen.getByText('Map Style (Dark mode)')).toBeDefined();
  });
});
