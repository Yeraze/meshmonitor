/**
 * @vitest-environment jsdom
 *
 * Dashboard telemetry widget uptime humanization (#3261).
 *
 * The shared Dashboard chart (TelemetryChart) must render uptime-in-seconds
 * metrics (uptimeSeconds, hostUptimeSeconds, paxcounterUptime, mc_*_uptime_secs)
 * as humanized durations in numeric mode, gauge mode, the Y-axis ticks and
 * the tooltip — and leave non-uptime metrics (e.g. batteryLevel) untouched.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import TelemetryChart from './TelemetryChart';
import { useTelemetry } from '../hooks/useTelemetry';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: vi.fn(),
}));

let widgetMode = 'numeric';
vi.mock('../hooks/useWidgetMode', () => ({
  useWidgetMode: () => [widgetMode, vi.fn()],
}));

vi.mock('../hooks/useWidgetRange', () => ({
  useWidgetRange: () => [{ min: 0, max: 100 }, vi.fn()],
}));

vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24h' }),
}));

vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-test', sourceName: 'Test Source' }),
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

// Capture axis/tooltip props so the formatter wiring is assertable.
interface CapturedProps {
  yAxis: Array<Record<string, unknown>>;
  tooltip: Array<Record<string, unknown>>;
}
const captured: CapturedProps = { yAxis: [], tooltip: [] };

vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="composed-chart">{children}</div>
  ),
  Line: () => null,
  Area: () => null,
  XAxis: () => null,
  YAxis: (props: Record<string, unknown>) => {
    captured.yAxis.push(props);
    return null;
  },
  CartesianGrid: () => null,
  Tooltip: (props: Record<string, unknown>) => {
    captured.tooltip.push(props);
    return null;
  },
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NODE_ID = '!a1b2c3d4';

// 1,543,452 s = 17 days 20 hours (and change)
const UPTIME_SECONDS = 1543452;

const telemetryRow = (telemetryType: string, value: number, unit: string) => ({
  id: 1,
  nodeId: NODE_ID,
  telemetryType,
  timestamp: Date.now() - 60_000,
  value,
  unit,
});

const setTelemetry = (rows: ReturnType<typeof telemetryRow>[]) => {
  (useTelemetry as Mock).mockReturnValue({
    data: rows,
    isLoading: false,
    error: null,
  });
};

const renderChart = (telemetryType: string) =>
  render(
    <TelemetryChart
      id={`${NODE_ID}-${telemetryType}`}
      favorite={{ nodeId: NODE_ID, telemetryType }}
      node={undefined}
      temperatureUnit="C"
      hours={24}
      baseUrl=""
      globalTimeRange={null}
      globalMinTime={undefined}
      solarEstimates={new Map()}
      onRemove={vi.fn()}
    />
  );

beforeEach(() => {
  vi.clearAllMocks();
  widgetMode = 'numeric';
  captured.yAxis.length = 0;
  captured.tooltip.length = 0;
});

// ---------------------------------------------------------------------------
// Numeric mode
// ---------------------------------------------------------------------------

describe('TelemetryChart uptime humanization (#3261)', () => {
  it.each([
    ['uptimeSeconds'],
    ['hostUptimeSeconds'],
    ['paxcounterUptime'],
    ['mc_uptime_secs'],
  ])('numeric mode humanizes %s instead of raw seconds', telemetryType => {
    setTelemetry([telemetryRow(telemetryType, UPTIME_SECONDS, 's')]);
    renderChart(telemetryType);

    expect(screen.getByText('17d 20h')).toBeTruthy();
    expect(screen.queryByText(String(UPTIME_SECONDS))).toBeNull();
  });

  it('numeric mode leaves non-uptime metrics untouched', () => {
    setTelemetry([telemetryRow('batteryLevel', 85, '%')]);
    renderChart('batteryLevel');

    expect(screen.getByText('85')).toBeTruthy();
    expect(screen.getByText('%')).toBeTruthy();
  });

  it('drops the redundant "s" unit for uptime metrics in the header', () => {
    setTelemetry([telemetryRow('uptimeSeconds', UPTIME_SECONDS, 's')]);
    renderChart('uptimeSeconds');

    expect(screen.queryByText('(s)')).toBeNull();
    // Humanized value carries its own unit, so no separate unit element.
    expect(screen.queryByText('s', { selector: '.telemetry-numeric-unit' })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Gauge mode
  // -------------------------------------------------------------------------

  it('gauge mode humanizes the uptime value', () => {
    widgetMode = 'gauge';
    setTelemetry([telemetryRow('uptimeSeconds', UPTIME_SECONDS, 's')]);
    renderChart('uptimeSeconds');

    expect(screen.getByText('17d 20h')).toBeTruthy();
    expect(screen.queryByText(String(UPTIME_SECONDS))).toBeNull();
  });

  it('gauge mode leaves non-uptime metrics untouched', () => {
    widgetMode = 'gauge';
    setTelemetry([telemetryRow('batteryLevel', 85, '%')]);
    renderChart('batteryLevel');

    expect(screen.getByText('85')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Chart mode: Y-axis tickFormatter + Tooltip formatter
  // -------------------------------------------------------------------------

  it('chart mode wires a duration tickFormatter into the left Y-axis', () => {
    widgetMode = 'chart';
    setTelemetry([telemetryRow('uptimeSeconds', UPTIME_SECONDS, 's')]);
    renderChart('uptimeSeconds');

    const leftAxis = captured.yAxis.find(p => p.yAxisId === 'left');
    expect(leftAxis).toBeTruthy();
    const tickFormatter = leftAxis!.tickFormatter as (v: number) => string;
    expect(typeof tickFormatter).toBe('function');
    expect(tickFormatter(90000)).toBe('1d 1h');
    expect(tickFormatter(UPTIME_SECONDS)).toBe('17d 20h');
  });

  it('chart mode wires a duration formatter into the tooltip, sparing solar', () => {
    widgetMode = 'chart';
    setTelemetry([telemetryRow('uptimeSeconds', UPTIME_SECONDS, 's')]);
    renderChart('uptimeSeconds');

    expect(captured.tooltip.length).toBeGreaterThan(0);
    const formatter = captured.tooltip[0].formatter as (
      value: number | string,
      name: string
    ) => number | string;
    expect(typeof formatter).toBe('function');
    expect(formatter(UPTIME_SECONDS, 'value')).toBe('17d 20h');
    // Solar overlay stays in watt-hours.
    expect(formatter(5.5, 'solarEstimate')).toBe(5.5);
  });

  it('chart mode leaves non-uptime metrics without a Y-axis tickFormatter', () => {
    widgetMode = 'chart';
    setTelemetry([telemetryRow('batteryLevel', 85, '%')]);
    renderChart('batteryLevel');

    const leftAxis = captured.yAxis.find(p => p.yAxisId === 'left');
    expect(leftAxis).toBeTruthy();
    expect(leftAxis!.tickFormatter).toBeUndefined();
    expect(captured.tooltip[0]?.formatter).toBeUndefined();
  });
});
