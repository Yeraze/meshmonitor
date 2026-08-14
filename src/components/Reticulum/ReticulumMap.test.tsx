/**
 * @vitest-environment jsdom
 *
 * ReticulumMap (#3960 Phase 3) — peer positions shared via Sideband telemetry.
 * Heavy leaflet internals (BaseMap/react-leaflet/NodeMarkersLayer) are stubbed;
 * this suite proves the position-filtering contract: only destinations with a
 * finite, non-null-island lat/lon become markers, and the explicit empty state
 * shows when nobody is sharing a position.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReticulumMap } from './ReticulumMap';
import type { ReticulumDestinationRow } from '../../types/reticulum';
import type { NodeMarkerDescriptor } from '../map/layers/NodeMarkersLayer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children: ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

const markersSpy = vi.fn();
vi.mock('../map/layers/NodeMarkersLayer', () => ({
  NodeMarkersLayer: ({ markers }: { markers: NodeMarkerDescriptor[] }) => {
    markersSpy(markers);
    return <div data-testid="node-markers-layer" data-count={markers.length} />;
  },
}));

vi.mock('../map/MapLoadingOverlay', () => ({
  MapLoadingOverlay: () => <div data-testid="map-loading-overlay" />,
}));

vi.mock('react-leaflet', () => ({
  Popup: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ mapTileset: 'osm', customTilesets: [], setMapTileset: vi.fn(), activeStyleJson: null }),
}));

function dest(overrides: Partial<ReticulumDestinationRow> = {}): ReticulumDestinationRow {
  return {
    sourceId: 'src-rns', destinationHash: 'deadbeefcafef00d', identityHash: null,
    appName: 'sideband', aspects: null, displayName: 'Alice', appDataB64: null,
    hops: 2, nextHopInterface: null, rssi: -80, snr: 5, quality: null,
    announceCount: 1, firstSeen: 0, lastSeen: 0, lastAnnounceAt: null,
    isFavorite: false, createdAt: 0, updatedAt: 0,
    latitude: null, longitude: null, altitude: null, speed: null,
    bearing: null, accuracy: null, positionUpdatedAt: null,
    ...overrides,
  };
}

describe('ReticulumMap', () => {
  it('renders a marker only for destinations with a finite position', () => {
    markersSpy.mockClear();
    render(<ReticulumMap destinations={[
      dest({ displayName: 'Alice', latitude: 40.1, longitude: -105.2 }),
      dest({ displayName: 'NoPos', latitude: null, longitude: null }),
    ]} />);
    expect(screen.getByTestId('node-markers-layer').getAttribute('data-count')).toBe('1');
    const markers = markersSpy.mock.calls.at(-1)![0] as NodeMarkerDescriptor[];
    expect(markers[0].position).toEqual([40.1, -105.2]);
  });

  it('discards null-island (0,0) positions', () => {
    render(<ReticulumMap destinations={[
      dest({ displayName: 'Zero', latitude: 0, longitude: 0 }),
    ]} />);
    expect(screen.getByTestId('node-markers-layer').getAttribute('data-count')).toBe('0');
  });

  it('shows the empty state when no peer is sharing a position', () => {
    render(<ReticulumMap destinations={[dest()]} loading={false} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(/No peers are sharing/i)).toBeTruthy();
  });

  it('does not show the empty state while loading', () => {
    render(<ReticulumMap destinations={[]} loading />);
    expect(screen.getByTestId('map-loading-overlay')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
