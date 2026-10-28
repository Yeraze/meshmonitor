/**
 * @vitest-environment jsdom
 *
 * #6008: Map Analysis markers go through the shared role helper, so a
 * CLIENT_BASE node draws the base-station infrastructure glyph and a TRACKER
 * node draws an ordinary pin with the tracker corner badge. Uses the real
 * `createNodeIcon`; only the map/spiderfy plumbing is mocked.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import NodeMarkersLayer from './NodeMarkersLayer';
import { roleGlyphInnerSvg } from '../../../utils/roleGlyphSvg';

vi.mock('react-leaflet', () => ({
  Marker: (p: { icon?: { options?: { html?: string } } }) => (
    <div data-testid="marker" data-html={p.icon?.options?.html ?? ''} />
  ),
  Popup: () => null,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
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
vi.mock('../../../hooks/useMapAnalysisData', () => ({ useHopCounts: () => ({ data: undefined }) }));
vi.mock('../../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ mapPinStyle: 'meshmonitor' }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
}));
vi.mock('../../Dashboard/DashboardNodePopup', () => ({ default: () => null }));

const MOCK_ANALYSIS_NODES = [
  { node: { nodeNum: 1, sourceId: 'a', isMeshCore: false, shortName: 'BS', user: { role: 12 } }, latLng: [30, -90] as [number, number], key: 'mt:1' },
  { node: { nodeNum: 2, sourceId: 'a', isMeshCore: false, shortName: 'TR', user: { role: 5 } }, latLng: [31, -91] as [number, number], key: 'mt:2' },
];
vi.mock('../useAnalysisNodes', () => ({ useAnalysisNodes: () => MOCK_ANALYSIS_NODES }));

describe('Map Analysis NodeMarkersLayer role markers (#6008)', () => {
  it('draws CLIENT_BASE as the base glyph and TRACKER with its corner badge', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MapAnalysisProvider>
          <NodeMarkersLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    const [base, tracker] = screen.getAllByTestId('marker').map((m) => m.getAttribute('data-html') ?? '');
    // The base-station glyph's door is unique to CLIENT_BASE.
    const baseGlyph = roleGlyphInnerSvg('mtClientBase', '#9ca3af').trim();
    expect(base).toContain(baseGlyph.split('\n').pop()!.trim());
    expect(base).not.toContain('data-role-badge');
    expect(tracker).toContain('data-role-badge="tracker"');
  });
});
