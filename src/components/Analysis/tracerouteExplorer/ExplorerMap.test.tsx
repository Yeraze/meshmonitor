/**
 * @vitest-environment jsdom
 *
 * Traceroute Explorer map pane (#5511): link-usage lines, the focused run's
 * legs, node markers and the node click. react-leaflet and BaseMap are
 * stubbed to plain elements carrying the props under test.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    mapTileset: 'osm',
    customTilesets: [],
    overlayColors: { snrColors: { excellent: '#0f0', good: '#ff0', fair: '#f80', poor: '#f00', noData: '#888' } },
    defaultMapCenterLat: null,
    defaultMapCenterLon: null,
    defaultMapCenterZoom: null,
  }),
}));

vi.mock('../../map/BaseMap', () => ({
  BaseMap: ({ children }: { children?: React.ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

vi.mock('../../map/layers/TraceroutePathsLayer', () => ({
  TraceroutePathsLayer: ({ segments }: any) => (
    <div data-testid="focus-layer" data-legs={segments.map((s: any) => `${s.leg}:${s.fromNodeNum}-${s.toNodeNum}`).join(',')} />
  ),
}));

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children, eventHandlers, pathOptions }: any) => (
    <button type="button" data-testid="node-marker" data-opacity={pathOptions?.opacity} onClick={() => eventHandlers?.click?.({})}>
      {children}
    </button>
  ),
  Polyline: ({ children, pathOptions }: any) => (
    <div data-testid="link-line" data-weight={pathOptions?.weight} data-color={pathOptions?.color} data-dash={pathOptions?.dashArray ?? ''}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: any) => <span>{children}</span>,
  useMap: () => ({ getContainer: () => document.createElement('div'), invalidateSize: vi.fn(), setView: vi.fn(), fitBounds: vi.fn() }),
  useMapEvents: () => null,
}));

vi.mock('leaflet', () => ({
  default: { DomEvent: { stopPropagation: vi.fn() }, latLngBounds: () => ({ isValid: () => false }) },
}));

import { ExplorerMap } from './ExplorerMap';
import { buildRuns, type ExplorerNodeWire, type ExplorerRunWire } from './explorerModel';

const A = 0x101, B = 0x102, R = 0x103;
const node = (nodeNum: number, lat: number | null): ExplorerNodeWire => ({
  nodeNum, nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`, shortName: `N${nodeNum}`, longName: `Node ${nodeNum}`,
  role: null, hwModel: null, latitude: lat, longitude: lat == null ? null : 10,
});
const wire = (o: Partial<ExplorerRunWire>): ExplorerRunWire => ({
  id: 1, sourceId: 's', timestamp: 1, fromNodeNum: A, toNodeNum: B,
  route: JSON.stringify([R]), routeBack: JSON.stringify([R]), snrTowards: '[20,8]', snrBack: '[12,4]',
  channel: 0, packetId: null, transportMechanism: 1, ...o,
});

const nodes = new Map([node(A, 1), node(B, 2), node(R, 3)].map(n => [n.nodeNum, n]));
const runs = buildRuns([wire({ id: 1 }), wire({ id: 2, timestamp: 2 }), wire({ id: 3, timestamp: 3, route: null, routeBack: null })]);

function renderMap(props: Partial<React.ComponentProps<typeof ExplorerMap>> = {}) {
  const onNodeClick = vi.fn();
  render(
    <ExplorerMap
      runs={runs}
      nodes={nodes}
      focusRun={null}
      nodeFilter={null}
      lineMode="usage"
      fitKey="k"
      onNodeClick={onNodeClick}
      onBackgroundClick={vi.fn()}
      {...props}
    />,
  );
  return { onNodeClick };
}

describe('ExplorerMap', () => {
  it('draws one usage line per link, wider for more use, and no focus layer', () => {
    renderMap();
    const lines = screen.getAllByTestId('link-line');
    expect(lines).toHaveLength(2); // A–R and R–B
    // 2 answered runs × forward + return = 4 crossings per link
    expect(screen.getAllByText(/4 hops/)).toHaveLength(2);
    expect(screen.queryByTestId('focus-layer')).toBeNull();
    expect(screen.getAllByTestId('node-marker')).toHaveLength(3);
  });

  it('draws the focused run’s forward and return legs', () => {
    renderMap({ focusRun: runs[1] });
    expect(screen.getByTestId('focus-layer').dataset.legs).toBe(`forward:${A}-${R},forward:${R}-${B},return:${B}-${R},return:${R}-${A}`);
  });

  it('draws an unanswered focused run as a dashed endpoint line', () => {
    renderMap({ focusRun: runs[0] });
    expect(screen.queryByTestId('focus-layer')).toBeNull();
    expect(screen.getAllByTestId('link-line').some(l => l.dataset.dash === '3 7')).toBe(true);
  });

  it('reports a node click', () => {
    const { onNodeClick } = renderMap();
    fireEvent.click(screen.getAllByTestId('node-marker')[0]);
    expect(onNodeClick).toHaveBeenCalledWith(A);
  });

  it('says so when no node has a visible position', () => {
    render(
      <ExplorerMap
        runs={runs}
        nodes={new Map([node(A, null), node(B, null), node(R, null)].map(n => [n.nodeNum, n]))}
        focusRun={null}
        nodeFilter={null}
        lineMode="snr"
        fitKey="k"
        onNodeClick={vi.fn()}
        onBackgroundClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/None of these nodes has a position/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('link-line')).toHaveLength(0);
  });
});
