/**
 * @vitest-environment jsdom
 *
 * Telemetry chart rendering cost (perf Phase 1). The Info tab spent seconds
 * drawing one SVG marker per point and running the line-draw animation on every
 * chart. Both telemetry chart surfaces must:
 *  - draw a series of more than MAX_MARKER_POINTS line-only (dot={false}),
 *    keeping `activeDot` so the hovered point and tooltip still work;
 *  - keep markers on a small series;
 *  - never animate the series.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import TelemetryChart from './TelemetryChart';
import TelemetryGraphs from './TelemetryGraphs';
import { useTelemetry } from '../hooks/useTelemetry';
import { useNodeTimezone } from '../hooks/useNodeTimezone';
import { MAX_MARKER_POINTS } from '../utils/telemetryChartDensity';

vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: vi.fn(),
  useSolarIrradiance: () => ({ data: undefined }),
}));
vi.mock('../hooks/useNodeTimezone', () => ({
  useNodeTimezone: vi.fn(() => ({ data: undefined })),
  useSetNodeTimezone: () => ({ mutate: vi.fn(), isPending: false }),
  listTimeZones: () => ['UTC', 'America/Chicago'],
}));
vi.mock('../hooks/useFavorites', () => ({
  useFavorites: () => ({ data: undefined }),
  useToggleFavorite: () => ({ mutate: vi.fn() }),
}));
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useWidgetMode', () => ({ useWidgetMode: () => ['chart', vi.fn()] }));
vi.mock('../hooks/useWidgetRange', () => ({ useWidgetRange: () => [{ min: 0, max: 100 }, vi.fn()] }));
vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'src-test' }));
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ timeFormat: '24', solarMonitoringEnabled: false }),
}));
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-test', sourceName: 'Test Source' }),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true, authStatus: { user: { isAdmin: false } } }),
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

const lines: Array<Record<string, unknown>> = [];
const axes: Array<Record<string, unknown>> = [];
const tooltips: Array<Record<string, unknown>> = [];
vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Line: (props: Record<string, unknown>) => {
    lines.push(props);
    return null;
  },
  Area: () => null,
  XAxis: (props: Record<string, unknown>) => {
    axes.push(props);
    return null;
  },
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: (props: Record<string, unknown>) => {
    tooltips.push(props);
    return null;
  },
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const NODE_ID = '!a1b2c3d4';

/** `count` voltage samples one minute apart, ending now. */
const series = (count: number) => {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    nodeId: NODE_ID,
    telemetryType: 'voltage',
    timestamp: now - (count - i) * 60_000,
    value: 3.7 + (i % 5) * 0.01,
    unit: 'V',
  }));
};

const setTelemetry = (rows: ReturnType<typeof series>) => {
  (useTelemetry as Mock).mockReturnValue({ data: rows, isLoading: false, error: null, refetch: vi.fn() });
};

const renderDashboardChart = () =>
  render(
    <TelemetryChart
      id={`${NODE_ID}-voltage`}
      favorite={{ nodeId: NODE_ID, telemetryType: 'voltage' }}
      node={undefined}
      temperatureUnit="C"
      hours={24}
      baseUrl=""
      globalTimeRange={null}
      globalMinTime={undefined}
      onRemove={vi.fn()}
    />
  );

const renderInfoGraphs = () => render(<TelemetryGraphs nodeId={NODE_ID} />);

const lastLine = () => lines[lines.length - 1];

beforeEach(() => {
  lines.length = 0;
  axes.length = 0;
  tooltips.length = 0;
  (useNodeTimezone as Mock).mockReturnValue({ data: undefined });
});

describe.each([
  ['TelemetryChart (dashboard)', renderDashboardChart],
  ['TelemetryGraphs (Info tab / node details)', renderInfoGraphs],
])('%s', (_name, renderIt) => {
  it('draws a large series without markers but keeps the hover dot', () => {
    setTelemetry(series(MAX_MARKER_POINTS + 50));
    renderIt();
    expect(lines.length).toBeGreaterThan(0);
    expect(lastLine().dot).toBe(false);
    expect(lastLine().activeDot).toEqual({ r: 5 });
  });

  it('keeps markers on a small series', () => {
    setTelemetry(series(10));
    renderIt();
    expect(lastLine().dot).toEqual(expect.objectContaining({ r: 3 }));
  });

  it('turns the line animation off', () => {
    setTelemetry(series(10));
    renderIt();
    for (const props of lines) {
      expect(props.isAnimationActive).toBe(false);
    }
  });
});

// 2026-01-15T05:30:00Z: 23:30 on Jan 14 in Chicago.
const NEAR_MIDNIGHT = Date.UTC(2026, 0, 15, 5, 30);

describe.each([
  ['TelemetryChart (dashboard)', renderDashboardChart, false],
  ['TelemetryGraphs (Info tab / node details)', renderInfoGraphs, true],
])('%s in the node time zone (#6523)', (_name, renderIt, editable) => {
  it('draws axis and tooltip times in the node zone and names it', () => {
    (useNodeTimezone as Mock).mockReturnValue({ data: { timeZone: 'America/Chicago', source: 'position' } });
    setTelemetry(series(10));
    renderIt();
    const tick = axes[axes.length - 1].tickFormatter as (v: number) => string;
    expect(tick(NEAR_MIDNIGHT)).toBe('23:30');
    const label = tooltips[tooltips.length - 1].labelFormatter as (v: number) => string;
    expect(label(NEAR_MIDNIGHT)).toContain('14');
    expect(screen.getByText('telemetry.timezone_caption')).toBeTruthy();
    // Only the node panel offers the override, and only with nodes:write.
    expect(screen.queryByRole('combobox') !== null).toBe(editable);
  });

  it('shows no caption while the zone is unknown', () => {
    setTelemetry(series(10));
    renderIt();
    expect(screen.queryByText('telemetry.timezone_caption')).toBeNull();
  });
});
