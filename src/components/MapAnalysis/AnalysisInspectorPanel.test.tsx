/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AnalysisInspectorPanel from './AnalysisInspectorPanel';
import { MapAnalysisProvider, useMapAnalysisCtx } from './MapAnalysisContext';

// Real /api/sources/:id/nodes returns FLAT telemetry fields (no nested deviceMetrics).
// Mock matches that shape so the test catches regressions if we ever revert to nested-only reads.
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
    ],
  }),
}));
vi.mock('../../hooks/useMapAnalysisData', () => ({
  useHopCounts: () => ({
    data: { entries: [{ sourceId: 'a', nodeNum: 1, hops: 2 }] },
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

describe('AnalysisInspectorPanel', () => {
  beforeEach(() => localStorage.clear());

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
});
