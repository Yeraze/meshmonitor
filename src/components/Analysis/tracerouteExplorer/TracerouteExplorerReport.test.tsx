/**
 * @vitest-environment jsdom
 *
 * Traceroute Explorer report shell (#5511): filters, grouping, map↔table
 * linking, map collapse and full screen. The Leaflet map is stubbed (its own
 * layers have their own tests); the stub exposes the props the shell passes
 * so these tests can drive a node click and read what the map was given.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../../contexts/SettingsContext', () => ({
  useSettings: () => ({ timeFormat: '24', dateFormat: 'YYYY-MM-DD', distanceUnit: 'km', nodeHopsCalculation: 'nodeinfo' }),
}));

const fetchExplorer = vi.fn();
vi.mock('./explorerApi', async orig => {
  const actual = await orig<typeof import('./explorerApi')>();
  return { ...actual, fetchExplorer: (...args: unknown[]) => fetchExplorer(...args) };
});

vi.mock('./ExplorerMap', () => ({
  ExplorerMap: (props: any) => (
    <div data-testid="map-stub" data-runs={props.runs.length} data-focus={props.focusRun?.key ?? ''}>
      <button type="button" onClick={() => props.onNodeClick(0x11)}>
        click-relay
      </button>
    </div>
  ),
}));

vi.mock('../../traceroute/TracerouteStrip', () => ({
  default: () => <div data-testid="strip-stub" />,
}));
vi.mock('../../traceroute/TracerouteCopyLinks', () => ({
  TracerouteCopyLinks: () => <div data-testid="copy-stub" />,
}));
vi.mock('../../TracerouteHistoryModal', () => ({
  default: () => <div data-testid="history-stub" />,
}));

import TracerouteExplorerReport from './TracerouteExplorerReport';
import type { ExplorerResponse, ExplorerRunWire } from './explorerModel';
import { orientTracerouteRow } from '../../../utils/tracerouteOrientation';

const A = 0xa1, B = 0xb2, R1 = 0x11, R2 = 0x22;
const NOW = Date.now();

function run(o: Partial<ExplorerRunWire>): ExplorerRunWire {
  return {
    id: 1,
    sourceId: 'src-1',
    timestamp: NOW,
    fromNodeNum: A,
    toNodeNum: B,
    route: JSON.stringify([R1]),
    routeBack: JSON.stringify([R1]),
    snrTowards: '[20,8]',
    snrBack: '[12,4]',
    channel: 0,
    packetId: null,
    transportMechanism: 1,
    ...o,
  };
}

const node = (nodeNum: number, shortName: string, longName: string) => ({
  nodeNum, nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`, shortName, longName,
  role: null, hwModel: null, latitude: 1, longitude: 2,
});

function response(extra: Partial<ExplorerResponse> = {}): ExplorerResponse {
  return {
    sources: [{ id: 'src-1', name: 'Home TCP' }],
    runs: [
      run({ id: 1, timestamp: NOW - 1000 }),
      run({ id: 2, timestamp: NOW - 2000, route: null, routeBack: null, snrTowards: null, snrBack: null }),
      run({ id: 3, timestamp: NOW - 3000, route: JSON.stringify([R2]), routeBack: JSON.stringify([R2]) }),
      run({ id: 4, timestamp: NOW - 4000, fromNodeNum: R2, toNodeNum: B, route: '[]', routeBack: '[]', snrTowards: '[4]', snrBack: '[4]', transportMechanism: 5 }),
    ],
    nodes: [node(A, 'BASE', 'Base Station'), node(B, 'CAR1', 'Car One'), node(R1, 'RDG1', 'Ridge Relay'), node(R2, 'PEAK', 'Bald Peak')],
    truncated: false,
    scanLimit: 5000,
    retentionPerPair: 50,
    ...extra,
  };
}

function renderReport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TracerouteExplorerReport />
    </QueryClientProvider>,
  );
}

const workspace = () => screen.getByTestId('traceroute-explorer-workspace');

describe('TracerouteExplorerReport', () => {
  beforeEach(() => {
    fetchExplorer.mockReset();
    fetchExplorer.mockResolvedValue(response());
    localStorage.clear();
  });

  it('fetches the 24h window and shows summary stats and one row per pair', async () => {
    renderReport();
    await screen.findAllByTestId('explorer-pair-row');

    expect(fetchExplorer).toHaveBeenCalledWith({ hours: 24, sourceIds: [] });
    const summary = screen.getByTestId('traceroute-explorer-summary');
    expect(within(summary).getByText('4')).toBeInTheDocument(); // traceroutes
    expect(within(summary).getByText('75%')).toBeInTheDocument();
    expect(within(summary).getByText(/newest 50 runs per node pair/)).toBeInTheDocument();

    const pairs = screen.getAllByTestId('explorer-pair-row');
    expect(pairs).toHaveLength(2);
    expect(within(pairs[0]).getByText('2 paths seen')).toBeInTheDocument();
    expect(within(pairs[0]).getByText('67% answered')).toBeInTheDocument();
  });

  it('expands a pair, then selecting a run fills the detail drawer and focuses the map', async () => {
    const user = userEvent.setup();
    renderReport();
    const [pair] = await screen.findAllByTestId('explorer-pair-row');

    await user.click(pair);
    const runs = screen.getAllByTestId('explorer-run-row');
    expect(runs).toHaveLength(3);

    await user.click(runs[0]);
    const detail = screen.getByTestId('traceroute-explorer-detail');
    expect(within(detail).getByRole('heading').textContent).toBe('Base StationCar One');
    expect(within(detail).getByTestId('strip-stub')).toBeInTheDocument();
    expect(screen.getByTestId('map-stub').dataset.focus).toBe('src-1:1');
    expect(within(detail).getAllByText('1 of 2 answered runs')).toHaveLength(2);
  });

  // One run is stored two ways (src/utils/tracerouteOrientation.ts). The
  // server orients both with `orientTracerouteRow`, so the report must fold a
  // run we sent and a reply-only run over the same path into ONE pair with ONE
  // path, reading out from the node that asked.
  it('shows both stored forms of a run as one pair and one path, forward from the requester', async () => {
    const arrays = {
      route: JSON.stringify([R1, R2]), routeBack: JSON.stringify([R2, R1]),
      snrTowards: '[20,8,4]', snrBack: '[12,4,8]',
    };
    const storedSent = run({ id: 10, timestamp: NOW - 1000, fromNodeNum: A, toNodeNum: B, ...arrays });
    const storedReplyOnly = run({ id: 11, timestamp: NOW - 2000, fromNodeNum: B, toNodeNum: A, ...arrays });
    fetchExplorer.mockResolvedValue(
      response({ runs: [storedSent, storedReplyOnly].map(r => orientTracerouteRow(r, A)) }),
    );

    const user = userEvent.setup();
    renderReport();
    const pairs = await screen.findAllByTestId('explorer-pair-row');
    expect(pairs).toHaveLength(1);
    expect(within(pairs[0]).getByText('100% answered')).toBeInTheDocument();
    expect(pairs[0].textContent).toMatch(/BASE.*CAR1/);

    await user.click(pairs[0]);
    const runs = screen.getAllByTestId('explorer-run-row');
    expect(runs).toHaveLength(2);

    for (const row of runs) {
      await user.click(row);
      const detail = screen.getByTestId('traceroute-explorer-detail');
      expect(within(detail).getByRole('heading').textContent).toBe('Base StationCar One');
      expect(within(detail).getByText('BASE › RDG1 › PEAK › CAR1')).toBeInTheDocument();
      expect(within(detail).getByText('2 of 2 answered runs')).toBeInTheDocument();
    }
  });

  it('lists every run in flat mode and filters by result', async () => {
    const user = userEvent.setup();
    renderReport();
    await screen.findAllByTestId('explorer-pair-row');

    await user.click(screen.getByRole('button', { name: 'Every run' }));
    expect(screen.getAllByTestId('explorer-run-row')).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'No response' }));
    expect(screen.getAllByTestId('explorer-run-row')).toHaveLength(1);
  });

  it('a map node click filters the table, unless map filtering is turned off', async () => {
    const user = userEvent.setup();
    renderReport();
    await screen.findAllByTestId('explorer-pair-row');
    await user.click(screen.getByRole('button', { name: 'Every run' }));

    await user.click(screen.getByText('click-relay'));
    expect(screen.getByText('Through Ridge Relay')).toBeInTheDocument();
    expect(screen.getAllByTestId('explorer-run-row')).toHaveLength(1);
    // The map keeps its full context.
    expect(screen.getByTestId('map-stub').dataset.runs).toBe('4');

    await user.click(screen.getByLabelText('Filter table by map selection'));
    expect(screen.getAllByTestId('explorer-run-row')).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'Clear node filter' }));
    expect(screen.queryByText('Through Ridge Relay')).not.toBeInTheDocument();
  });

  it('collapses the map to a rail and remembers the layout', async () => {
    const user = userEvent.setup();
    renderReport();
    await screen.findAllByTestId('explorer-pair-row');
    expect(workspace().dataset.view).toBe('split');

    await user.click(screen.getByRole('button', { name: 'Collapse map' }));
    expect(workspace().dataset.view).toBe('table');
    expect(screen.queryByTestId('map-stub')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('meshmonitor.tracerouteExplorer.prefs')!).view).toBe('table');

    await user.click(screen.getByRole('button', { name: 'Show map' }));
    expect(workspace().dataset.view).toBe('split');
    expect(screen.getByTestId('map-stub')).toBeInTheDocument();
  });

  it('restores the saved layout on the next visit', async () => {
    localStorage.setItem('meshmonitor.tracerouteExplorer.prefs', JSON.stringify({ view: 'map', group: 'flat', lines: 'snr', split: 40 }));
    renderReport();
    await waitFor(() => expect(fetchExplorer).toHaveBeenCalled());
    expect(workspace().dataset.view).toBe('map');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('enters full screen and leaves it with Escape', async () => {
    const user = userEvent.setup();
    renderReport();
    await screen.findAllByTestId('explorer-pair-row');

    await user.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(workspace().className).toMatch(/full/);
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(workspace().className).not.toMatch(/full/);
    expect(document.body.style.overflow).toBe('');
  });

  it('warns when the window was truncated', async () => {
    fetchExplorer.mockResolvedValue(response({ truncated: true }));
    renderReport();
    expect(await screen.findByText(/more than 5000 stored rows/)).toBeInTheDocument();
  });

  it('refetches when the time range changes', async () => {
    const user = userEvent.setup();
    renderReport();
    await screen.findAllByTestId('explorer-pair-row');
    await user.click(screen.getAllByTestId('explorer-pair-row')[0]);
    await user.click(screen.getAllByTestId('explorer-run-row')[0]);
    expect(screen.getByTestId('traceroute-explorer-detail')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(fetchExplorer).toHaveBeenCalledWith({ hours: 168, sourceIds: [] }));
    // A new window starts with nothing selected.
    expect(screen.queryByTestId('traceroute-explorer-detail')).not.toBeInTheDocument();
  });
});
