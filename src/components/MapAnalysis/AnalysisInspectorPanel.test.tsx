/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AnalysisInspectorPanel from './AnalysisInspectorPanel';
import { MapAnalysisProvider, useMapAnalysisCtx } from './MapAnalysisContext';

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      {
        nodeNum: 1,
        sourceId: 'a',
        longName: 'Alpha',
        shortName: 'A',
        position: { latitude: 30, longitude: -90 },
      },
    ],
  }),
}));
vi.mock('../../hooks/useMapAnalysisData', () => ({
  useHopCounts: () => ({
    data: { entries: [{ sourceId: 'a', nodeNum: 1, hops: 2 }] },
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
});
