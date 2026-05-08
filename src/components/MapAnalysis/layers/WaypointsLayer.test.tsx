/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';

// Stub leaflet primitives so the tests don't need a real DOM map context.
vi.mock('react-leaflet', () => ({
  Marker: ({ children, position }: any) => (
    <div data-testid="waypoint-marker" data-pos={JSON.stringify(position)}>
      {children}
    </div>
  ),
  Popup: ({ children }: any) => <div data-testid="waypoint-popup">{children}</div>,
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn((opts: any) => opts),
  },
}));

vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({
    data: [{ id: 'src-1', name: 'Source One' }],
  }),
}));

const sample = [
  {
    sourceId: 'src-1',
    waypointId: 1,
    ownerNodeNum: 555,
    latitude: 30,
    longitude: -90,
    expireAt: null,
    lockedTo: null,
    name: 'Camp',
    description: '',
    iconCodepoint: 0x1f3d5,
    iconEmoji: '🏕️',
    isVirtual: false,
    rebroadcastIntervalS: null,
    lastBroadcastAt: null,
    firstSeenAt: 1,
    lastUpdatedAt: 1,
  },
];

vi.mock('../../../hooks/useWaypoints', () => ({
  useWaypoints: () => ({
    waypoints: sample,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    create: { mutateAsync: vi.fn() },
    update: { mutateAsync: vi.fn() },
    remove: { mutateAsync: vi.fn() },
  }),
}));

import WaypointsLayer from './WaypointsLayer';

beforeEach(() => {
  localStorage.setItem(
    'mapAnalysis.config.v1',
    JSON.stringify({
      version: 1,
      layers: {
        markers: { enabled: false, lookbackHours: null },
        traceroutes: { enabled: false, lookbackHours: 24 },
        neighbors: { enabled: false, lookbackHours: 24 },
        heatmap: { enabled: false, lookbackHours: 24 },
        trails: { enabled: false, lookbackHours: 24 },
        hopShading: { enabled: false, lookbackHours: null },
        snrOverlay: { enabled: false, lookbackHours: 24 },
        waypoints: { enabled: true, lookbackHours: null },
      },
      sources: [],
      timeSlider: { enabled: false },
      inspectorOpen: true,
    }),
  );
});

describe('WaypointsLayer', () => {
  it('renders one marker per waypoint with the expected coordinates', () => {
    const qc = new QueryClient();
    const { getAllByTestId } = render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <WaypointsLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    const markers = getAllByTestId('waypoint-marker');
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('data-pos')).toBe('[30,-90]');
  });
});
