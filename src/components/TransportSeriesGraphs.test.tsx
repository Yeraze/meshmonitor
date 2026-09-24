/**
 * @vitest-environment jsdom
 *
 * TransportSeriesGraphs (#5101 Phase 3, WP4) - Info tab section rendering the
 * two MeshMonitor-computed per-transport charts (nodes heard / packets RX).
 *
 * recharts is mocked so Line/Area/Legend props are inspectable directly,
 * rather than depending on jsdom's (nonexistent) SVG layout — matching the
 * pattern in TelemetryChart.uptime.test.tsx.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TransportSeriesGraphs from './TransportSeriesGraphs';
import { useTelemetry } from '../hooks/useTelemetry';
import { useFavorites } from '../hooks/useFavorites';
import { TRANSPORT_NODES_HEARD_TYPE, TRANSPORT_PACKETS_RX_TYPE } from '../utils/transportSeries';

vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: vi.fn(),
}));

const toggleMutate = vi.fn();
vi.mock('../hooks/useFavorites', () => ({
  useFavorites: vi.fn(),
  useToggleFavorite: vi.fn(() => ({ mutate: toggleMutate })),
}));

vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-test', sourceName: 'Test Source', sourceType: 'meshtastic_tcp' }),
}));

// Capture what the (mocked) chart body would render, without depending on
// recharts' SVG layout inside jsdom.
const captured: { lines: string[]; areas: string[] } = { lines: [], areas: [] };

vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="composed-chart">{children}</div>
  ),
  Line: (props: { dataKey: string }) => {
    captured.lines.push(props.dataKey);
    return null;
  },
  Area: (props: { dataKey: string }) => {
    captured.areas.push(props.dataKey);
    return null;
  },
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const NODE_ID = '!a1b2c3d4';

const row = (telemetryType: string, timestamp: number, value: number) => ({
  id: 1,
  nodeId: NODE_ID,
  nodeNum: 1,
  telemetryType,
  timestamp,
  value,
  createdAt: timestamp,
});

const setTelemetry = (
  rows: ReturnType<typeof row>[],
  overrides: Partial<{ isLoading: boolean; error: unknown }> = {}
) => {
  (useTelemetry as Mock).mockReturnValue({
    data: rows,
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? null,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  captured.lines.length = 0;
  captured.areas.length = 0;
  (useFavorites as Mock).mockReturnValue({ data: new Set<string>() });
});

describe('TransportSeriesGraphs', () => {
  it('shows the loading state', () => {
    setTelemetry([], { isLoading: true });
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);
    expect(screen.getByText('common.loading_indicator')).toBeTruthy();
  });

  it('shows the error state', () => {
    setTelemetry([], { error: new Error('boom') });
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);
    expect(screen.getByText('info.transport_series_error')).toBeTruthy();
  });

  it('shows the empty state when both series are empty', () => {
    setTelemetry([]);
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);
    expect(screen.getByTestId('transport-series-empty')).toBeTruthy();
    expect(screen.getByText('info.transport_series_empty')).toBeTruthy();
    expect(screen.queryByTestId('transport-series-nodes')).toBeNull();
    expect(screen.queryByTestId('transport-series-packets')).toBeNull();
  });

  it('renders both charts from telemetry data, hiding all-zero classes (D5)', () => {
    const ts = 1_700_000_000_000;
    setTelemetry([
      row('systemNodesHeardRf', ts, 3),
      row('systemNodesHeardUdp', ts, 0),
      row('systemNodesHeardMqtt', ts, 1),
      row('systemPacketsRxRf', ts, 5),
      row('systemPacketsRxUdp', ts, 0),
      row('systemPacketsRxMqtt', ts, 0),
    ]);
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);

    expect(screen.getByTestId('transport-series-nodes')).toBeTruthy();
    expect(screen.getByTestId('transport-series-packets')).toBeTruthy();
    expect(screen.queryByTestId('transport-series-empty')).toBeNull();

    // Nodes heard: three-line chart; UDP (all-zero) hidden.
    expect(captured.lines).toContain('rf');
    expect(captured.lines).toContain('mqtt');
    expect(captured.lines).not.toContain('udp');

    // Packets RX: stacked area; UDP and MQTT (all-zero) hidden.
    expect(captured.areas).toContain('rf');
    expect(captured.areas).not.toContain('udp');
    expect(captured.areas).not.toContain('mqtt');
  });

  it('shows only the chart with data when the other series is entirely zero', () => {
    const ts = 1_700_000_000_000;
    setTelemetry([row('systemNodesHeardRf', ts, 2)]);
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);

    expect(screen.getByTestId('transport-series-nodes')).toBeTruthy();
    expect(screen.queryByTestId('transport-series-packets')).toBeNull();
    expect(screen.queryByTestId('transport-series-empty')).toBeNull();
  });

  it('shows the averaged caption when toTransportChartRows averages (>500 points)', () => {
    const base = 1_700_000_000_000;
    const rows = [];
    for (let i = 0; i < 600; i++) {
      rows.push(row('systemNodesHeardRf', base + i * 5 * 60 * 1000, 1));
    }
    setTelemetry(rows);
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);
    expect(screen.getByText('info.transport_series_averaged')).toBeTruthy();
  });

  it('does not show the averaged caption for a raw (unaveraged) series', () => {
    const ts = 1_700_000_000_000;
    setTelemetry([row('systemNodesHeardRf', ts, 2)]);
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);
    expect(screen.queryByText('info.transport_series_averaged')).toBeNull();
  });

  it('toggles the pseudo favorite types when the stars are clicked', () => {
    const ts = 1_700_000_000_000;
    setTelemetry([row('systemNodesHeardRf', ts, 3), row('systemPacketsRxRf', ts, 5)]);
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);

    const stars = screen.getAllByRole('button');
    expect(stars).toHaveLength(2);
    fireEvent.click(stars[0]);
    fireEvent.click(stars[1]);

    expect(toggleMutate).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE_ID, telemetryType: TRANSPORT_NODES_HEARD_TYPE })
    );
    expect(toggleMutate).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE_ID, telemetryType: TRANSPORT_PACKETS_RX_TYPE })
    );
  });

  it('fetches telemetry with the sourceId from context', () => {
    setTelemetry([row('systemNodesHeardRf', 1_700_000_000_000, 1)]);
    render(<TransportSeriesGraphs nodeId={NODE_ID} />);
    expect(useTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE_ID, sourceId: 'src-test' })
    );
  });
});
