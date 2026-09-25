/**
 * @vitest-environment jsdom
 *
 * CoverageDistanceChart (#5277 Phase 4a WP3, spec §2a.6/§3). recharts'
 * `ResponsiveContainer` reports a 0x0 box in jsdom (see PacketStatsChart.test.tsx),
 * so these tests assert on the legend/note markup and on the pure grouping
 * helpers' effect on that markup, not on rendered SVG geometry.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        const vars = (opts ?? {}) as Record<string, unknown>;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
      }
      return _key;
    },
  }),
}));

import { CoverageDistanceChart } from './CoverageDistanceChart';
import type { CoverageDistancePoint } from '../../types/coverageAnalysis';

function point(overrides: Partial<CoverageDistancePoint> = {}): CoverageDistancePoint {
  return { distanceM: 1000, snr: 5, receiverKey: 'src-a|!aaaaaaaa', ...overrides };
}

describe('CoverageDistanceChart', () => {
  it('shows the empty state with no points', () => {
    render(<CoverageDistanceChart points={[]} receiverNames={new Map()} distanceUnit="km" />);
    expect(
      screen.getByText('No direct (0-hop) receptions with a known receiver position.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-distance-chart-legend')).not.toBeInTheDocument();
  });

  it('renders a legend entry per receiver using the receiverNames map', () => {
    const points = [
      point({ receiverKey: 'src-a|!aaaaaaaa' }),
      point({ receiverKey: 'src-a|!aaaaaaaa' }),
      point({ receiverKey: 'src-b|!bbbbbbbb' }),
    ];
    render(
      <CoverageDistanceChart
        points={points}
        receiverNames={new Map([['src-a|!aaaaaaaa', 'Car Node']])}
        distanceUnit="km"
      />,
    );
    expect(screen.getByText('Car Node')).toBeInTheDocument();
    // No name supplied for src-b -> falls back to the formatted receiver id.
    expect(screen.getByText('!bbbbbbbb')).toBeInTheDocument();
  });

  it('caps series at 7 named receivers and merges the rest into Other', () => {
    const points: CoverageDistancePoint[] = [];
    // 9 distinct receivers, decreasing point counts so ranking is deterministic.
    for (let i = 0; i < 9; i++) {
      const count = 9 - i;
      for (let j = 0; j < count; j++) {
        points.push(point({ receiverKey: `src|!r${i}` }));
      }
    }
    render(<CoverageDistanceChart points={points} receiverNames={new Map()} distanceUnit="km" />);
    // Top 7 (r0..r6) get their own legend entries; r7/r8 fold into "Other".
    for (let i = 0; i < 7; i++) {
      expect(screen.getByText(`!r${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('!r7')).not.toBeInTheDocument();
    expect(screen.queryByText('!r8')).not.toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('downsamples past COVERAGE_CHART_MAX_POINTS and shows the note', () => {
    const points: CoverageDistancePoint[] = Array.from({ length: 5000 }, (_, i) =>
      point({ receiverKey: 'src-a|!aaaaaaaa', distanceM: i, snr: i % 20 }),
    );
    render(<CoverageDistanceChart points={points} receiverNames={new Map()} distanceUnit="km" />);
    expect(screen.getByText(/Showing .* of 5000 points\./)).toBeInTheDocument();
  });

  it('does not show the downsample note when under the cap', () => {
    const points: CoverageDistancePoint[] = Array.from({ length: 10 }, (_, i) =>
      point({ receiverKey: 'src-a|!aaaaaaaa', distanceM: i * 100, snr: i }),
    );
    render(<CoverageDistanceChart points={points} receiverNames={new Map()} distanceUnit="km" />);
    expect(screen.queryByText(/Showing .* of .* points\./)).not.toBeInTheDocument();
  });

  it('is deterministic: the same input downsamples to the same shown count across renders', () => {
    const points: CoverageDistancePoint[] = Array.from({ length: 4000 }, (_, i) =>
      point({ receiverKey: 'src-a|!aaaaaaaa', distanceM: i, snr: i % 20 }),
    );
    const { unmount } = render(
      <CoverageDistanceChart points={points} receiverNames={new Map()} distanceUnit="km" />,
    );
    const firstText = screen.getByText(/Showing .* of 4000 points\./).textContent;
    unmount();
    render(<CoverageDistanceChart points={points} receiverNames={new Map()} distanceUnit="km" />);
    const secondText = screen.getByText(/Showing .* of 4000 points\./).textContent;
    expect(firstText).toBe(secondText);
  });

  it('renders without throwing for both km and mi, and keeps a per-unit chart title', () => {
    // recharts' ResponsiveContainer reports a 0x0 box in jsdom (see the file
    // banner), so the axis label text it draws inside the SVG never reaches
    // the DOM here — this only guards the km/mi branch runs without error and
    // the surrounding chrome (title, legend) is present either way.
    const points = [point()];
    const { rerender } = render(
      <CoverageDistanceChart points={points} receiverNames={new Map()} distanceUnit="km" />,
    );
    expect(screen.getByText('Distance vs SNR (direct receptions)')).toBeInTheDocument();
    rerender(<CoverageDistanceChart points={points} receiverNames={new Map()} distanceUnit="mi" />);
    expect(screen.getByText('Distance vs SNR (direct receptions)')).toBeInTheDocument();
  });
});
