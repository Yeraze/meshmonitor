/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider, useMapAnalysisCtx } from '../MapAnalysisContext';
import SnrOverlayLayer from './SnrOverlayLayer';

interface MockCircleProps {
  center: [number, number];
  eventHandlers?: { click?: () => void };
  pathOptions?: { color?: string; fillColor?: string };
}

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ center, eventHandlers, pathOptions }: MockCircleProps) => (
    <div
      data-testid="snr-dot"
      data-lat={center[0]}
      data-lng={center[1]}
      data-color={pathOptions?.color}
      onClick={() => eventHandlers?.click?.()}
    />
  ),
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      // Two recordings for node 1 — older then newer. Layer must dedupe to newer.
      { nodeNum: 1, sourceId: 'a', latitude: 30, longitude: -90, timestamp: 100 },
      { nodeNum: 1, sourceId: 'a', latitude: 35, longitude: -95, timestamp: 200 },
      // Same node 1 also seen on a different source — should still collapse
      // into the single newest fix across all sources.
      { nodeNum: 1, sourceId: 'b', latitude: 33, longitude: -93, timestamp: 150 },
      { nodeNum: 2, sourceId: 'a', latitude: 31, longitude: -91, timestamp: 50 },
    ],
    isLoading: false,
    progress: { percent: 100, loaded: 4, estimatedTotal: 4 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      // SNR coverage: excellent (≥5), good (0..5), fair (-5..0), poor (<-5), missing.
      { nodeNum: 10, sourceId: 'a', latitude: 40, longitude: -100, snr: 8 },
      { nodeNum: 11, sourceId: 'a', latitude: 41, longitude: -101, snr: 2 },
      // Same nodeNum from a different source — must collapse to one dot.
      { nodeNum: 11, sourceId: 'b', latitude: 41.5, longitude: -101.5, snr: 2 },
      // Node without a position should be skipped.
      { nodeNum: 12, sourceId: 'a', snr: -3 },
      { nodeNum: 1, sourceId: 'a', latitude: 35, longitude: -95, snr: -10 },
      { nodeNum: 2, sourceId: 'a', latitude: 31, longitude: -91 /* no snr */ },
    ],
    traceroutes: [],
    neighborInfo: [],
    channels: [],
    status: null,
    isLoading: false,
    isError: false,
  }),
}));

function setConfig(snrCfg: { enabled: boolean; lookbackHours: number | null }, extras: Record<string, unknown> = {}) {
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
        snrOverlay: snrCfg,
      },
      sources: [],
      timeSlider: { enabled: false },
      inspectorOpen: true,
      ...extras,
    }),
  );
}

function renderWith(node: React.ReactElement) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>{node}</MapAnalysisProvider>
    </QueryClientProvider>,
  );
}

describe('SnrOverlayLayer', () => {
  beforeEach(() => localStorage.clear());

  it('"Last" mode renders one dot per nodeNum even when the node appears under multiple sources', () => {
    setConfig({ enabled: true, lookbackHours: null });
    renderWith(<SnrOverlayLayer />);
    const dots = screen.getAllByTestId('snr-dot');
    // Unified positioned nodes: 10, 11 (twice across sources collapses), 1, 2.
    // Node 12 has no position. Total = 4.
    expect(dots).toHaveLength(4);
  });

  it('colors each dot by the node\'s most recent SNR (matches MapLegend thresholds)', () => {
    setConfig({ enabled: true, lookbackHours: null });
    renderWith(<SnrOverlayLayer />);
    const byNum = (lat: string) => screen.getAllByTestId('snr-dot').find(
      (d) => d.getAttribute('data-lat') === lat,
    );
    // node 10 snr=8  -> excellent (#22c55e)
    expect(byNum('40')!.getAttribute('data-color')).toBe('#22c55e');
    // node 11 snr=2  -> good (#eab308)
    expect(byNum('41')!.getAttribute('data-color')).toBe('#eab308');
    // node 1  snr=-10 -> poor (#ef4444)
    expect(byNum('35')!.getAttribute('data-color')).toBe('#ef4444');
    // node 2  snr=undefined -> noData (#888)
    expect(byNum('31')!.getAttribute('data-color')).toBe('#888');
  });

  it('windowed mode dedupes to the latest position per nodeNum across all sources', () => {
    setConfig({ enabled: true, lookbackHours: 24 });
    renderWith(<SnrOverlayLayer />);
    const dots = screen.getAllByTestId('snr-dot');
    // node 1 (3 fixes across sources) collapses to 1 dot, node 2 to 1 dot.
    expect(dots).toHaveLength(2);
    // Node 1's newest fix is timestamp=200 (lat=35, lng=-95). Multi-source
    // older fixes must not win.
    const node1 = dots.find((d) => d.getAttribute('data-lat') === '35');
    expect(node1).toBeDefined();
    expect(node1!.getAttribute('data-lng')).toBe('-95');
  });

  it('windowed mode excludes positions outside the time slider window', () => {
    setConfig(
      { enabled: true, lookbackHours: 24 },
      { timeSlider: { enabled: true, windowStartMs: 1_000, windowEndMs: 2_000 } },
    );
    renderWith(<SnrOverlayLayer />);
    expect(screen.queryAllByTestId('snr-dot')).toHaveLength(0);
  });

  it('clicking a dot selects the node by nodeNum (no sourceId, so the inspector matches across sources)', () => {
    setConfig({ enabled: true, lookbackHours: null });
    let capturedSelected: { type?: string; nodeNum?: number; sourceId?: string } | null = null;
    function Probe() {
      const { selected } = useMapAnalysisCtx();
      capturedSelected = selected as typeof capturedSelected;
      return null;
    }
    renderWith(
      <>
        <SnrOverlayLayer />
        <Probe />
      </>,
    );
    const [first] = screen.getAllByTestId('snr-dot');
    fireEvent.click(first);
    expect(capturedSelected).toMatchObject({ type: 'node' });
    expect(typeof capturedSelected!.nodeNum).toBe('number');
    // sourceId intentionally absent — inspector findNode falls back to nodeNum-only.
    expect(capturedSelected!.sourceId).toBeUndefined();
  });
});
