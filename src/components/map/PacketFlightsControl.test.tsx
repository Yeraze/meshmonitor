/**
 * @vitest-environment jsdom
 *
 * Live packet traffic control (#4835): toggle, rate slider and the last minute's counts.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PacketFlightsControl } from './PacketFlightsControl';

const { t } = vi.hoisted(() => ({
  t: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? '')),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));

describe('PacketFlightsControl', () => {
  it('is off by default and shows only the toggle', () => {
    const onChecked = vi.fn();
    render(<PacketFlightsControl checked={false} onCheckedChange={onChecked} rate={0} onRateChange={vi.fn()} stats={null} />);
    const box = screen.getByRole('checkbox', { name: 'Live packet traffic' });
    expect(box).not.toBeChecked();
    expect(screen.queryByRole('slider')).toBeNull();
    fireEvent.click(box);
    expect(onChecked).toHaveBeenCalledWith(true);
  });

  it('shows the hint, the rate slider (default All) and the last minute\'s counts when on', () => {
    const onRate = vi.fn();
    const stats = { received: 12, drawn: 5, noPosition: 3, overRate: 4 };
    render(<PacketFlightsControl checked onCheckedChange={vi.fn()} rate={0} onRateChange={onRate} stats={stats} />);
    expect(screen.getByText(/Shows packets as they arrive/)).toBeInTheDocument();
    expect(screen.getByTestId('packet-flights-rate-value')).toHaveTextContent('All');
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '2' } });
    expect(onRate).toHaveBeenCalledWith(5);
    expect(screen.getByTestId('packet-flights-stats')).toHaveTextContent(
      'Last minute: 12 received · 5 drawn · 3 no position · 4 over the limit',
    );
  });

  it('labels a set rate and hides a zero over-the-limit count', () => {
    const stats = { received: 2, drawn: 2, noPosition: 0, overRate: 0 };
    render(<PacketFlightsControl checked onCheckedChange={vi.fn()} rate={10} onRateChange={vi.fn()} stats={stats} />);
    expect(screen.getByTestId('packet-flights-rate-value')).toHaveTextContent('10 per second');
    expect(screen.getByTestId('packet-flights-stats')).toHaveTextContent('2 received · 2 drawn · 0 no position');
    expect(screen.queryByTestId('packet-flights-dropped')).toBeNull();
  });

  it('says so when nothing arrived, and shows nothing before the layer reports', () => {
    const view = render(
      <PacketFlightsControl checked onCheckedChange={vi.fn()} rate={0} onRateChange={vi.fn()} stats={{ received: 0, drawn: 0, noPosition: 0, overRate: 0 }} />,
    );
    expect(screen.getByTestId('packet-flights-stats')).toHaveTextContent('Last minute: no packets yet');
    view.rerender(<PacketFlightsControl checked onCheckedChange={vi.fn()} rate={0} onRateChange={vi.fn()} stats={null} />);
    expect(screen.queryByTestId('packet-flights-stats')).toBeNull();
  });

  it('is disabled in 3D', () => {
    render(<PacketFlightsControl checked onCheckedChange={vi.fn()} rate={0} onRateChange={vi.fn()} stats={null} disabledTitle="Not available in 3D" />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
