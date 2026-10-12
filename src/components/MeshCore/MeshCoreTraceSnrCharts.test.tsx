/**
 * MeshCoreTraceSnrCharts + its chart helpers (#5765).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const getMock = vi.fn();
// Mocked the way the panel's own tests mock it: no ApiError export.
vi.mock('../../services/api', () => ({ default: { get: (...a: unknown[]) => getMock(...a) } }));

// recharts' ResponsiveContainer measures a 0x0 box in jsdom and draws nothing,
// so stand in for it. The LineChart stub exposes the rows it was given, and the
// Tooltip stub runs the real formatters.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children, data }: { children?: ReactNode; data: Array<{ snr: number | null }> }) => (
    <div data-testid="line-chart" data-rows={data.length} data-gaps={data.filter((d) => d.snr === null).length}>{children}</div>
  ),
  Line: ({ stroke }: { stroke: string }) => <span data-testid="line" data-stroke={stroke} />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ formatter, labelFormatter }: {
    formatter: (v: unknown) => [string, string];
    labelFormatter: (v: unknown) => string;
  }) => (
    <span data-testid="tooltip" data-value={formatter(1.5).join('|')} data-label={labelFormatter(Date.UTC(2026, 0, 2, 3, 4, 5))} />
  ),
}));

import { MeshCoreTraceSnrCharts } from './MeshCoreTraceSnrCharts';
import {
  summarizeHopSnrLinks, hopSnrChartData, hopSnrEndName,
  HOP_SNR_CHART_GAP_MS, HOP_SNR_CHART_POINTS, HOP_SNR_MAX_POINTS_PER_LINK, HOP_SNR_POINTS_PER_LINK,
  type HopSnrSample, type HopSnrTranslate,
} from '../../utils/meshcoreHopSnr';

const ME = 'a'.repeat(64);
const REP = 'b'.repeat(64);
const LOCAL = 'c'.repeat(64);

const sample = (over: Partial<HopSnrSample> = {}): HopSnrSample => ({
  senderPublicKey: ME, senderHash: 'aa', senderCandidates: 1,
  receiverPublicKey: REP, receiverHash: 'bb', receiverCandidates: 1,
  snrQuarterDb: 20, initiated: false, timestamp: 1000, ...over,
});

describe('summarizeHopSnrLinks point cap (#5765)', () => {
  const many = Array.from({ length: 300 }, (_, i) => sample({ timestamp: i }));

  it('keeps the newest N samples for the cap asked for', () => {
    expect(summarizeHopSnrLinks(many)[0].points).toHaveLength(HOP_SNR_POINTS_PER_LINK);
    const [wide] = summarizeHopSnrLinks(many, 250);
    expect(wide.count).toBe(300);
    expect(wide.points).toHaveLength(250);
    expect(wide.points[0][0]).toBe(50);
    expect(wide.points.at(-1)![0]).toBe(299);
    expect(summarizeHopSnrLinks(many, 1000)[0].points).toHaveLength(300);
  });

  it('never exceeds the hard maximum and falls back on a bad cap', () => {
    const huge = Array.from({ length: HOP_SNR_MAX_POINTS_PER_LINK + 5 }, (_, i) => sample({ timestamp: i }));
    expect(summarizeHopSnrLinks(huge, 999_999)[0].points).toHaveLength(HOP_SNR_MAX_POINTS_PER_LINK);
    expect(summarizeHopSnrLinks(many, Number.NaN)[0].points).toHaveLength(HOP_SNR_POINTS_PER_LINK);
    expect(summarizeHopSnrLinks(many, -4)[0].points).toHaveLength(1);
  });
});

describe('hopSnrChartData (#5765)', () => {
  it('adds a null marker only where two samples are more than the gap apart', () => {
    const t0 = 1_000_000;
    const rows = hopSnrChartData([
      [t0, 1], [t0 + HOP_SNR_CHART_GAP_MS, 2], [t0 + 2 * HOP_SNR_CHART_GAP_MS + 1, 3],
    ]);
    expect(rows).toEqual([
      { timestamp: t0, snr: 1 },
      { timestamp: t0 + HOP_SNR_CHART_GAP_MS, snr: 2 },
      { timestamp: t0 + HOP_SNR_CHART_GAP_MS + 1, snr: null },
      { timestamp: t0 + 2 * HOP_SNR_CHART_GAP_MS + 1, snr: 3 },
    ]);
  });

  it('sorts oldest first, takes a custom gap, and copes with none or one sample', () => {
    expect(hopSnrChartData([])).toEqual([]);
    expect(hopSnrChartData([[5, 1]])).toEqual([{ timestamp: 5, snr: 1 }]);
    expect(hopSnrChartData([[30, 3], [10, 1]], 5)).toEqual([
      { timestamp: 10, snr: 1 }, { timestamp: 11, snr: null }, { timestamp: 30, snr: 3 },
    ]);
  });
});

describe('hopSnrEndName (#5765)', () => {
  const t: HopSnrTranslate = (_k, fallback, vars) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars?.[name] ?? ''));
  const ctx = { contactKey: ME, localPublicKey: LOCAL.toUpperCase(), contacts: [{ publicKey: REP, advName: 'Hilltop' }], t };

  it('names the contact, the local node, a known contact, and the unresolved cases', () => {
    expect(hopSnrEndName({ publicKey: ME, hash: null, candidates: 1 }, ctx)).toBe('this contact');
    expect(hopSnrEndName({ publicKey: LOCAL, hash: null, candidates: 1 }, ctx)).toBe('This node');
    expect(hopSnrEndName({ publicKey: REP, hash: null, candidates: 1 }, ctx)).toBe('Hilltop');
    expect(hopSnrEndName({ publicKey: 'd'.repeat(64), hash: null, candidates: 1 }, ctx)).toBe('dddddddd…');
    expect(hopSnrEndName({ publicKey: null, hash: 'c3', candidates: 2 }, ctx)).toBe('c3 (2 contacts share it)');
    expect(hopSnrEndName({ publicKey: null, hash: 'c3', candidates: 0 }, ctx)).toBe('c3 (unknown)');
    expect(hopSnrEndName({ publicKey: null, hash: null, candidates: 0 }, ctx)).toBe('unknown sender');
  });
});

describe('MeshCoreTraceSnrCharts (#5765)', () => {
  beforeEach(() => getMock.mockReset());

  const now = Date.now();
  const links = summarizeHopSnrLinks([
    // REP heard ME: three samples, the last after a long silence.
    sample({ snrQuarterDb: 20, timestamp: now - 5 * HOP_SNR_CHART_GAP_MS }),
    sample({ snrQuarterDb: 12, timestamp: now - 5 * HOP_SNR_CHART_GAP_MS + 60_000 }),
    sample({ snrQuarterDb: 8, timestamp: now - 60_000 }),
    // ME heard REP.
    sample({ senderPublicKey: REP, senderHash: 'bb', receiverPublicKey: ME, receiverHash: 'aa', snrQuarterDb: -30, timestamp: now - 30_000 }),
    // LOCAL heard ME (one-way link).
    sample({ receiverPublicKey: LOCAL, receiverHash: null, timestamp: now - 5_000 }),
  ], HOP_SNR_CHART_POINTS);

  const props = { sourceId: 'src-1', publicKey: ME, localPublicKey: LOCAL, contacts: [{ publicKey: REP, name: 'Hilltop Repeater' }] };

  it('draws one chart per direction, labelled receiver-heard-sender, in two colours', async () => {
    getMock.mockResolvedValue({ success: true, data: { hours: 168, links } });
    render(<MeshCoreTraceSnrCharts {...props} />);
    const section = await screen.findByTestId('meshcore-trace-snr-charts');
    expect(getMock).toHaveBeenCalledWith(`/api/sources/src-1/meshcore/hop-snr?publicKey=${ME}&hours=168&points=${HOP_SNR_CHART_POINTS}`);

    const charts = Array.from(section.querySelectorAll('[data-testid="meshcore-trace-snr-chart"]'));
    expect(charts).toHaveLength(3);
    expect(section.querySelectorAll('[data-testid="line-chart"]')).toHaveLength(3);
    const text = charts.map((c) => c.textContent ?? '');
    expect(text.some((x) => x.startsWith('Hilltop Repeater heard this contact (dB)'))).toBe(true);
    expect(text.some((x) => x.startsWith('this contact heard Hilltop Repeater (dB)'))).toBe(true);
    expect(text.some((x) => x.startsWith('This node heard this contact (dB)'))).toBe(true);

    // The two directions of one link sit next to each other.
    const hilltop = charts.map((c, i) => ((c.textContent ?? '').includes('Hilltop') ? i : -1)).filter((i) => i >= 0);
    expect(hilltop[1] - hilltop[0]).toBe(1);

    const strokeOf = (dir: string) => new Set(
      charts.filter((c) => c.getAttribute('data-direction') === dir)
        .map((c) => c.querySelector('[data-testid="line"]')!.getAttribute('data-stroke')),
    );
    expect(strokeOf('in').size).toBe(1);
    expect(strokeOf('out').size).toBe(1);
    expect([...strokeOf('in')][0]).not.toBe([...strokeOf('out')][0]);
    for (const s of [...strokeOf('in'), ...strokeOf('out')]) expect(s).toMatch(/^var\(--chart-\d\)$/);
  });

  it('breaks the line across a long silence and formats the tooltip', async () => {
    getMock.mockResolvedValue({ success: true, data: { hours: 168, links } });
    render(<MeshCoreTraceSnrCharts {...props} />);
    await screen.findByTestId('meshcore-trace-snr-charts');
    const chart = screen.getAllByTestId('meshcore-trace-snr-chart')
      .find((c) => (c.textContent ?? '').startsWith('Hilltop Repeater heard this contact'))!;
    const plot = chart.querySelector('[data-testid="line-chart"]')!;
    expect(plot.getAttribute('data-rows')).toBe('4'); // 3 samples + 1 gap marker
    expect(plot.getAttribute('data-gaps')).toBe('1');
    const tip = chart.querySelector('[data-testid="tooltip"]')!;
    expect(tip.getAttribute('data-value')).toBe('1.50 dB|Hilltop Repeater heard this contact');
    expect(tip.getAttribute('data-label')).toBe(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toLocaleString());
  });

  it('refetches for the picked range and keeps the control when that range is empty', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: { hours: 168, links } });
    getMock.mockResolvedValueOnce({ success: true, data: { hours: 24, links: [] } });
    render(<MeshCoreTraceSnrCharts {...props} />);
    await screen.findByTestId('meshcore-trace-snr-charts');
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(
      `/api/sources/src-1/meshcore/hop-snr?publicKey=${ME}&hours=24&points=${HOP_SNR_CHART_POINTS}`));
    expect(await screen.findByText('No samples in this range.')).toBeInTheDocument();
    expect(screen.queryAllByTestId('meshcore-trace-snr-chart')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '90d' })).toBeInTheDocument();
  });

  it('renders nothing with no links, without the grant, or with no source', async () => {
    getMock.mockResolvedValue({ success: true, data: { hours: 168, links: [] } });
    const { unmount } = render(<MeshCoreTraceSnrCharts sourceId="src-1" publicKey={ME} />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId('meshcore-trace-snr-charts')).not.toBeInTheDocument();
    unmount();

    getMock.mockReset();
    getMock.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const second = render(<MeshCoreTraceSnrCharts sourceId="src-1" publicKey={ME} />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId('meshcore-trace-snr-charts')).not.toBeInTheDocument();
    second.unmount();

    getMock.mockReset();
    render(<MeshCoreTraceSnrCharts sourceId={null} publicKey={ME} />);
    expect(getMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('meshcore-trace-snr-charts')).not.toBeInTheDocument();
  });

  it('does not show one contact\'s charts under another contact', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: { hours: 168, links } });
    getMock.mockResolvedValueOnce({ success: true, data: { hours: 168, links: [] } });
    const { rerender } = render(<MeshCoreTraceSnrCharts {...props} />);
    await screen.findByTestId('meshcore-trace-snr-charts');
    rerender(<MeshCoreTraceSnrCharts {...props} publicKey={REP} />);
    expect(screen.queryByTestId('meshcore-trace-snr-charts')).not.toBeInTheDocument();
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(screen.queryByTestId('meshcore-trace-snr-charts')).not.toBeInTheDocument();
  });
});
