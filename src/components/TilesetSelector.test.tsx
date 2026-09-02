/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TilesetSelector } from './TilesetSelector';

const settings = {
  activeMapTilesetMode: 'light' as 'light' | 'dark',
  customTilesets: [],
  cartoApiKey: null as string | null,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => settings,
}));

vi.mock('./DraggableOverlay', () => ({
  DraggableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('TilesetSelector', () => {
  beforeEach(() => {
    settings.activeMapTilesetMode = 'light';
    settings.cartoApiKey = null;
  });

  it('identifies the light-mode slot edited by the in-map selector', () => {
    render(<TilesetSelector selectedTilesetId="osm" onTilesetChange={vi.fn()} />);
    expect(screen.getByText('Tileset (Light mode)')).toBeDefined();
  });

  it('identifies the dark-mode slot edited by the in-map selector', () => {
    settings.activeMapTilesetMode = 'dark';
    render(<TilesetSelector selectedTilesetId="cartoDark" onTilesetChange={vi.fn()} />);
    expect(screen.getByText('Tileset (Dark mode)')).toBeDefined();
  });
});

/**
 * #4380: on mobile the panel was force-hidden by
 * `.tileset-selector-wrapper { display: none }`, while the Features-panel
 * "Show Tile Selection" checkbox stayed visible and toggleable — a control
 * driving something that could never appear. The mobile branch renders a
 * bottom sheet instead of the draggable overlay.
 */
describe('TilesetSelector — mobile bottom sheet (#4380)', () => {
  const setViewport = (mobile: boolean) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: mobile && query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  };

  afterEach(() => {
    setViewport(false);
  });

  it('renders the sheet variant on a mobile viewport', () => {
    setViewport(true);
    const { container } = render(
      <TilesetSelector selectedTilesetId="osm" onTilesetChange={vi.fn()} />
    );

    expect(container.querySelector('.tileset-selector-sheet')).not.toBeNull();
  });

  it('does not render the sheet variant on a desktop viewport', () => {
    setViewport(false);
    const { container } = render(
      <TilesetSelector selectedTilesetId="osm" onTilesetChange={vi.fn()} />
    );

    expect(container.querySelector('.tileset-selector-sheet')).toBeNull();
  });

  it('stays reachable on mobile — expanding reveals the tileset list', () => {
    setViewport(true);
    const view = render(<TilesetSelector selectedTilesetId="osm" onTilesetChange={vi.fn()} />);

    // Collapsed by default: the header shows, the list does not.
    const { container } = view;
    expect(container.querySelectorAll('.tileset-button').length).toBe(0);

    fireEvent.click(container.querySelector('.tileset-collapse-btn')!);
    expect(container.querySelectorAll('.tileset-button').length).toBeGreaterThan(0);
  });

  it('collapses after a tileset is picked, so the choice is visible', () => {
    setViewport(true);
    const onTilesetChange = vi.fn();
    const { container } = render(
      <TilesetSelector selectedTilesetId="osm" onTilesetChange={onTilesetChange} />
    );

    fireEvent.click(container.querySelector('.tileset-collapse-btn')!);
    const tilesetButtons = container.querySelectorAll('.tileset-button');
    expect(tilesetButtons.length).toBeGreaterThan(0);

    fireEvent.click(tilesetButtons[0]);

    expect(onTilesetChange).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.tileset-selector.collapsed')).not.toBeNull();
    expect(container.querySelectorAll('.tileset-button').length).toBe(0);
  });

  it('keeps the panel open after a pick on desktop', () => {
    setViewport(false);
    const onTilesetChange = vi.fn();
    const { container } = render(
      <TilesetSelector selectedTilesetId="osm" onTilesetChange={onTilesetChange} />
    );

    fireEvent.click(container.querySelector('.tileset-collapse-btn')!);
    const tilesetButtons = container.querySelectorAll('.tileset-button');
    fireEvent.click(tilesetButtons[0]);

    expect(onTilesetChange).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.tileset-selector.collapsed')).toBeNull();
  });
});

/**
 * #5015: CARTO retired its free keyless rasters. An unkeyed tile request comes
 * back as a perfectly valid HTTP 200 PNG with "API KEY REQUIRED" painted
 * across it — there is no load error, no broken image, nothing any downstream
 * code can react to. The picker is the only place the user can be told, so
 * these guard that it actually tells them.
 */
describe('TilesetSelector — unkeyed CARTO warning (#5015)', () => {
  const WARNING = /needs a CARTO API key/i;

  beforeEach(() => {
    settings.activeMapTilesetMode = 'dark';
    settings.cartoApiKey = null;
  });

  it('warns when a CARTO tileset is selected and no key is configured', () => {
    render(<TilesetSelector selectedTilesetId="cartoDark" onTilesetChange={vi.fn()} embedded />);
    expect(screen.getByText(WARNING)).toBeDefined();
  });

  it('stays silent once a key is configured', () => {
    settings.cartoApiKey = 'pk_abc123';
    render(<TilesetSelector selectedTilesetId="cartoDark" onTilesetChange={vi.fn()} embedded />);
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('stays silent for a keyless tileset even with no key', () => {
    render(<TilesetSelector selectedTilesetId="esriDarkGray" onTilesetChange={vi.fn()} embedded />);
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('warns for cartoLight too, not just the dark one', () => {
    settings.activeMapTilesetMode = 'light';
    render(<TilesetSelector selectedTilesetId="cartoLight" onTilesetChange={vi.fn()} embedded />);
    expect(screen.getByText(WARNING)).toBeDefined();
  });

  it('does not remove the CARTO options — it warns, it does not substitute', () => {
    // Silently swapping the basemap would make the picker lie about what is on
    // screen, and the user may be picking CARTO precisely because a key is
    // about to be added.
    render(<TilesetSelector selectedTilesetId="cartoDark" onTilesetChange={vi.fn()} embedded />);
    expect(screen.getByText('Dark Mode')).toBeDefined();
    expect(screen.getByText('Dark Gray')).toBeDefined();
  });
});
