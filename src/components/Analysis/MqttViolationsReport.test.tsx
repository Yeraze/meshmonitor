/**
 * @vitest-environment jsdom
 *
 * MqttViolationsReport — ok_to_mqtt violation gateway summary report
 * (#4114 Phase 3). Covers the deferred run, sorting/pagination against
 * the API whitelist, cap honesty, the `includeUnknown` toggle, all six
 * render-state precedence rules, the `suspectedAvailable` trap, and the
 * client-side date-range guard (WP2), plus the drill-down fetch/render and
 * its own states, and CSV export for both tables (WP3, tests 9/10/16).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Override the global i18n mock (src/test/setup.ts) — that mock's `t(key, options)`
// signature doesn't understand this component's real i18next-style
// `t(key, defaultValue, options)` calls, so string assertions here need a
// local mock that returns the default value (with {{var}} interpolation from
// the options arg), matching the NodeInfoEnrichmentReport.test.tsx precedent.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string, options?: Record<string, unknown>) => {
      let result = typeof defaultValue === 'string' ? defaultValue : key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          result = result.replace(`{{${k}}}`, String(v));
        });
      }
      return result;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../../services/api', async (orig) => {
  const actual = await orig<typeof import('../../services/api')>();
  return {
    __esModule: true,
    default: { get: vi.fn(), post: vi.fn() },
    ApiError: actual.ApiError,
  };
});

// Spy on the DOM download side-effect only; keep the real `escapeCsv` (used
// internally by mqttViolationsCsv.ts) so the generated CSV string is real.
vi.mock('../../utils/nodeExport', async (orig) => {
  const actual = await orig<typeof import('../../utils/nodeExport')>();
  return { ...actual, downloadTextFile: vi.fn() };
});

import api, { ApiError } from '../../services/api';
import { downloadTextFile } from '../../utils/nodeExport';
import { ToastProvider } from '../ToastContainer';
import MqttViolationsReport from './MqttViolationsReport';
import {
  API_SCAN_CAP,
  type ViolationGatewayRow,
  type ViolationGatewaysResponse,
  type ViolationPacketRow,
  type ViolationPacketsResponse,
} from './mqttViolationTypes';

function renderReport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MqttViolationsReport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function gatewayRow(overrides: Partial<ViolationGatewayRow> = {}): ViolationGatewayRow {
  return {
    gatewayId: '!433e0f28',
    gatewayNodeNum: 0x433e0f28,
    // Unnamed by default so the existing id-based assertions keep exercising
    // the no-NodeInfo fallback; tests that care about names override these.
    gatewayLongName: null,
    gatewayShortName: null,
    violationCount: 5,
    suspectedCount: 0,
    distinctOriginators: 2,
    sourceIds: ['mqtt-a'],
    firstSeen: Date.UTC(2026, 6, 1),
    lastSeen: Date.UTC(2026, 6, 20),
    ...overrides,
  };
}

function baseResponse(overrides: Partial<ViolationGatewaysResponse> = {}): {
  success: true;
  data: ViolationGatewaysResponse;
} {
  return {
    success: true,
    data: {
      gateways: [],
      total: 0,
      limit: 50,
      offset: 0,
      since: Date.UTC(2026, 6, 17),
      until: Date.UTC(2026, 6, 24),
      includeUnknown: false,
      suspectedAvailable: false,
      suspectedWindowMs: 0,
      sources: ['mqtt-a'],
      // Default-path default: the server never applies the cap on this path
      // (#4330) — tests that want a saturated opt-in scan must override both.
      capApplied: false,
      scanCap: API_SCAN_CAP,
      ...overrides,
    },
  };
}

function manyGatewayRows(count: number): ViolationGatewayRow[] {
  return Array.from({ length: count }, (_, i) =>
    gatewayRow({
      gatewayId: `!${i.toString(16).padStart(8, '0')}`,
      gatewayNodeNum: i,
    }),
  );
}

function packetRow(overrides: Partial<ViolationPacketRow> = {}): ViolationPacketRow {
  return {
    id: 1,
    kind: 'confirmed',
    sourceId: 'mqtt-a',
    packetId: 12345,
    fromNode: 0x11223344,
    fromNodeId: '!11223344',
    fromLongName: null,
    fromShortName: null,
    gatewayId: '!433e0f28',
    gatewayNodeNum: 0x433e0f28,
    gatewayLongName: null,
    gatewayShortName: null,
    channelId: 'LongFast',
    portnum: 1,
    portnumName: 'TEXT_MESSAGE_APP',
    bitfield: 0,
    topic: 'msh/US/2/e/LongFast/!433e0f28',
    rxTime: Date.UTC(2026, 6, 20, 12, 0, 0),
    timestamp: Date.UTC(2026, 6, 20, 12, 0, 1),
    ...overrides,
  };
}

function packetsResponse(overrides: Partial<ViolationPacketsResponse> = {}): {
  success: true;
  data: ViolationPacketsResponse;
} {
  return {
    success: true,
    data: {
      violations: [],
      total: 0,
      limit: 100,
      offset: 0,
      since: Date.UTC(2026, 6, 17),
      until: Date.UTC(2026, 6, 24),
      includeUnknown: false,
      suspectedAvailable: false,
      suspectedWindowMs: 0,
      sources: ['mqtt-a'],
      gateway: '!433e0f28',
      capApplied: false,
      scanCap: API_SCAN_CAP,
      ...overrides,
    },
  };
}

function urlOf(mockFn: ReturnType<typeof vi.fn>, callIndex = 0): string {
  return mockFn.mock.calls[callIndex][0] as string;
}

/** Route the shared `api.get` mock by which endpoint the URL hits. */
function routeApiGet(
  gateways: () => ReturnType<typeof baseResponse> | Promise<ReturnType<typeof baseResponse>>,
  packets: () => ReturnType<typeof packetsResponse> | Promise<ReturnType<typeof packetsResponse>>,
) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.includes('/mqtt-violations/packets')) return packets();
    return gateways();
  });
}

describe('MqttViolationsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test 1: pre-run defers — no request fires on mount', async () => {
    renderReport();
    expect(
      await screen.findByText(/Choose a window and press Run report/i),
    ).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('test 2: Run fires exactly one request with default params', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(baseResponse());
    renderReport();

    await user.click(screen.getByRole('button', { name: /Run report/i }));

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    const url = urlOf(vi.mocked(api.get));
    expect(url).toContain('/api/analysis/mqtt-violations/gateways?');
    expect(url).toContain('lookbackDays=7');
    expect(url).toContain('sort=violationCount');
    expect(url).toContain('dir=desc');
    expect(url).toContain('limit=50');
    expect(url).toContain('offset=0');
    expect(url).not.toContain('includeUnknown');
  });

  it('test 3: gateway summary renders from body.data (envelope unwrapped)', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [
          gatewayRow({ gatewayId: '!433e0f28', violationCount: 5 }),
          gatewayRow({ gatewayId: '!aabbccdd', gatewayNodeNum: 0xaabbccdd, violationCount: 3 }),
        ],
        total: 2,
      }),
    );
    const { container } = renderReport();

    await user.click(screen.getByRole('button', { name: /Run report/i }));

    expect(await screen.findByText('!433e0f28')).toBeInTheDocument();
    expect(screen.getByText('!aabbccdd')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    const statValues = Array.from(container.querySelectorAll('.reports-stat__value')).map(
      (el) => el.textContent,
    );
    // Gateways / Confirmed violations / Originators affected (no Suspected tile — toggle off)
    expect(statValues).toEqual(['2', '8', '4']);
  });

  it('test 4: sorting issues the right params and resets offset', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({ gateways: [gatewayRow()], total: 1 }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Confirmed' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    let url = urlOf(vi.mocked(api.get), 1);
    expect(url).toContain('sort=violationCount');
    expect(url).toContain('dir=asc');
    expect(url).toContain('offset=0');

    await user.click(screen.getByRole('button', { name: 'Last seen' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    url = urlOf(vi.mocked(api.get), 2);
    expect(url).toContain('sort=lastSeen');
    expect(url).toContain('dir=desc');
    expect(url).toContain('offset=0');
  });

  it('test 5: unwhitelisted columns render no sort button', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow({ violationCount: 0, suspectedCount: 4 })],
        total: 1,
        includeUnknown: true,
        suspectedAvailable: true,
        suspectedWindowMs: 86_400_000,
      }),
    );
    renderReport();
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    await screen.findByRole('table');
    const table = screen.getByRole('table');
    const headerRow = within(table).getAllByRole('row')[0];

    const suspectedTh = within(headerRow).getByText('Suspected').closest('th')!;
    expect(within(suspectedTh).queryByRole('button')).not.toBeInTheDocument();

    const firstSeenTh = within(headerRow).getByText('First seen').closest('th')!;
    expect(within(firstSeenTh).queryByRole('button')).not.toBeInTheDocument();

    const sourcesTh = within(headerRow).getByText('Sources').closest('th')!;
    expect(within(sourcesTh).queryByRole('button')).not.toBeInTheDocument();
  });

  it('test 6: pagination — page label, Next offset, and page-size change', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({ gateways: [gatewayRow()], total: 130, limit: 50, offset: 0 }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(urlOf(vi.mocked(api.get), 1)).toContain('offset=50');

    await user.selectOptions(screen.getByRole('combobox', { name: /Rows per page/i }), '25');
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    const url = urlOf(vi.mocked(api.get), 2);
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=0');
  });

  // #4332 follow-up: changing the summary's page size left drill.offset
  // untouched, so an expanded gateway could be stranded on a drill-down page
  // that no longer exists for its own result set (empty for no visible
  // reason). Changing the page size must reset it back to 0.
  it('test 6b: changing the summary page size resets the drill-down offset', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow()], total: 1 }),
      () => packetsResponse({ violations: [packetRow()], total: 250, limit: 100, offset: 0 }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);
    await screen.findByText('violation');
    expect(api.get).toHaveBeenCalledTimes(2);

    // Advance the drill-down to offset=100 (page 2) before touching the
    // summary's page size.
    const detailCell = screen.getByText(/Violating packets published by/i).closest('td')!;
    await user.click(within(detailCell).getByRole('button', { name: /^Next$/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(urlOf(vi.mocked(api.get), 2)).toContain('offset=100');

    // Changing the summary's page size must reset drill.offset back to 0 —
    // the next packets request should carry offset=0 again, not the stale 100.
    await user.selectOptions(screen.getByRole('combobox', { name: /Rows per page/i }), '25');
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(5)); // gateways refetch + packets refetch
    const packetsCalls = vi
      .mocked(api.get)
      .mock.calls.filter((call) => String(call[0]).includes('/mqtt-violations/packets'));
    const lastPacketsUrl = String(packetsCalls[packetsCalls.length - 1][0]);
    expect(lastPacketsUrl).toContain('offset=0');
  });

  // #4330: capApplied must gate everything cap-related — never `total >= cap`.
  // Prior to the fix this test asserted the old `total >= API_SCAN_CAP`
  // inference without ever setting `capApplied`; it now explicitly opts in
  // (`capApplied: true`), which is the only case (opt-in scan that actually
  // saturated) where the server ever reports it.
  it('test 7: opt-in capApplied=true — 2,000+ label, cap warnings, and clamped pager', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow()],
        total: 5000,
        limit: 50,
        offset: 0,
        includeUnknown: true,
        capApplied: true,
      }),
    );
    renderReport();
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    expect(await screen.findByText(/2,000\+ gateways/)).toBeInTheDocument();
    expect(screen.getByText(/Showing the first 2,000 rows/i)).toBeInTheDocument();
    expect(screen.queryByText(/Sorting ascending inside a capped scan/i)).not.toBeInTheDocument();
    // 2000 reachable / 50 per page = 40 pages max; Next must be enabled on page 1.
    expect(screen.getByText('Page 1 of 40')).toBeInTheDocument();

    // Flip to ascending (click the active Confirmed sort column) and re-check.
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow()],
        total: 5000,
        limit: 50,
        offset: 0,
        includeUnknown: true,
        capApplied: true,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirmed' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(/Sorting ascending inside a capped scan/i),
    ).toBeInTheDocument();
  });

  it('test 7b (#4330 regression): default path, total above scanCap but capApplied=false renders the real total, offers real paging, and shows no cap warnings', async () => {
    const user = userEvent.setup();
    // 2,268 mirrors the live-system number cited in issue #4330 — every row
    // is reachable on the default path even though it exceeds the 2,000 cap.
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow()],
        total: 2268,
        limit: 50,
        offset: 0,
        capApplied: false,
      }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    // Real total, not the old "2,000+" clamp.
    expect(await screen.findByText('2,268 gateways')).toBeInTheDocument();
    expect(screen.queryByText(/2,000\+ gateways/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the first 2,000 rows/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sorting ascending inside a capped scan/i)).not.toBeInTheDocument();
    // Paging reaches past the old 2000-row/40-page clamp: ceil(2268/50) = 46.
    expect(screen.getByText('Page 1 of 46')).toBeInTheDocument();

    // Ascending sort must not trigger the "capped scan" caveat either — no
    // rows were dropped before ordering on this path.
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow()],
        total: 2268,
        limit: 50,
        offset: 0,
        capApplied: false,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirmed' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('2,268 gateways')).toBeInTheDocument();
    expect(screen.queryByText(/Sorting ascending inside a capped scan/i)).not.toBeInTheDocument();
    expect(screen.getByText('Page 1 of 46')).toBeInTheDocument();
  });

  it('test 7c: opt-in response with capApplied=false renders no cap warnings', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow()],
        total: 2268,
        limit: 50,
        offset: 0,
        includeUnknown: true,
        suspectedAvailable: true,
        capApplied: false,
      }),
    );
    renderReport();
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    expect(await screen.findByText('2,268 gateways')).toBeInTheDocument();
    expect(screen.queryByText(/2,000\+ gateways/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the first 2,000 rows/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sorting ascending inside a capped scan/i)).not.toBeInTheDocument();
  });

  it('test 8: includeUnknown toggle changes request and rendering', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(baseResponse({ gateways: [], total: 0 }));
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow({ violationCount: 0, suspectedCount: 5 })],
        total: 1,
        includeUnknown: true,
        suspectedAvailable: true,
        suspectedWindowMs: 86_400_000,
      }),
    );
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));
    await user.click(screen.getByRole('button', { name: /Re-run report/i }));

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(urlOf(vi.mocked(api.get), 1)).toContain('includeUnknown=true');
    expect(await screen.findByRole('columnheader', { name: 'Suspected' })).toBeInTheDocument();
    const suspectedOnlyRow = screen.getByText('!433e0f28').closest('tr')!;
    expect(suspectedOnlyRow).toHaveAttribute('data-suspected-only', 'true');
    // cells: [chevron, gateway, confirmed, suspected, originators, sources, firstSeen, lastSeen]
    const cells = within(suspectedOnlyRow).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('0');
    expect(cells[3]).toHaveTextContent('5');
    expect(
      await screen.findByText(/only reach back 24 h, while confirmed violations/i),
    ).toBeInTheDocument();

    // Toggle off + re-run removes the suspected column, the caveat, and the muted rows.
    vi.mocked(api.get).mockResolvedValue(baseResponse({ gateways: [], total: 0 }));
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));
    await user.click(screen.getByRole('button', { name: /Re-run report/i }));

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(urlOf(vi.mocked(api.get), 2)).not.toContain('includeUnknown');
    await waitFor(() =>
      expect(
        screen.queryByRole('columnheader', { name: 'Suspected' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/only reach back 24 h, while confirmed violations/i),
    ).not.toBeInTheDocument();
  });

  it('test 11: suspectedAvailable trap — default params render no availability text', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow()],
        total: 1,
        includeUnknown: false,
        suspectedAvailable: false,
        suspectedWindowMs: 0,
      }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    expect(
      screen.queryByText(/Suspected rows need the MQTT packet monitor/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Suspected rows are not proven violations/i)).not.toBeInTheDocument();
  });

  it('test 11b: includeUnknown=true, suspectedAvailable=false renders the unavailable hint', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({
        gateways: [gatewayRow()],
        total: 1,
        includeUnknown: true,
        suspectedAvailable: false,
        suspectedWindowMs: 0,
      }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    expect(
      await screen.findByText(/Suspected rows need the MQTT packet monitor/i),
    ).toBeInTheDocument();
  });

  it('test 12: empty = good news, not an error', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(
      baseResponse({ gateways: [], total: 0, sources: ['mqtt-a'] }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    expect(
      await screen.findByText(/No ok_to_mqtt violations in the selected window/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/On a healthy network that is the expected result/i)).toBeInTheDocument();
    expect(screen.getByText(/Detection is forward-only/i)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to read/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Suspected rows need the MQTT packet monitor/i),
    ).not.toBeInTheDocument();
  });

  it('test 13: zero permission is distinguished from good-news empty', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(baseResponse({ gateways: [], total: 0, sources: [] }));
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    expect(await screen.findByText('No sources available to you.')).toBeInTheDocument();
    expect(
      screen.getByText(/This report reads the MQTT sources you have packet-monitor read access/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/On a healthy network that is the expected result/i),
    ).not.toBeInTheDocument();
  });

  it('test 14: error code mapping', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockRejectedValueOnce(
      new ApiError('boom', 500, { code: 'MQTT_VIOLATIONS_FETCH_FAILED' }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    expect(
      await screen.findByText('Failed to read ok_to_mqtt violation history.'),
    ).toBeInTheDocument();
  });

  it('test 14b: INVALID_SORT_FIELD and no-code errors map correctly', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockRejectedValueOnce(
      new ApiError('bad sort', 400, { code: 'INVALID_SORT_FIELD' }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    expect(await screen.findByText('That column cannot be sorted.')).toBeInTheDocument();
  });

  it('test 14c: an error with no code falls back to the raw message', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockRejectedValueOnce(new Error('network exploded'));
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    expect(await screen.findByText('network exploded')).toBeInTheDocument();
  });

  it('test 15: client-side range guard disables Run and shows the inline error', async () => {
    renderReport();

    const fromInput = screen.getByLabelText('From');
    const toInput = screen.getByLabelText('To');
    // Native date inputs don't behave well with userEvent.type in jsdom;
    // fireEvent.change is the Testing Library-recommended approach for them.
    fireEvent.change(fromInput, { target: { value: '2026-07-20' } });
    fireEvent.change(toInput, { target: { value: '2026-07-10' } });

    expect(screen.getByRole('button', { name: /Run report/i })).toBeDisabled();
    expect(
      await screen.findByText('The start date must be on or before the end date.'),
    ).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('test 17: filters are draft-gated — no request until Run is (re-)pressed', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue(baseResponse({ gateways: [gatewayRow()], total: 1 }));
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /30 days/i }));
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));

    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('test 9: drill-down fetch + render; collapsing fires no third request', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow()], total: 1 }),
      () =>
        packetsResponse({
          violations: [
            packetRow({ kind: 'confirmed' }),
            packetRow({ id: 2, packetId: 999, kind: 'suspected', bitfield: null }),
          ],
          total: 2,
        }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');
    expect(api.get).toHaveBeenCalledTimes(1);

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    const url = urlOf(vi.mocked(api.get), 1);
    expect(url).toContain('/api/analysis/mqtt-violations/packets?');
    // URLSearchParams percent-encodes '!' as %21 (unlike encodeURIComponent).
    expect(url).toContain('gateway=%21433e0f28');
    expect(url).toContain('sort=timestamp');
    expect(url).toContain('dir=desc');
    expect(url).toContain('limit=100');
    expect(url).toContain('offset=0');

    // Reused marker: 'violation' for the confirmed row, 'unknown' for the suspected one.
    expect(await screen.findByText('violation')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();

    // Collapse — no third request, and the drill-down content disappears.
    await user.click(row);
    await waitFor(() => expect(screen.queryByText('violation')).not.toBeInTheDocument());
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('test 10a: drill-down loading state renders without unmounting the summary', async () => {
    const user = userEvent.setup();
    let resolvePackets!: (value: ReturnType<typeof packetsResponse>) => void;
    const pending = new Promise<ReturnType<typeof packetsResponse>>((resolve) => {
      resolvePackets = resolve;
    });
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow()], total: 1 }),
      () => pending,
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);

    expect(await screen.findByText('Loading packets…')).toBeInTheDocument();
    expect(screen.getByText('!433e0f28')).toBeInTheDocument();

    resolvePackets(packetsResponse({ violations: [], total: 0 }));
    await waitFor(() => expect(screen.queryByText('Loading packets…')).not.toBeInTheDocument());
  });

  it('test 10b: drill-down error state maps the code and keeps the summary rendered', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow()], total: 1 }),
      () => {
        throw new ApiError('boom', 500, { code: 'MQTT_VIOLATIONS_FETCH_FAILED' });
      },
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);

    expect(
      await screen.findByText('Failed to read ok_to_mqtt violation history.'),
    ).toBeInTheDocument();
    expect(screen.getByText('!433e0f28')).toBeInTheDocument();
  });

  it('test 10c: drill-down empty state shows the hint when unproven rows are hidden', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow()], total: 1 }),
      () => packetsResponse({ violations: [], total: 0 }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);

    expect(
      await screen.findByText('No individual rows for this gateway in this window.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Unproven receptions are hidden/i)).toBeInTheDocument();
  });

  it('test 10d: drill-down empty state omits the hint when unproven rows are included', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () =>
        baseResponse({
          gateways: [gatewayRow()],
          total: 1,
          includeUnknown: true,
          suspectedAvailable: true,
          suspectedWindowMs: 86_400_000,
        }),
      () =>
        packetsResponse({
          violations: [],
          total: 0,
          includeUnknown: true,
          suspectedAvailable: true,
          suspectedWindowMs: 86_400_000,
        }),
    );
    renderReport();
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);

    expect(
      await screen.findByText('No individual rows for this gateway in this window.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unproven receptions are hidden/i)).not.toBeInTheDocument();
  });

  it('test 16: gateway CSV export re-fetches the full set (limit=2000) and reports the cap', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('limit=2000')) {
        return baseResponse({ gateways: manyGatewayRows(2000), total: 3412, limit: 2000, offset: 0 });
      }
      return baseResponse({ gateways: [gatewayRow()], total: 1 });
    });
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    await user.click(screen.getByRole('button', { name: /Export CSV/i }));

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    const exportUrl = urlOf(vi.mocked(api.get), 1);
    expect(exportUrl).toContain('/api/analysis/mqtt-violations/gateways?');
    expect(exportUrl).toContain('limit=2000');
    expect(exportUrl).toContain('offset=0');

    // Both a dismissable banner and a toast render the same message —
    // assert at least one instance rather than assuming exactly one.
    await waitFor(() => expect(screen.getAllByText(/2,000 of 3,412/).length).toBeGreaterThan(0));
    expect(downloadTextFile).toHaveBeenCalledTimes(1);
    const [filename, csv, mimeType] = vi.mocked(downloadTextFile).mock.calls[0];
    expect(filename).toMatch(/^mqtt-oktomqtt-violations-gateways-.*\.csv$/);
    expect(filename).not.toContain(':');
    expect(mimeType).toBe('text/csv');
    // Name columns sit next to the id they describe, which shifts every later
    // column's position — intentional, see GATEWAY_CSV_COLUMNS.
    expect(csv.split('\r\n')[0]).toBe('Gateway ID,Gateway Node Num,Gateway Long Name,Gateway Short Name,Violation Count,Suspected Count,Distinct Originators,Source IDs,Broker Class,First Seen,Last Seen');
    expect(csv).toContain('!00000000');
  });

  it('test 16b: drill-down CSV export re-fetches the full set (limit=2000) for that gateway', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/mqtt-violations/packets') && url.includes('limit=2000')) {
        return packetsResponse({
          violations: [packetRow(), packetRow({ id: 2, packetId: 998 })],
          total: 2,
        });
      }
      if (url.includes('/mqtt-violations/packets')) {
        return packetsResponse({ violations: [packetRow()], total: 1 });
      }
      return baseResponse({ gateways: [gatewayRow()], total: 1 });
    });
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);
    await screen.findByText('violation');

    const exportButtons = screen.getAllByRole('button', { name: /Export CSV/i });
    // [0] = gateway-summary export in the controls row; the drill-down's own
    // export button is the last one rendered (inside the expanded detail cell).
    await user.click(exportButtons[exportButtons.length - 1]);

    await waitFor(() => expect(downloadTextFile).toHaveBeenCalledTimes(1));
    const [filename, csv] = vi.mocked(downloadTextFile).mock.calls[0];
    expect(filename).toMatch(/^mqtt-oktomqtt-violations-433e0f28-.*\.csv$/);
    expect(filename).not.toContain('!');
    expect(csv).toContain('confirmed');
    const exportCall = vi
      .mocked(api.get)
      .mock.calls.find(
        (call) => String(call[0]).includes('/mqtt-violations/packets') && String(call[0]).includes('limit=2000'),
      );
    expect(exportCall).toBeDefined();
  });

  // #4332 follow-up: the export request limit and its honesty message must
  // come from the most recently loaded response's `scanCap`, not the local
  // API_SCAN_CAP constant — otherwise the two can silently drift apart.
  it('test 16c: gateway CSV export uses the loaded response\'s scanCap, not the local constant', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('limit=500')) {
        return baseResponse({
          gateways: manyGatewayRows(500),
          total: 600,
          limit: 500,
          offset: 0,
          scanCap: 500,
        });
      }
      // Initial summary load — scanCap: 500 is the server's echoed cap for
      // this (hypothetical) window, deliberately different from the local
      // API_SCAN_CAP (2000) so a test using the wrong source of truth fails.
      return baseResponse({ gateways: [gatewayRow()], total: 1, scanCap: 500 });
    });
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    await user.click(screen.getByRole('button', { name: /Export CSV/i }));

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    const exportUrl = urlOf(vi.mocked(api.get), 1);
    expect(exportUrl).toContain('/api/analysis/mqtt-violations/gateways?');
    expect(exportUrl).toContain('limit=500');
    expect(exportUrl).not.toContain('limit=2000');

    // capped because exported(500) >= scanCap(500); the message must quote
    // 500, not the local 2000 constant.
    await waitFor(() =>
      expect(screen.getAllByText(/500 of 600 matching rows/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/2,000 rows/)).not.toBeInTheDocument();
  });

  it('test 16d: drill-down CSV export uses the packets response\'s scanCap, not the summary\'s', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/mqtt-violations/packets') && url.includes('limit=300')) {
        return packetsResponse({
          violations: [packetRow(), packetRow({ id: 2, packetId: 998 })],
          total: 400,
          scanCap: 300,
        });
      }
      if (url.includes('/mqtt-violations/packets')) {
        // Drill-down's own live query — scanCap: 300, deliberately different
        // from the summary's scanCap: 500 below, to prove the export reads
        // packetsQuery.data, not data.
        return packetsResponse({ violations: [packetRow()], total: 1, scanCap: 300 });
      }
      return baseResponse({ gateways: [gatewayRow()], total: 1, scanCap: 500 });
    });
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);
    await screen.findByText('violation');

    const exportButtons = screen.getAllByRole('button', { name: /Export CSV/i });
    await user.click(exportButtons[exportButtons.length - 1]);

    await waitFor(() => expect(downloadTextFile).toHaveBeenCalledTimes(1));
    const exportCall = vi
      .mocked(api.get)
      .mock.calls.find(
        (call) => String(call[0]).includes('/mqtt-violations/packets') && String(call[0]).includes('limit=300'),
      );
    expect(exportCall).toBeDefined();
    const noWrongCapCall = vi
      .mocked(api.get)
      .mock.calls.find(
        (call) => String(call[0]).includes('/mqtt-violations/packets') && String(call[0]).includes('limit=500'),
      );
    expect(noWrongCapCall).toBeUndefined();

    // capped because exported(2) < scanCap(300) but total(400) > exported(2).
    await waitFor(() =>
      expect(screen.getAllByText(/2 of 400 matching rows/).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(/300 rows/).length).toBeGreaterThan(0);
  });

  it('test 9b (#4330 regression): drill-down default path, total above scanCap but capApplied=false renders the real total/pager and no cap warnings', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow()], total: 1 }),
      () =>
        packetsResponse({
          violations: [packetRow()],
          total: 3000,
          limit: 100,
          offset: 0,
          capApplied: false,
        }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);
    await screen.findByText('violation');

    const detailCell = screen.getByText(/Violating packets published by/i).closest('td')!;
    // ceil(3000/100) = 30 pages, well past the old 20-page (2000/100) clamp.
    expect(within(detailCell).getByText('Page 1 of 30')).toBeInTheDocument();
    expect(
      within(detailCell).queryByText(/Showing the first 2,000 rows/i),
    ).not.toBeInTheDocument();
    expect(
      within(detailCell).queryByText(/Sorting ascending inside a capped scan/i),
    ).not.toBeInTheDocument();
  });

  it('test 9c: drill-down opt-in capApplied=true renders the cap warning, clamped pager, and ascending variant', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () =>
        baseResponse({
          gateways: [gatewayRow()],
          total: 1,
          includeUnknown: true,
          suspectedAvailable: true,
        }),
      () =>
        packetsResponse({
          violations: [packetRow()],
          total: 5000,
          limit: 100,
          offset: 0,
          includeUnknown: true,
          suspectedAvailable: true,
          capApplied: true,
        }),
    );
    renderReport();
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);
    await screen.findByText('violation');

    const detailCell = screen.getByText(/Violating packets published by/i).closest('td')!;
    expect(
      within(detailCell).getByText(/Showing the first 2,000 rows/i),
    ).toBeInTheDocument();
    // 2000 reachable / 100 per page = 20 pages.
    expect(within(detailCell).getByText('Page 1 of 20')).toBeInTheDocument();
    expect(
      within(detailCell).queryByText(/Sorting ascending inside a capped scan/i),
    ).not.toBeInTheDocument();

    // Time is the drill-down's default active sort (desc) — one click flips it to asc.
    await user.click(within(detailCell).getByRole('button', { name: 'Time' }));
    expect(
      await within(detailCell).findByText(/Sorting ascending inside a capped scan/i),
    ).toBeInTheDocument();
  });

  it('test 9d: drill-down opt-in capApplied=false renders no cap warnings', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () =>
        baseResponse({
          gateways: [gatewayRow()],
          total: 1,
          includeUnknown: true,
          suspectedAvailable: true,
        }),
      () =>
        packetsResponse({
          violations: [packetRow()],
          total: 3000,
          limit: 100,
          offset: 0,
          includeUnknown: true,
          suspectedAvailable: true,
          capApplied: false,
        }),
    );
    renderReport();
    await user.click(screen.getByRole('checkbox', { name: /Include unproven/i }));
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);
    await screen.findByText('violation');

    const detailCell = screen.getByText(/Violating packets published by/i).closest('td')!;
    expect(
      within(detailCell).queryByText(/Showing the first 2,000 rows/i),
    ).not.toBeInTheDocument();
    expect(
      within(detailCell).queryByText(/Sorting ascending inside a capped scan/i),
    ).not.toBeInTheDocument();
    expect(within(detailCell).getByText('Page 1 of 30')).toBeInTheDocument();
  });

  it('test 18: aria-expanded lives on the expand button, not the <tr> (role="row" doesn\'t support it)', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow()], total: 1 }),
      () => packetsResponse({ violations: [packetRow()], total: 1 }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');

    const row = screen.getByText('!433e0f28').closest('tr')!;
    expect(row).not.toHaveAttribute('aria-expanded');

    const expandButton = within(row).getByRole('button', { name: /Show violating packets/i });
    expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    // Coordinator's other ask: the control needs an accessible name of its
    // own — it's an icon-only button, so this would otherwise be silent.
    expect(expandButton).toHaveAccessibleName();

    await user.click(expandButton);

    // Flips to true, the drill-down renders, and the row still carries no
    // aria-expanded — and, since the button's own click handler
    // stopPropagation()s, clicking it doesn't also fire the row's onClick
    // and toggle a second time (which would net out to "nothing happened").
    await waitFor(() => expect(expandButton).toHaveAttribute('aria-expanded', 'true'));
    expect(row).not.toHaveAttribute('aria-expanded');
    expect(await screen.findByText('violation')).toBeInTheDocument();
  });

  it('test 19: drill-down rows sharing sourceId/packetId/timestamp across confirmed+suspected still render distinctly (kind-qualified key)', async () => {
    const user = userEvent.setup();
    const sharedTimestamp = Date.UTC(2026, 6, 20, 12, 0, 1);
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow()], total: 1 }),
      () =>
        packetsResponse({
          violations: [
            // Same id/sourceId/packetId/timestamp on purpose — this is the
            // exact pair the old `${sourceId}-${packetId}-${timestamp}` key
            // (with no `kind`) collided on when includeUnknown merges the
            // durable-violations table with the packet log.
            packetRow({
              id: 1,
              kind: 'confirmed',
              sourceId: 'mqtt-a',
              packetId: 12345,
              timestamp: sharedTimestamp,
              bitfield: 0,
            }),
            packetRow({
              id: 1,
              kind: 'suspected',
              sourceId: 'mqtt-a',
              packetId: 12345,
              timestamp: sharedTimestamp,
              bitfield: null,
            }),
          ],
          total: 2,
        }),
    );
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!433e0f28');
    const row = screen.getByText('!433e0f28').closest('tr')!;
    await user.click(row);

    // Both rows render distinctly — one via the marker's 'violation' text,
    // the other via 'unknown' — rather than React collapsing them.
    expect(await screen.findByText('violation')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();

    const duplicateKeyWarning = consoleErrorSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('same key')),
    );
    expect(duplicateKeyWarning).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  // The report used to label every row with its raw `!hex` id, which for most
  // rows was all the reader ever saw.
  describe('node names', () => {
    it('shows the gateway name as the row label, with the id kept beneath it', async () => {
      const user = userEvent.setup();
      vi.mocked(api.get).mockResolvedValue(
        baseResponse({
          gateways: [
            gatewayRow({
              gatewayId: '!433e0f28',
              gatewayLongName: 'Yeraze Station G2',
              gatewayShortName: 'YRZE',
            }),
          ],
          total: 1,
        }),
      );
      renderReport();
      await user.click(screen.getByRole('button', { name: /Run report/i }));

      const name = await screen.findByText('Yeraze Station G2');
      expect(name).toBeInTheDocument();
      expect(name.className).toContain('reports-node__name');

      // The id is still on screen — a named row must stay traceable back to
      // the gateway it came from.
      const id = screen.getByText('!433e0f28');
      expect(id.className).toContain('reports-node__meta');
    });

    it('falls back to the short name when only that is known', async () => {
      const user = userEvent.setup();
      vi.mocked(api.get).mockResolvedValue(
        baseResponse({
          gateways: [gatewayRow({ gatewayLongName: null, gatewayShortName: 'YRZE' })],
          total: 1,
        }),
      );
      renderReport();
      await user.click(screen.getByRole('button', { name: /Run report/i }));

      expect(await screen.findByText('YRZE')).toBeInTheDocument();
    });

    it('still shows the id for a gateway with no NodeInfo, as before', async () => {
      const user = userEvent.setup();
      vi.mocked(api.get).mockResolvedValue(
        baseResponse({
          gateways: [gatewayRow({ gatewayLongName: null, gatewayShortName: null })],
          total: 1,
        }),
      );
      renderReport();
      await user.click(screen.getByRole('button', { name: /Run report/i }));

      const id = await screen.findByText('!433e0f28');
      expect(id.className).toContain('reports-node__name');
    });

    it('names the originating node in the drill-down too', async () => {
      const user = userEvent.setup();
      vi.mocked(api.get).mockImplementation(async (url: string) => {
        if (url.includes('/mqtt-violations/packets')) {
          return packetsResponse({
            violations: [
              packetRow({ fromLongName: 'Atlas Solar', fromShortName: 'ATLS' }),
            ],
            total: 1,
          });
        }
        return baseResponse({
          gateways: [gatewayRow({ gatewayLongName: 'Gateway One' })],
          total: 1,
        });
      });
      renderReport();
      await user.click(screen.getByRole('button', { name: /Run report/i }));

      const row = (await screen.findByText('Gateway One')).closest('tr')!;
      await user.click(row);

      expect(await screen.findByText('Atlas Solar')).toBeInTheDocument();
      // ...and its id remains available beneath the name.
      expect(screen.getByText('!11223344')).toBeInTheDocument();
    });
  });
});

// ── #4982: private-broker false-positive annotation ────────────────────────
describe('MqttViolationsReport — broker classification (#4982)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('badges each gateway row with its brokerClass label', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () =>
        baseResponse({
          gateways: [
            gatewayRow({ gatewayId: '!11111111', brokerClass: 'private' }),
            gatewayRow({ gatewayId: '!22222222', brokerClass: 'public' }),
            gatewayRow({ gatewayId: '!33333333', brokerClass: 'unknown' }),
          ],
          total: 3,
        }),
      () => packetsResponse({ violations: [], total: 0 }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    expect(await screen.findByText('Expected — private broker')).toBeInTheDocument();
    expect(screen.getByText('Confirmed — public broker')).toBeInTheDocument();
    expect(screen.getByText('Unverified — hostname broker')).toBeInTheDocument();
  });

  it('shows the non-dismissible explanatory banner whenever there are results', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () => baseResponse({ gateways: [gatewayRow({ brokerClass: 'public' })], total: 1 }),
      () => packetsResponse({ violations: [], total: 0 }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));

    expect(
      await screen.findByText('Not every relay here is a proven violation'),
    ).toBeInTheDocument();
    // No dismiss/close control on this banner — it's explanatory, not a warning to ack.
    expect(
      screen.queryByRole('button', { name: /dismiss/i }),
    ).not.toBeInTheDocument();
  });

  it('"Hide expected" filter hides private-broker rows and updates the visible stats, without an extra fetch', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () =>
        baseResponse({
          gateways: [
            gatewayRow({
              gatewayId: '!11111111',
              brokerClass: 'private',
              violationCount: 5,
            }),
            gatewayRow({
              gatewayId: '!22222222',
              brokerClass: 'public',
              violationCount: 3,
            }),
          ],
          total: 2,
        }),
      () => packetsResponse({ violations: [], total: 0 }),
    );
    const { container } = renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!11111111');
    expect(screen.getByText('!22222222')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);

    const statValues = () =>
      Array.from(container.querySelectorAll('.reports-stat__value')).map((el) => el.textContent);
    // Before filtering: Gateways=2, Confirmed=8 (5+3), Originators=4 (2+2).
    expect(statValues()).toEqual(['2', '8', '4']);

    await user.click(
      screen.getByRole('checkbox', { name: /Hide expected \(private broker\)/i }),
    );

    // Purely client-side — no second request fired by toggling the filter.
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('!11111111')).not.toBeInTheDocument();
    expect(screen.getByText('!22222222')).toBeInTheDocument();
    // "Gateways" stays the server total (unaffected); Confirmed/Originators
    // now sum only the visible (public) row: violationCount 3, originators 2.
    expect(statValues()).toEqual(['2', '3', '2']);

    // Toggling back off restores the hidden row.
    await user.click(
      screen.getByRole('checkbox', { name: /Hide expected \(private broker\)/i }),
    );
    expect(screen.getByText('!11111111')).toBeInTheDocument();
    expect(statValues()).toEqual(['2', '8', '4']);
  });

  it('shows an explanatory empty row when the filter hides every row on the page', async () => {
    const user = userEvent.setup();
    routeApiGet(
      () =>
        baseResponse({
          gateways: [gatewayRow({ gatewayId: '!11111111', brokerClass: 'private' })],
          total: 1,
        }),
      () => packetsResponse({ violations: [], total: 0 }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    await screen.findByText('!11111111');

    await user.click(
      screen.getByRole('checkbox', { name: /Hide expected \(private broker\)/i }),
    );

    expect(screen.queryByText('!11111111')).not.toBeInTheDocument();
    expect(
      await screen.findByText(/Every gateway on this page is a private-broker relay hidden/i),
    ).toBeInTheDocument();
  });

  it('drill-down packet rows are badged with their own brokerClass', async () => {
    const user = userEvent.setup();
    routeApiGet(
      // Gateway row itself is 'unknown' so its own badge can't collide with
      // the drill-down packet rows' 'private'/'public' badges below.
      () => baseResponse({ gateways: [gatewayRow({ brokerClass: 'unknown' })], total: 1 }),
      () =>
        packetsResponse({
          violations: [
            packetRow({ id: 1, packetId: 1, sourceId: 'mqtt-private', brokerClass: 'private' }),
            packetRow({ id: 2, packetId: 2, sourceId: 'mqtt-public', brokerClass: 'public' }),
          ],
          total: 2,
        }),
    );
    renderReport();
    await user.click(screen.getByRole('button', { name: /Run report/i }));
    const row = (await screen.findByText('!433e0f28')).closest('tr')!;
    await user.click(row);

    expect(await screen.findByText('Expected — private broker')).toBeInTheDocument();
    expect(screen.getByText('Confirmed — public broker')).toBeInTheDocument();
  });
});
