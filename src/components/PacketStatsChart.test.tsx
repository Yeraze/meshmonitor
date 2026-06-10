/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PacketStatsChart, { type ChartDataEntry } from './PacketStatsChart';

// Recharts' ResponsiveContainer reports a 0x0 box in jsdom; that's fine — we
// only assert on the legend markup, which renders regardless of chart size.

const rxData: ChartDataEntry[] = [
  { name: 'Good', value: 2134, color: '#a6e3a1' },
  { name: 'Bad', value: 2, color: '#f38ba8' },
  { name: 'Dupe', value: 50, color: '#fab387' },
];

describe('PacketStatsChart legend', () => {
  it('renders the full count for every entry (issue #3401)', () => {
    render(<PacketStatsChart title="RX" data={rxData} total={2186} chartId="rx" bare />);

    // The raw count must always be fully present — this is the value that was
    // being clipped mid-string before the fix.
    expect(screen.getByText(/Good: 97\.6% \(2,134\)/)).toBeInTheDocument();
    expect(screen.getByText(/Bad: 0\.1% \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Dupe: 2\.3% \(50\)/)).toBeInTheDocument();
  });

  it('does not apply nowrap/ellipsis clipping in horizontal (non-stacked) mode', () => {
    render(<PacketStatsChart title="RX" data={rxData} total={2186} chartId="rx" bare />);

    const entry = screen.getByText(/Good: 97\.6% \(2,134\)/);
    // The legend paragraph must be allowed to wrap so the count is never clipped.
    expect(entry).not.toHaveStyle({ whiteSpace: 'nowrap' });
    expect(entry).not.toHaveStyle({ textOverflow: 'ellipsis' });
  });

  it('keeps nowrap/ellipsis truncation in stacked mode for long node names', () => {
    const deviceData: ChartDataEntry[] = [
      { name: 'A-Very-Long-Node-Name-That-Should-Truncate', value: 76, color: '#89b4fa' },
      { name: 'Other', value: 24, color: '#9399b2' },
    ];
    render(
      <PacketStatsChart title="By Device" data={deviceData} total={100} chartId="dist" bare stacked />,
    );

    const entry = screen.getByText(/A-Very-Long-Node-Name-That-Should-Truncate: 76\.0% \(76\)/);
    expect(entry).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(entry).toHaveStyle({ textOverflow: 'ellipsis' });
  });

  it('omits zero-value entries from the legend', () => {
    const data: ChartDataEntry[] = [
      { name: 'Direct', value: 10, color: '#89b4fa' },
      { name: 'Relay', value: 0, color: '#a6e3a1' },
    ];
    render(<PacketStatsChart title="TX" data={data} total={10} chartId="tx" bare />);

    expect(screen.getByText(/Direct: 100\.0% \(10\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Relay/)).not.toBeInTheDocument();
  });

  it('returns null when there is no positive data', () => {
    const data: ChartDataEntry[] = [{ name: 'Direct', value: 0, color: '#89b4fa' }];
    const { container } = render(
      <PacketStatsChart title="TX" data={data} total={0} chartId="tx" bare />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
