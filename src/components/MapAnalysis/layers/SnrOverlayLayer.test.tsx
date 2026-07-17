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
      // #4166 — node 3 heard over two sources with DIVERGING positions. The
      // newest raw fix is source b at (99, 99), ts=300 — but the merged node
      // record (below) resolves to source a's (50, -110). The dot must follow
      // the MERGED/marker position, not the newest raw fix.
      { nodeNum: 3, sourceId: 'b', latitude: 99, longitude: 99, timestamp: 300 },
      { nodeNum: 3, sourceId: 'a', latitude: 50, longitude: -110, timestamp: 250 },
      // Node 20 is "Hide from Map" (merged record below) — it has an in-window
      // fix but must produce NO dot.
      { nodeNum: 20, sourceId: 'a', latitude: 45, longitude: -105, timestamp: 300 },
    ],
    isLoading: false,
    progress: { percent: 100, loaded: 7, estimatedTotal: 7 },
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
      // #4166 — node 3's merged/marker position is source a's (50, -110).
      { nodeNum: 3, sourceId: 'a', latitude: 50, longitude: -110, snr: 1 },
      // #4163-class — hidden node with a position; must produce no dot.
      { nodeNum: 20, sourceId: 'a', latitude: 45, longitude: -105, snr: 5, hideFromMap: true },
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
    // Unified positioned, non-hidden nodes: 10, 11 (twice across sources
    // collapses), 1, 2, 3. Node 12 has no position; node 20 is hideFromMap.
    // Total = 5.
    expect(dots).toHaveLength(5);
  });

  it('"Last" mode omits hideFromMap nodes (#4163-class — no marker, no dot)', () => {
    setConfig({ enabled: true, lookbackHours: null });
    renderWith(<SnrOverlayLayer />);
    // Node 20 (hideFromMap) sits at lat=45 — it must not render.
    const hidden = screen.getAllByTestId('snr-dot').find(
      (d) => d.getAttribute('data-lat') === '45',
    );
    expect(hidden).toBeUndefined();
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

  it('windowed mode renders one dot per nodeNum pinned to the merged marker position', () => {
    setConfig({ enabled: true, lookbackHours: 24 });
    renderWith(<SnrOverlayLayer />);
    const dots = screen.getAllByTestId('snr-dot');
    // Nodes with in-window fixes: 1, 2, 3, 20. Node 20 is hidden → dropped.
    // node 1 (3 fixes across sources) and node 2 each collapse to one dot.
    expect(dots).toHaveLength(3);
    // Node 1 renders at its merged position (lat=35, lng=-95).
    const node1 = dots.find((d) => d.getAttribute('data-lat') === '35');
    expect(node1).toBeDefined();
    expect(node1!.getAttribute('data-lng')).toBe('-95');
  });

  it('windowed mode follows the merged/marker position, not the newest raw fix (#4166)', () => {
    setConfig({ enabled: true, lookbackHours: 24 });
    renderWith(<SnrOverlayLayer />);
    const dots = screen.getAllByTestId('snr-dot');
    // Node 3's newest raw fix is source b at (99, 99), ts=300 — but its merged
    // record resolves to source a's (50, -110). The dot must be at (50, -110).
    const wrong = dots.find((d) => d.getAttribute('data-lat') === '99');
    expect(wrong).toBeUndefined();
    const node3 = dots.find((d) => d.getAttribute('data-lat') === '50');
    expect(node3).toBeDefined();
    expect(node3!.getAttribute('data-lng')).toBe('-110');
  });

  it('windowed mode omits hideFromMap nodes even when they have an in-window fix (#4163-class)', () => {
    setConfig({ enabled: true, lookbackHours: 24 });
    renderWith(<SnrOverlayLayer />);
    // Node 20 (hideFromMap) has an in-window fix at lat=45 but must not render.
    const hidden = screen.getAllByTestId('snr-dot').find(
      (d) => d.getAttribute('data-lat') === '45',
    );
    expect(hidden).toBeUndefined();
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
