/**
 * @vitest-environment jsdom
 *
 * TransportSeriesChart (#5101 Phase 3, WP4) - Dashboard card for a favorited
 * MeshMonitor-computed per-transport series.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TransportSeriesChart from './TransportSeriesChart';
import { useTelemetry } from '../hooks/useTelemetry';
import { TRANSPORT_NODES_HEARD_TYPE, TRANSPORT_PACKETS_RX_TYPE } from '../utils/transportSeries';

vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: vi.fn(),
}));

vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-test', sourceName: 'Test Source', sourceType: 'meshtastic_tcp' }),
}));

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

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

const setTelemetry = (rows: ReturnType<typeof row>[]) => {
  (useTelemetry as Mock).mockReturnValue({ data: rows, isLoading: false, error: null });
};

const renderCard = (telemetryType: string, onRemove = vi.fn()) =>
  render(
    <TransportSeriesChart
      id="k"
      favorite={{ nodeId: NODE_ID, telemetryType }}
      node={undefined}
      hours={24}
      baseUrl=""
      globalTimeRange={null}
      onRemove={onRemove}
    />
  );

beforeEach(() => {
  vi.clearAllMocks();
  captured.lines.length = 0;
  captured.areas.length = 0;
});

describe('TransportSeriesChart', () => {
  it('renders the nodes-heard chart (lines) for the nodes pseudo type', () => {
    const ts = 1_700_000_000_000;
    setTelemetry([row('systemNodesHeardRf', ts, 2), row('systemNodesHeardMqtt', ts, 1)]);
    renderCard(TRANSPORT_NODES_HEARD_TYPE);

    expect(captured.lines.length).toBeGreaterThan(0);
    expect(captured.areas.length).toBe(0);
  });

  it('renders the packets-RX chart (stacked area) for the packets pseudo type', () => {
    const ts = 1_700_000_000_000;
    setTelemetry([row('systemPacketsRxRf', ts, 4)]);
    renderCard(TRANSPORT_PACKETS_RX_TYPE);

    expect(captured.areas.length).toBeGreaterThan(0);
    expect(captured.lines.length).toBe(0);
  });

  it('fetches telemetry with the sourceId from context', () => {
    setTelemetry([row('systemNodesHeardRf', 1_700_000_000_000, 1)]);
    renderCard(TRANSPORT_NODES_HEARD_TYPE);

    expect(useTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE_ID, sourceId: 'src-test' })
    );
  });

  it('calls onRemove with the node id and telemetry type when the remove button is clicked', () => {
    setTelemetry([row('systemNodesHeardRf', 1_700_000_000_000, 1)]);
    const onRemove = vi.fn();
    renderCard(TRANSPORT_NODES_HEARD_TYPE, onRemove);

    fireEvent.click(screen.getByRole('button'));
    expect(onRemove).toHaveBeenCalledWith(NODE_ID, TRANSPORT_NODES_HEARD_TYPE);
  });

  it('shows the no-data state when every class is zero or empty', () => {
    setTelemetry([]);
    renderCard(TRANSPORT_NODES_HEARD_TYPE);
    expect(screen.getByText('info.transport_series_empty')).toBeTruthy();
  });

  it('shows the loading state', () => {
    (useTelemetry as Mock).mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderCard(TRANSPORT_NODES_HEARD_TYPE);
    expect(screen.getByText('dashboard.loading_chart')).toBeTruthy();
  });

  it('shows the error state', () => {
    (useTelemetry as Mock).mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    renderCard(TRANSPORT_NODES_HEARD_TYPE);
    expect(screen.getByText('dashboard.error_chart')).toBeTruthy();
  });
});
