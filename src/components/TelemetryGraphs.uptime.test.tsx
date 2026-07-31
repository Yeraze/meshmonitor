/**
 * @vitest-environment jsdom
 *
 * Per-node telemetry graphs: uptime humanization and current/power
 * auto-scaling (#3261).
 *
 * PR #4439 fixed only the Dashboard widget (TelemetryChart). TelemetryGraphs —
 * the near-identical component behind the node Info/Messages telemetry
 * sections — kept rendering "Device Uptime (s)" with raw seconds, and never
 * got the mA/mW scaling either. Both now share `telemetryDisplayScale`, and
 * these tests pin the behaviour on this side of the pair.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TelemetryGraphs from './TelemetryGraphs';
import { ToastProvider } from './ToastContainer';
import { CsrfProvider } from '../contexts/CsrfContext';
import { SettingsProvider } from '../contexts/SettingsContext';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true, isAdmin: true, authenticated: true }),
}));

vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'src-test' }));

let widgetMode = 'numeric';
vi.mock('../hooks/useWidgetMode', () => ({
  useWidgetMode: () => [widgetMode, vi.fn()],
}));

vi.mock('../hooks/useWidgetRange', () => ({
  useWidgetRange: () => [{ min: 0, max: 100 }, vi.fn()],
}));

// Capture axis/tooltip props so the formatter wiring is assertable.
const captured: {
  yAxis: Array<Record<string, unknown>>;
  tooltip: Array<Record<string, unknown>>;
} = { yAxis: [], tooltip: [] };

vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  LineChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
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
  Legend: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NODE_ID = '!a1b2c3d4';

// 1,543,452 s = 17 days 20 hours (and change) — the value from the report.
const UPTIME_SECONDS = 1543452;

let testQueryClient: QueryClient;

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={testQueryClient}>
    <CsrfProvider>
      <SettingsProvider>
        <ToastProvider>{children}</ToastProvider>
      </SettingsProvider>
    </CsrfProvider>
  </QueryClientProvider>
);

const renderGraphs = () => {
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(<TelemetryGraphs nodeId={NODE_ID} />, { wrapper: TestWrapper });
};

const row = (telemetryType: string, value: number, unit: string) => ({
  id: 1,
  nodeId: NODE_ID,
  telemetryType,
  timestamp: Date.now() - 60_000,
  value,
  unit,
});

const serveTelemetry = (rows: ReturnType<typeof row>[]) => {
  (global.fetch as Mock).mockImplementation((url: string) => {
    if (url.includes('/api/settings')) {
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
    if (url.includes('/api/solar/estimates')) {
      return Promise.resolve({ ok: true, json: async () => ({ count: 0, estimates: [] }) });
    }
    if (url.includes('/api/csrf-token')) {
      return Promise.resolve({ ok: true, json: async () => ({ token: 'test-csrf-token' }) });
    }
    return Promise.resolve({ ok: true, json: async () => rows });
  });
};

/** The `title` attribute of the single rendered graph header. */
const graphTitle = () => document.querySelector('.graph-title')?.getAttribute('title') ?? '';

/** Text of the numeric-mode readout. */
const numericValue = () =>
  document.querySelector('.telemetry-numeric-value')?.textContent ?? '';

global.fetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  widgetMode = 'numeric';
  captured.yAxis.length = 0;
  captured.tooltip.length = 0;
});

// ---------------------------------------------------------------------------

describe('TelemetryGraphs uptime humanization (#3261)', () => {
  it.each([['uptimeSeconds'], ['hostUptimeSeconds'], ['paxcounterUptime'], ['mc_uptime_secs']])(
    'numeric mode humanizes %s instead of raw seconds',
    async telemetryType => {
      serveTelemetry([row(telemetryType, UPTIME_SECONDS, 's')]);
      renderGraphs();

      await waitFor(() => expect(screen.getByText('17d 20h')).toBeTruthy());
      expect(screen.queryByText(String(UPTIME_SECONDS))).toBeNull();
    }
  );

  it('drops the redundant "s" unit from the graph header', async () => {
    serveTelemetry([row('uptimeSeconds', UPTIME_SECONDS, 's')]);
    renderGraphs();

    await waitFor(() => expect(document.querySelector('.graph-title')).toBeTruthy());
    // Regression: this read "Device Uptime (s)" before the fix.
    expect(graphTitle()).toContain('Device Uptime');
    expect(graphTitle()).not.toContain('(s)');
  });

  it('gauge mode humanizes the uptime value', async () => {
    widgetMode = 'gauge';
    serveTelemetry([row('uptimeSeconds', UPTIME_SECONDS, 's')]);
    renderGraphs();

    await waitFor(() => expect(screen.getByText('17d 20h')).toBeTruthy());
    expect(screen.queryByText(String(UPTIME_SECONDS))).toBeNull();
  });

  it('chart mode wires duration formatters into the Y-axis and tooltip', async () => {
    widgetMode = 'chart';
    serveTelemetry([row('uptimeSeconds', UPTIME_SECONDS, 's')]);
    renderGraphs();

    await waitFor(() => expect(captured.yAxis.length).toBeGreaterThan(0));

    const leftAxis = captured.yAxis.find(p => p.yAxisId === 'left');
    const tickFormatter = leftAxis!.tickFormatter as (v: number) => string;
    expect(tickFormatter(90000)).toBe('1d 1h');

    const formatter = captured.tooltip[0].formatter as (
      value: number | string,
      name: string
    ) => number | string;
    expect(formatter(UPTIME_SECONDS, 'value')).toBe('17d 20h');
    // Solar overlay stays in watt-hours.
    expect(formatter(5.5, 'solarEstimate')).toBe(5.5);
  });

  it('leaves non-uptime, non-integer metrics untouched', async () => {
    widgetMode = 'chart';
    // channelUtilization is a float, so no integer tick formatter competes here.
    serveTelemetry([row('channelUtilization', 15.5, '%')]);
    renderGraphs();

    await waitFor(() => expect(captured.yAxis.length).toBeGreaterThan(0));

    const leftAxis = captured.yAxis.find(p => p.yAxisId === 'left');
    expect(leftAxis!.tickFormatter).toBeUndefined();
    expect(captured.tooltip[0]?.formatter).toBeUndefined();
    expect(graphTitle()).toContain('(%)');
  });

  it('keeps the integer tick formatter for integer metrics', async () => {
    widgetMode = 'chart';
    serveTelemetry([row('numOnlineNodes', 12, '')]);
    renderGraphs();

    await waitFor(() => expect(captured.yAxis.length).toBeGreaterThan(0));

    const leftAxis = captured.yAxis.find(p => p.yAxisId === 'left');
    const tickFormatter = leftAxis!.tickFormatter as (v: number) => string;
    expect(tickFormatter(12.4)).toBe('12');
  });
});

describe('TelemetryGraphs current/power auto-scaling (#3261)', () => {
  it('shows a sub-1 A reading in mA', async () => {
    serveTelemetry([row('mc_current', 0.05, 'A')]);
    renderGraphs();

    await waitFor(() => expect(numericValue()).not.toBe(''));
    expect(Number(numericValue())).toBeCloseTo(50, 2);
    expect(graphTitle()).toContain('(mA)');
  });

  it('leaves a >= 1 A reading in A', async () => {
    serveTelemetry([row('mc_current', 2.5, 'A')]);
    renderGraphs();

    await waitFor(() => expect(numericValue()).not.toBe(''));
    expect(Number(numericValue())).toBeCloseTo(2.5, 2);
    expect(graphTitle()).toContain('(A)');
  });
});
