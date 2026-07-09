/**
 * @vitest-environment jsdom
 *
 * Thin render test for selection dimming (issue #3788 WP-C, spec test #6).
 * `NodeMarkersLayer` is spiderfy/leaflet-heavy, so everything except the
 * opacity computation under test is mocked out — this only proves the
 * `isNodeEmphasized`/`selectionOpacity` wiring at the `<Marker opacity>` prop,
 * not marker/spiderfy behavior (already covered by other suites).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import NodeMarkersLayer from './NodeMarkersLayer';

vi.mock('react-leaflet', () => ({
  Marker: (p: { opacity?: number; children?: React.ReactNode }) => (
    <div data-testid="marker" data-opacity={p.opacity}>
      {p.children}
    </div>
  ),
  Popup: () => null,
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock('../../../hooks/useMarkerSpiderfier', () => ({
  useMarkerSpiderfier: () => ({
    addMarker: vi.fn(),
    removeMarker: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    getSpiderfier: vi.fn(),
  }),
  SHARED_SPIDERFIER_OPTIONS: {},
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useHopCounts: () => ({ data: undefined }),
}));
vi.mock('../../../contexts/SettingsContext', () => ({
  useSettings: () => ({ mapPinStyle: 'pin' }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
}));
vi.mock('../../Dashboard/DashboardNodePopup', () => ({
  default: () => null,
}));

const MOCK_ANALYSIS_NODES = [
  { node: { nodeNum: 1, sourceId: 'a', isMeshCore: false }, latLng: [30, -90] as [number, number], key: 'mt:1' },
  { node: { nodeNum: 2, sourceId: 'a', isMeshCore: false }, latLng: [31, -91] as [number, number], key: 'mt:2' },
];
vi.mock('../useAnalysisNodes', () => ({
  useAnalysisNodes: () => MOCK_ANALYSIS_NODES,
}));

function renderLayer() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>
        <NodeMarkersLayer />
      </MapAnalysisProvider>
    </QueryClientProvider>,
  );
}

describe('NodeMarkersLayer selection dimming', () => {
  beforeEach(() => localStorage.clear());

  it('renders both markers at full opacity with an empty selection', () => {
    renderLayer();
    const markers = screen.getAllByTestId('marker');
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.getAttribute('data-opacity'))).toEqual(['1', '1']);
  });

  it('dims the unselected marker and keeps the selected one at full opacity', () => {
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({
        version: 1,
        layers: {
          markers: { enabled: true, lookbackHours: null },
          traceroutes: { enabled: false, lookbackHours: 24 },
          neighbors: { enabled: false, lookbackHours: 24 },
          heatmap: { enabled: false, lookbackHours: 24 },
          trails: { enabled: false, lookbackHours: 24 },
          hopShading: { enabled: false, lookbackHours: null },
          snrOverlay: { enabled: false, lookbackHours: null },
          waypoints: { enabled: true, lookbackHours: null },
          polarGrid: { enabled: false, lookbackHours: null },
        },
        sources: [],
        timeSlider: { enabled: false },
        inspectorOpen: true,
        selectedNodeIds: ['mt:1'],
      }),
    );
    renderLayer();
    const markers = screen.getAllByTestId('marker');
    expect(markers).toHaveLength(2);
    const opacities = markers.map((m) => m.getAttribute('data-opacity'));
    expect(opacities).toEqual(['1', String(0.3)]);
  });
});
