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
import type { ReticulumDestinationRow, ReticulumPathRow } from '../../types/reticulum';
import type { NodeMarkerDescriptor } from '../map/layers/NodeMarkersLayer';
import type { NeighborLinkDescriptor } from '../map/layers/NeighborLinksLayer';

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

const linksSpy = vi.fn();
vi.mock('../map/layers/NeighborLinksLayer', () => ({
  NeighborLinksLayer: ({ links }: { links: NeighborLinkDescriptor[] }) => {
    linksSpy(links);
    return <div data-testid="neighbor-links-layer" data-count={links.length} />;
  },
}));

vi.mock('react-leaflet', () => ({
  Popup: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
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

function path(overrides: Partial<ReticulumPathRow> = {}): ReticulumPathRow {
  return {
    sourceId: 'src-rns', destinationHash: 'deadbeefcafef00d', viaHash: 'feedfacecafebabe',
    hops: 1, interfaceName: null, expiresAt: null, updatedAt: 0,
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

  describe('path-graph overlay', () => {
    const destA = dest({ destinationHash: 'aaaa', displayName: 'A', latitude: 40.1, longitude: -105.2 });
    const destB = dest({ destinationHash: 'bbbb', displayName: 'B', latitude: 41.0, longitude: -104.0 });
    const destUnpositioned = dest({ destinationHash: 'cccc', displayName: 'C', latitude: null, longitude: null });

    it('draws no polylines when paths is absent', () => {
      linksSpy.mockClear();
      render(<ReticulumMap destinations={[destA, destB]} />);
      expect(screen.queryByTestId('neighbor-links-layer')).toBeNull();
    });

    it('draws no polylines when paths is an empty array', () => {
      linksSpy.mockClear();
      render(<ReticulumMap destinations={[destA, destB]} paths={[]} />);
      expect(screen.queryByTestId('neighbor-links-layer')).toBeNull();
    });

    it('draws an edge only when both endpoints are positioned destinations', () => {
      linksSpy.mockClear();
      render(<ReticulumMap
        destinations={[destA, destB, destUnpositioned]}
        paths={[
          path({ destinationHash: 'aaaa', viaHash: 'bbbb' }), // both positioned -> drawn
          path({ destinationHash: 'aaaa', viaHash: 'cccc' }), // via unpositioned -> skipped
          path({ destinationHash: 'cccc', viaHash: 'aaaa' }), // destination unpositioned -> skipped
          path({ destinationHash: 'aaaa', viaHash: 'zzzz' }), // via unknown hash -> skipped
        ]}
      />);
      expect(screen.getByTestId('neighbor-links-layer').getAttribute('data-count')).toBe('1');
      const links = linksSpy.mock.calls.at(-1)![0] as NeighborLinkDescriptor[];
      expect(links).toHaveLength(1);
      expect(links[0].positions).toEqual([[40.1, -105.2], [41.0, -104.0]]);
    });

    it('draws no edge for a zero-hop row (null viaHash)', () => {
      linksSpy.mockClear();
      render(<ReticulumMap
        destinations={[destA, destB]}
        paths={[path({ destinationHash: 'aaaa', viaHash: null })]}
      />);
      expect(screen.queryByTestId('neighbor-links-layer')).toBeNull();
    });
  });
});
