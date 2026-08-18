/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Map3DView } from './Map3DView';
import type { Line3DFeature } from './Base3DMap';

// Base3DMap is the heavy MapLibre surface — stub it to a DOM probe exposing the
// nodes/lines it receives, the same style BaseMap.test.tsx stubs its children.
vi.mock('./Base3DMap', () => ({
  Base3DMap: ({ nodes, lines, initialExaggeration }: any) => (
    <div
      data-testid="base-3d-map"
      data-node-count={nodes.length}
      data-line-count={lines.length}
      data-line-keys={JSON.stringify(lines.map((l: any) => l.key))}
      data-exaggeration={String(initialExaggeration ?? '')}
    />
  ),
}));

// Capture the params Map3DView feeds the generalized 3D data hooks, and let each
// test vary the lines they return.
const neighborSpy = vi.fn();
const tracerouteSpy = vi.fn();
const mockState: { neighborLines: Line3DFeature[]; tracerouteLines: Line3DFeature[] } = {
  neighborLines: [],
  tracerouteLines: [],
};

vi.mock('../MapAnalysis/use3DNeighborLines', () => ({
  use3DNeighborLines: (params: unknown) => {
    neighborSpy(params);
    return { lines: mockState.neighborLines, selectionByKey: new Map() };
  },
}));
vi.mock('../MapAnalysis/use3DTracerouteLines', () => ({
  use3DTracerouteLines: (params: unknown) => {
    tracerouteSpy(params);
    return { lines: mockState.tracerouteLines, selectionByKey: new Map() };
  },
}));

const line = (key: string): Line3DFeature => ({
  key,
  from: [30, -90],
  to: [31, -91],
  color: '#000',
  opacity: 1,
  width: 2,
});

const baseProps = {
  center: [30, -90] as [number, number],
  zoom: 10,
  basemap: { tiles: [], attribution: '', maxZoom: 19, usedFallback: false },
  terrainTileUrl: '/api/elevation/tiles/{z}/{x}/{y}',
  nodes: [
    { key: 'n1', lat: 30, lng: -90 },
    { key: 'n2', lat: 31, lng: -91 },
  ],
  sourceIds: ['a'],
  showNeighbors: true,
  showTraceroutes: true,
  lookbackHours: 24,
};

describe('Map3DView', () => {
  beforeEach(() => {
    neighborSpy.mockClear();
    tracerouteSpy.mockClear();
    mockState.neighborLines = [];
    mockState.tracerouteLines = [];
  });

  it('composes Base3DMap with the nodes and merged neighbor+traceroute lines', () => {
    mockState.neighborLines = [line('mt:1')];
    mockState.tracerouteLines = [line('tr:x')];
    render(<Map3DView {...baseProps} />);
    const map = screen.getByTestId('base-3d-map');
    expect(map.dataset.nodeCount).toBe('2');
    expect(map.dataset.lineCount).toBe('2');
    expect(JSON.parse(map.dataset.lineKeys ?? '[]')).toEqual(['mt:1', 'tr:x']);
  });

  it('feeds the neighbor hook the source-scoped, static (no time window) params', () => {
    render(<Map3DView {...baseProps} sourceIds={['a', 'b']} showNeighbors lookbackHours={12} />);
    expect(neighborSpy).toHaveBeenCalledWith({
      layer: { enabled: true, lookbackHours: 12 },
      sources: ['a', 'b'],
      timeSlider: { enabled: false },
    });
  });

  it('feeds the traceroute hook static params with no selection and no node filter', () => {
    render(<Map3DView {...baseProps} sourceIds={['a']} showTraceroutes lookbackHours={48} />);
    expect(tracerouteSpy).toHaveBeenCalledWith({
      layer: { enabled: true, lookbackHours: 48 },
      sources: ['a'],
      timeSlider: { enabled: false },
      selected: null,
      nodeFilter: '',
    });
  });

  it('gates each layer independently via showNeighbors / showTraceroutes', () => {
    render(<Map3DView {...baseProps} showNeighbors={false} showTraceroutes />);
    expect(neighborSpy).toHaveBeenCalledWith(
      expect.objectContaining({ layer: expect.objectContaining({ enabled: false }) }),
    );
    expect(tracerouteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ layer: expect.objectContaining({ enabled: true }) }),
    );
  });

  it('forwards the exaggeration seed to Base3DMap', () => {
    render(<Map3DView {...baseProps} initialExaggeration={1.8} />);
    expect(screen.getByTestId('base-3d-map').dataset.exaggeration).toBe('1.8');
  });
});
