/**
 * @vitest-environment jsdom
 *
 * PacketRateChart (Dashboard) — #5101 Phase 3 WP2.
 *
 * Covers the D6 fix (usePacketRates must receive the active sourceId, or
 * the rates route falls back to ALL_SOURCES on the server) and the D4
 * device-counter caption.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import PacketRateChart from './PacketRateChart';
import { usePacketRates } from '../hooks/usePacketRates';
import { PACKET_RATE_RX_TYPE } from './PacketRateGraphs';

vi.mock('../hooks/usePacketRates', () => ({
  usePacketRates: vi.fn(),
}));

const mockUseSource = vi.fn();
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => mockUseSource(),
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

vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children?: React.ReactNode }) => <div data-testid="composed-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const NODE_ID = '!a1b2c3d4';

const rateResponse = () => ({
  numPacketsRx: [{ timestamp: Date.now() - 60_000, ratePerMinute: 3 }],
  numPacketsRxBad: [],
  numRxDupe: [],
  numPacketsTx: [],
  numTxDropped: [],
  numTxRelay: [],
  numTxRelayCanceled: [],
});

const renderChart = () =>
  render(
    <PacketRateChart
      id={`${NODE_ID}-${PACKET_RATE_RX_TYPE}`}
      favorite={{ nodeId: NODE_ID, telemetryType: PACKET_RATE_RX_TYPE }}
      node={undefined}
      hours={24}
      baseUrl=""
      globalTimeRange={null}
      onRemove={vi.fn()}
    />
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSource.mockReturnValue({ sourceId: 'source-a', sourceName: 'Source A' });
  (usePacketRates as Mock).mockReturnValue({
    data: rateResponse(),
    isLoading: false,
    error: null,
  });
});

describe('PacketRateChart (#5101 P3 WP2)', () => {
  it('passes the active sourceId from context to usePacketRates (D6)', () => {
    renderChart();

    expect(usePacketRates).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE_ID, hours: 24, baseUrl: '', sourceId: 'source-a' })
    );
  });

  it('renders the device-counter caption', () => {
    renderChart();

    expect(screen.getByText('telemetry.device_counter_note')).toBeInTheDocument();
  });

  it('still passes a null sourceId through when no source is active', () => {
    mockUseSource.mockReturnValue({ sourceId: null, sourceName: null });
    renderChart();

    expect(usePacketRates).toHaveBeenCalledWith(expect.objectContaining({ sourceId: null }));
  });
});
