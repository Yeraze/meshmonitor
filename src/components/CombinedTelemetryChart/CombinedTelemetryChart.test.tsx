/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CombinedTelemetryChart, { type CombinedSeries } from './CombinedTelemetryChart';

const downloadTextFile = vi.fn();
vi.mock('../../utils/nodeExport', async (orig) => ({
  ...(await orig<typeof import('../../utils/nodeExport')>()),
  downloadTextFile: (...args: unknown[]) => downloadTextFile(...args),
}));
vi.mock('../../utils/nodeExport.js', async (orig) => ({
  ...(await orig<typeof import('../../utils/nodeExport')>()),
  downloadTextFile: (...args: unknown[]) => downloadTextFile(...args),
}));

const line = (sourceId: string, sourceName: string, values: number[], extra: Partial<CombinedSeries['lines'][number]> = {}) => ({
  sourceId,
  sourceName,
  unit: '°C',
  favorited: false,
  canEditFavorite: false,
  points: values.map((value, i) => ({ timestamp: 1_760_000_000_000 + i * 60_000, value })),
  ...extra,
});

const temperature: CombinedSeries = {
  subjectKey: '!abcd1234',
  nodeName: 'Weather Station',
  type: 'temperature',
  favoriteType: 'temperature',
  category: 'environment',
  observerRelative: false,
  lines: [line('a', 'Roof', [20, 21]), line('b', 'MQTT', [20.5])],
};

const renderChart = (series: CombinedSeries, props: Partial<React.ComponentProps<typeof CombinedTelemetryChart>> = {}) =>
  render(
    <CombinedTelemetryChart
      series={series}
      colorFor={(id) => (id === 'a' ? 'red' : 'blue')}
      temperatureUnit="C"
      hours={24}
      timeRange={null}
      {...props}
    />,
  );

describe('CombinedTelemetryChart', () => {
  beforeEach(() => downloadTextFile.mockClear());

  it('merges an objective series into one legend entry naming every source (#5931)', () => {
    renderChart(temperature);
    expect(screen.getByText('Weather Station')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('unified.telemetry.merged_label');
  });

  it('splits an objective series back into one legend entry per source', () => {
    renderChart(temperature);
    const toggle = screen.getByRole('button', { name: 'unified.telemetry.split_by_source' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const legend = screen.getByRole('list');
    expect(legend.textContent).toContain('Roof');
    expect(legend.textContent).toContain('MQTT');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('never merges an observer-relative series, and offers no split toggle', () => {
    renderChart({ ...temperature, type: 'snr_local', observerRelative: true });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'unified.telemetry.split_by_source' })).toBeNull();
  });

  it('offers no split toggle for a single-source series', () => {
    renderChart({ ...temperature, lines: [temperature.lines[0]] });
    expect(screen.queryByRole('button', { name: 'unified.telemetry.split_by_source' })).toBeNull();
    expect(screen.getByRole('listitem').textContent).toContain('Roof');
  });

  it('shows the node, the type, and one legend entry per source when split', () => {
    renderChart(temperature);
    fireEvent.click(screen.getByRole('button', { name: 'unified.telemetry.split_by_source' }));
    expect(screen.getByText('Weather Station')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4 }).textContent).toContain('°C');
    const legend = screen.getByRole('list');
    expect(legend.textContent).toContain('Roof');
    expect(legend.textContent).toContain('MQTT');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('labels the lines of an observer-relative series as heard by each source', () => {
    renderChart({ ...temperature, type: 'snr_local', observerRelative: true, lines: [line('a', 'Roof', [-5])] });
    // i18n is not loaded in tests: the key stands in for "heard by Roof".
    expect(screen.getByRole('listitem').textContent).toContain('unified.telemetry.heard_by');
  });

  it('converts temperature to Fahrenheit in the title', () => {
    renderChart(temperature, { temperatureUnit: 'F' });
    expect(screen.getByRole('heading', { level: 4 }).textContent).toContain('°F');
  });

  it('offers the remove-favorite button only when a handler is given', () => {
    const { rerender } = renderChart(temperature);
    expect(screen.queryByRole('button', { name: 'telemetry.remove_favorite' })).toBeNull();
    const onRemove = vi.fn();
    rerender(
      <CombinedTelemetryChart series={temperature} colorFor={() => 'red'} temperatureUnit="C" hours={24} timeRange={null} onRemoveFavorite={onRemove} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'telemetry.remove_favorite' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('exports the merged line, naming the sources of each reading', () => {
    renderChart(temperature);
    fireEvent.click(screen.getByRole('button', { name: 'telemetry.export_csv' }));
    const [, csv] = downloadTextFile.mock.calls[0] as [string, string];
    const lines = csv.replace('\uFEFF', '').split('\r\n');
    expect(lines).toHaveLength(3);
    // 20 (Roof) and 20.5 (MQTT) in the same bucket average to 20.25.
    expect(lines[1]).toContain('20.25');
    expect(lines[1]).toContain('Roof; MQTT');
    expect(lines[2]).toContain('21');
    expect(lines[2]).not.toContain('MQTT');
  });

  it('exports every line to one CSV with a Source column, in the display unit, when split', () => {
    renderChart(temperature, { temperatureUnit: 'F' });
    fireEvent.click(screen.getByRole('button', { name: 'unified.telemetry.split_by_source' }));
    fireEvent.click(screen.getByRole('button', { name: 'telemetry.export_csv' }));
    expect(downloadTextFile).toHaveBeenCalledTimes(1);
    const [filename, csv] = downloadTextFile.mock.calls[0] as [string, string];
    expect(filename).toBe('telemetry-!abcd1234-temperature-24h.csv');
    const lines = csv.replace('\uFEFF', '').split('\r\n');
    expect(lines[0]).toContain('Source');
    expect(lines).toHaveLength(4);
    // 20°C → 68°F, recorded by "Roof".
    expect(lines[1]).toContain('68');
    expect(lines[1]).toContain('Roof');
    expect(lines[3]).toContain('MQTT');
  });
});
