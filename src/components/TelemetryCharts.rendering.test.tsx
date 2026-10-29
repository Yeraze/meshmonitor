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
import { render } from '@testing-library/react';
import TelemetryChart from './TelemetryChart';
import TelemetryGraphs from './TelemetryGraphs';
import { useTelemetry } from '../hooks/useTelemetry';
import { MAX_MARKER_POINTS } from '../utils/telemetryChartDensity';

vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: vi.fn(),
  useSolarEstimates: () => ({ data: undefined }),
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
vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Line: (props: Record<string, unknown>) => {
    lines.push(props);
    return null;
  },
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
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
      solarEstimates={new Map()}
      onRemove={vi.fn()}
    />
  );

const renderInfoGraphs = () => render(<TelemetryGraphs nodeId={NODE_ID} />);

const lastLine = () => lines[lines.length - 1];

beforeEach(() => {
  lines.length = 0;
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
