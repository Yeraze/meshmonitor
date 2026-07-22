/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AnalysisInspectorPanel from './AnalysisInspectorPanel';
import { MapAnalysisProvider, useMapAnalysisCtx } from './MapAnalysisContext';
import { calculateDistance, formatDistance } from '../../utils/distance';
import type { ElevationProfile } from '../../types/elevation';

// Real /api/sources/:id/nodes returns FLAT telemetry fields (no nested deviceMetrics).
// Mock matches that shape so the test catches regressions if we ever revert to nested-only reads.
// Extended (epic #3826, Phase 1, WP-2) with a second positioned Meshtastic
// node, an unpositioned Meshtastic node, and a MeshCore pair so neighbor-link
// endpoint resolution (`resolveNeighborEndpoints`) has data to resolve.
vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      {
        nodeNum: 1,
        nodeId: '!00000001',
        sourceId: 'a',
        longName: 'Alpha',
        shortName: 'A',
        position: { latitude: 30, longitude: -90 },
        snr: 7.25,
        rssi: -82,
        lastHeard: 1700000000,
        batteryLevel: 85,
        voltage: 4.12,
        channelUtilization: 12.3,
        airUtilTx: 1.45,
        uptimeSeconds: 7200,
      },
      {
        nodeNum: 2,
        nodeId: '!00000002',
        sourceId: 'a',
        longName: 'Bravo',
        shortName: 'B',
        position: { latitude: 31, longitude: -90 },
      },
      {
        nodeNum: 3,
        nodeId: '!00000003',
        sourceId: 'a',
        longName: 'Unpositioned',
        shortName: 'U',
        // No position — resolveNeighborEndpoints must return null when a
        // selected neighbor link references this node.
      },
      {
        nodeNum: 101,
        sourceId: 'a',
        isMeshCore: true,
        publicKey: 'pubkeyA1234567890abcdef',
        longName: 'MeshCore A',
        shortName: 'MCA',
        position: { latitude: 40, longitude: -100 },
      },
      {
        nodeNum: 102,
        sourceId: 'a',
        isMeshCore: true,
        publicKey: 'pubkeyB1234567890abcdef',
        longName: 'MeshCore B',
        shortName: 'MCB',
        position: { latitude: 41, longitude: -100 },
      },
    ],
  }),
}));
vi.mock('../../hooks/useMapAnalysisData', () => ({
  useHopCounts: () => ({
    data: { entries: [{ sourceId: 'a', nodeNum: 1, hops: 2 }] },
  }),
  useTraceroutes: () => ({
    items: [],
    isLoading: false,
    isError: false,
    error: null,
    progress: { loaded: 0, estimatedTotal: 0, percent: 100 },
  }),
}));
vi.mock('../../hooks/useLinkQuality', () => ({
  useLinkQuality: () => ({
    data: [
      { timestamp: 1700000000000, quality: 6 },
      { timestamp: 1700001000000, quality: 8 },
    ],
  }),
}));

// Terrain integration mocks (epic #3826, Phase 1, WP-2). Mutable per-test so
// a single factory serves the enabled/disabled/loading cases.
let mockElevationEnabled = true;
vi.mock('../../hooks/useElevationEnabled', () => ({
  useElevationEnabled: () => mockElevationEnabled,
}));

let mockElevationProfileResult: { data: ElevationProfile | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: false,
};
const useElevationProfileMock = vi.fn((..._args: unknown[]) => mockElevationProfileResult);
vi.mock('../../hooks/useElevationProfile', () => ({
  useElevationProfile: (...args: unknown[]) => useElevationProfileMock(...args),
}));

const mockDistanceUnit: 'km' | 'mi' = 'km';
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ distanceUnit: mockDistanceUnit }),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>{children}</MapAnalysisProvider>
    </QueryClientProvider>
  );
}

function SelectAlpha() {
  const ctx = useMapAnalysisCtx();
  return (
    <button
      onClick={() =>
        ctx.setSelected({ type: 'node', nodeNum: 1, sourceId: 'a' })
      }
    >
      select
    </button>
  );
}

function SelectSegment() {
  const ctx = useMapAnalysisCtx();
  return (
    <button
      onClick={() =>
        ctx.setSelected({
          type: 'segment',
          fromNodeNum: 1,
          toNodeNum: 2,
        })
      }
    >
      select-seg
    </button>
  );
}

/** Meshtastic neighbor link between two positioned nodes (1 <-> 2). */
function SelectNeighbor() {
  const ctx = useMapAnalysisCtx();
  return (
    <button
      onClick={() =>
        ctx.setSelected({
          type: 'neighbor',
          nodeNum: 1,
          neighborNum: 2,
          sourceId: 'a',
          snr: 5.5,
          timestamp: 1700000000000,
        })
      }
    >
      select-neighbor
    </button>
  );
}

/** Meshtastic neighbor link where the neighbor endpoint has no position. */
function SelectNeighborUnpositioned() {
  const ctx = useMapAnalysisCtx();
  return (
    <button
      onClick={() =>
        ctx.setSelected({
          type: 'neighbor',
          nodeNum: 1,
          neighborNum: 3,
          sourceId: 'a',
          snr: 2,
          timestamp: 1700000000000,
        })
      }
    >
      select-neighbor-unpositioned
    </button>
  );
}

/** MeshCore neighbor link between two positioned MeshCore nodes. */
function SelectNeighborMeshCore() {
  const ctx = useMapAnalysisCtx();
  return (
    <button
      onClick={() =>
        ctx.setSelected({
          type: 'neighbor',
          sourceId: 'a',
          publicKey: 'pubkeyA1234567890abcdef',
          neighborPublicKey: 'pubkeyB1234567890abcdef',
          nodeName: 'MeshCore A',
          neighborName: 'MeshCore B',
          snr: 3.1,
          timestamp: 1700000000000,
        })
      }
    >
      select-neighbor-meshcore
    </button>
  );
}

/** Reads live context state so tests can assert the profile-action dispatch. */
function CtxProbe() {
  const ctx = useMapAnalysisCtx();
  return (
    <div data-testid="ctx-probe">
      {JSON.stringify({
        linkProfileMode: ctx.linkProfileMode,
        measureMode: ctx.measureMode,
        viewMode: ctx.config.viewMode,
        linkEndpoints: ctx.linkEndpoints.map((e) => ({
          nodeNum: e.nodeNum,
          isMeshCore: e.isMeshCore,
        })),
      })}
    </div>
  );
}

function SetMeasureModeOn() {
  const ctx = useMapAnalysisCtx();
  return <button onClick={() => ctx.setMeasureMode(true)}>set-measure-mode</button>;
}

function SetViewMode3D() {
  const ctx = useMapAnalysisCtx();
  return <button onClick={() => ctx.setViewMode('3d')}>set-view-mode-3d</button>;
}

describe('AnalysisInspectorPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    mockElevationEnabled = true;
    mockElevationProfileResult = { data: undefined, isLoading: false };
    useElevationProfileMock.mockClear();
  });

  it('shows empty state when nothing selected', () => {
    render(
      <Wrapper>
        <AnalysisInspectorPanel />
      </Wrapper>,
    );
    expect(
      screen.getByText(/click a node, route segment, neighbor link, or trail/i),
    ).toBeInTheDocument();
  });

  it('renders node detail when a node is selected', () => {
    render(
      <Wrapper>
        <SelectAlpha />
        <AnalysisInspectorPanel />
      </Wrapper>,
    );
    fireEvent.click(screen.getByText('select'));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // hops
  });

  it('renders segment detail when a segment is selected', () => {
    render(
      <Wrapper>
        <SelectSegment />
        <AnalysisInspectorPanel />
      </Wrapper>,
    );
    fireEvent.click(screen.getByText('select-seg'));
    expect(screen.getByText(/Route segment/i)).toBeInTheDocument();
  });

  it('renders telemetry fields when a node is selected', () => {
    render(
      <Wrapper>
        <SelectAlpha />
        <AnalysisInspectorPanel />
      </Wrapper>,
    );
    fireEvent.click(screen.getByText('select'));
    expect(screen.getByText('Battery')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('4.12 V')).toBeInTheDocument();
    expect(screen.getByText('Uptime')).toBeInTheDocument();
    expect(screen.getByText('2.0h')).toBeInTheDocument();
    expect(screen.getByText('Air Util Tx')).toBeInTheDocument();
    expect(screen.getByText('1.45%')).toBeInTheDocument();
    expect(screen.getByText('Ch Util')).toBeInTheDocument();
    expect(screen.getByText('12.30%')).toBeInTheDocument();
    expect(screen.getByText('Link Q')).toBeInTheDocument();
    expect(screen.getByText('8.0/10')).toBeInTheDocument();
    expect(screen.getByText('SNR')).toBeInTheDocument();
    expect(screen.getByText('7.25 dB')).toBeInTheDocument();
  });

  it('collapses the sidebar when the collapse arrow is clicked, then re-expands via the expand arrow', () => {
    render(
      <Wrapper>
        <SelectAlpha />
        <AnalysisInspectorPanel />
      </Wrapper>,
    );
    fireEvent.click(screen.getByText('select'));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/collapse detail pane/i));
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    const expandBtn = screen.getByLabelText(/expand detail pane/i);
    fireEvent.click(expandBtn);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('renders the collapse arrow even with no selection', () => {
    render(
      <Wrapper>
        <AnalysisInspectorPanel />
      </Wrapper>,
    );
    expect(screen.getByLabelText(/collapse detail pane/i)).toBeInTheDocument();
  });

  // ===== Neighbor-link terrain integration (epic #3826, Phase 1, WP-2) =====

  describe('neighbor link terrain integration', () => {
    const expectedDistance = formatDistance(
      calculateDistance(30, -90, 31, -90),
      'km',
    );

    it('shows distance, endpoint elevations, and the profile action when both endpoints are positioned and elevation is enabled', () => {
      mockElevationEnabled = true;
      mockElevationProfileResult = {
        data: {
          distanceMeters: 111195,
          provider: 'test',
          samples: [
            { distance: 0, lat: 30, lng: -90, elevation: 123.4 },
            { distance: 55597, lat: 30.5, lng: -90, elevation: 200 },
            { distance: 111195, lat: 31, lng: -90, elevation: 87.6 },
          ],
        },
        isLoading: false,
      };
      render(
        <Wrapper>
          <SelectNeighbor />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('select-neighbor'));

      expect(screen.getByText('Neighbor Link')).toBeInTheDocument();
      expect(screen.getByText('Distance')).toBeInTheDocument();
      expect(screen.getByText(expectedDistance)).toBeInTheDocument();
      expect(screen.getByText('Node Elevation')).toBeInTheDocument();
      expect(screen.getByText('Neighbor Elevation')).toBeInTheDocument();
      expect(screen.getByText('123 m')).toBeInTheDocument();
      expect(screen.getByText('88 m')).toBeInTheDocument();
      expect(screen.getByText('View terrain profile')).toBeInTheDocument();

      // Cache-sharing contract (§2.1): the fetch must be issued with the
      // resolved endpoints, not left disabled, once elevation is enabled.
      const lastCall = useElevationProfileMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({ nodeNum: 1 });
      expect(lastCall?.[1]).toMatchObject({ nodeNum: 2 });
    });

    it('hides elevations and the profile action (but still shows distance) when elevation is disabled', () => {
      mockElevationEnabled = false;
      render(
        <Wrapper>
          <SelectNeighbor />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('select-neighbor'));

      expect(screen.getByText('Distance')).toBeInTheDocument();
      expect(screen.getByText(expectedDistance)).toBeInTheDocument();
      expect(screen.queryByText('Node Elevation')).not.toBeInTheDocument();
      expect(screen.queryByText('Neighbor Elevation')).not.toBeInTheDocument();
      expect(screen.queryByText('View terrain profile')).not.toBeInTheDocument();

      // Fetch gated off entirely: both endpoints passed as undefined.
      const lastCall = useElevationProfileMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toBeUndefined();
      expect(lastCall?.[1]).toBeUndefined();
    });

    it('hides distance, elevations, and the profile action when an endpoint is unpositioned', () => {
      render(
        <Wrapper>
          <SelectNeighborUnpositioned />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('select-neighbor-unpositioned'));

      // Panel still shows names/source/SNR.
      expect(screen.getByText('Neighbor Link')).toBeInTheDocument();
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Unpositioned')).toBeInTheDocument();

      expect(screen.queryByText('Distance')).not.toBeInTheDocument();
      expect(screen.queryByText('Node Elevation')).not.toBeInTheDocument();
      expect(screen.queryByText('View terrain profile')).not.toBeInTheDocument();
    });

    it('shows the loading placeholder for elevations while the profile is loading (distance still shown)', () => {
      mockElevationProfileResult = { data: undefined, isLoading: true };
      render(
        <Wrapper>
          <SelectNeighbor />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('select-neighbor'));

      expect(screen.getByText('Distance')).toBeInTheDocument();
      expect(screen.getByText(expectedDistance)).toBeInTheDocument();
      const dds = screen.getAllByText('…');
      expect(dds.length).toBe(2);
    });

    it('resolves a MeshCore neighbor link (isMeshCore: true) and renders distance + action', () => {
      render(
        <Wrapper>
          <SelectNeighborMeshCore />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('select-neighbor-meshcore'));

      expect(screen.getByText('MeshCore A')).toBeInTheDocument();
      expect(screen.getByText('MeshCore B')).toBeInTheDocument();
      expect(screen.getByText('Distance')).toBeInTheDocument();
      expect(screen.getByText('View terrain profile')).toBeInTheDocument();

      const lastCall = useElevationProfileMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({ isMeshCore: true, nodeNum: 101 });
      expect(lastCall?.[1]).toMatchObject({ isMeshCore: true, nodeNum: 102 });
    });

    it('dispatches linkProfileMode/linkEndpoints/measureMode via the existing MapAnalysisContext state machine when the action is clicked', () => {
      render(
        <Wrapper>
          <SetMeasureModeOn />
          <CtxProbe />
          <SelectNeighbor />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      // Arm measureMode first so we can prove the handler flips it off
      // (mutual exclusivity, matching the toolbar handler).
      fireEvent.click(screen.getByText('set-measure-mode'));
      expect(screen.getByTestId('ctx-probe').textContent).toContain('"measureMode":true');

      fireEvent.click(screen.getByText('select-neighbor'));
      fireEvent.click(screen.getByText('View terrain profile'));

      const probe = JSON.parse(screen.getByTestId('ctx-probe').textContent ?? '{}');
      expect(probe.linkProfileMode).toBe(true);
      expect(probe.measureMode).toBe(false);
      expect(probe.linkEndpoints).toEqual([
        { nodeNum: 1, isMeshCore: false },
        { nodeNum: 2, isMeshCore: false },
      ]);
    });

    // #3826 Phase 3 §2.5: profile-from-3D auto-switch.
    it('switches viewMode to 2d AND dispatches the profile state when triggered while in 3D', () => {
      render(
        <Wrapper>
          <SetViewMode3D />
          <CtxProbe />
          <SelectNeighbor />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('set-view-mode-3d'));
      expect(screen.getByTestId('ctx-probe').textContent).toContain('"viewMode":"3d"');

      fireEvent.click(screen.getByText('select-neighbor'));
      fireEvent.click(screen.getByText('View terrain profile'));

      const probe = JSON.parse(screen.getByTestId('ctx-probe').textContent ?? '{}');
      expect(probe.viewMode).toBe('2d');
      expect(probe.linkProfileMode).toBe(true);
      expect(probe.linkEndpoints).toEqual([
        { nodeNum: 1, isMeshCore: false },
        { nodeNum: 2, isMeshCore: false },
      ]);
    });

    it('does NOT call setViewMode when triggered while already in 2d', () => {
      render(
        <Wrapper>
          <CtxProbe />
          <SelectNeighbor />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      expect(screen.getByTestId('ctx-probe').textContent).toContain('"viewMode":"2d"');

      fireEvent.click(screen.getByText('select-neighbor'));
      fireEvent.click(screen.getByText('View terrain profile'));

      const probe = JSON.parse(screen.getByTestId('ctx-probe').textContent ?? '{}');
      expect(probe.viewMode).toBe('2d');
      expect(probe.linkProfileMode).toBe(true);
    });
  });
  describe('route segment terrain integration', () => {
    const expectedDistance = formatDistance(
      calculateDistance(30, -90, 31, -90),
      'km',
    );

    it('shows distance, endpoint elevations, and the profile action for a positioned segment when elevation is enabled', () => {
      mockElevationEnabled = true;
      mockElevationProfileResult = {
        data: {
          distanceMeters: 111195,
          provider: 'test',
          samples: [
            { distance: 0, lat: 30, lng: -90, elevation: 55.2 },
            { distance: 111195, lat: 31, lng: -90, elevation: 140.9 },
          ],
        },
        isLoading: false,
      };
      render(
        <Wrapper>
          <SelectSegment />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('select-seg'));

      expect(screen.getByText('Route Segment')).toBeInTheDocument();
      expect(screen.getByText('Distance')).toBeInTheDocument();
      expect(screen.getByText(expectedDistance)).toBeInTheDocument();
      expect(screen.getByText('From Elevation')).toBeInTheDocument();
      expect(screen.getByText('To Elevation')).toBeInTheDocument();
      expect(screen.getByText('55 m')).toBeInTheDocument();
      expect(screen.getByText('141 m')).toBeInTheDocument();
      expect(screen.getByText('View terrain profile')).toBeInTheDocument();

      const lastCall = useElevationProfileMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({ nodeNum: 1, isMeshCore: false });
      expect(lastCall?.[1]).toMatchObject({ nodeNum: 2, isMeshCore: false });
    });

    it('shows distance only (no elevations, no action) when elevation is disabled', () => {
      mockElevationEnabled = false;
      render(
        <Wrapper>
          <SelectSegment />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('select-seg'));

      expect(screen.getByText('Distance')).toBeInTheDocument();
      expect(screen.queryByText('From Elevation')).not.toBeInTheDocument();
      expect(screen.queryByText('View terrain profile')).not.toBeInTheDocument();
      const lastCall = useElevationProfileMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toBeUndefined();
      expect(lastCall?.[1]).toBeUndefined();
    });

    it('dispatches the link-profile state machine from a segment selection', () => {
      render(
        <Wrapper>
          <CtxProbe />
          <SelectSegment />
          <AnalysisInspectorPanel />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText('select-seg'));
      fireEvent.click(screen.getByText('View terrain profile'));

      const probe = JSON.parse(screen.getByTestId('ctx-probe').textContent ?? '{}');
      expect(probe.linkProfileMode).toBe(true);
      expect(probe.measureMode).toBe(false);
      expect(probe.linkEndpoints).toEqual([
        { nodeNum: 1, isMeshCore: false },
        { nodeNum: 2, isMeshCore: false },
      ]);
    });
  });
});

