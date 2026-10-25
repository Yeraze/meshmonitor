/**
 * @vitest-environment jsdom
 *
 * Live packet traffic control (#4835): toggle, rate slider and dropped count.
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
    render(<PacketFlightsControl checked={false} onCheckedChange={onChecked} rate={0} onRateChange={vi.fn()} dropped={0} />);
    const box = screen.getByRole('checkbox', { name: 'Live packet traffic' });
    expect(box).not.toBeChecked();
    expect(screen.queryByRole('slider')).toBeNull();
    fireEvent.click(box);
    expect(onChecked).toHaveBeenCalledWith(true);
  });

  it('shows the hint, the rate slider (default All) and the dropped count when on', () => {
    const onRate = vi.fn();
    render(<PacketFlightsControl checked onCheckedChange={vi.fn()} rate={0} onRateChange={onRate} dropped={4} />);
    expect(screen.getByText(/Shows packets as they arrive/)).toBeInTheDocument();
    expect(screen.getByTestId('packet-flights-rate-value')).toHaveTextContent('All');
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '2' } });
    expect(onRate).toHaveBeenCalledWith(5);
    expect(screen.getByTestId('packet-flights-dropped')).toHaveTextContent('4 dropped');
  });

  it('labels a set rate and hides a zero dropped count', () => {
    render(<PacketFlightsControl checked onCheckedChange={vi.fn()} rate={10} onRateChange={vi.fn()} dropped={0} />);
    expect(screen.getByTestId('packet-flights-rate-value')).toHaveTextContent('10 per second');
    expect(screen.queryByTestId('packet-flights-dropped')).toBeNull();
  });

  it('is disabled in 3D', () => {
    render(<PacketFlightsControl checked onCheckedChange={vi.fn()} rate={0} onRateChange={vi.fn()} dropped={0} disabledTitle="Not available in 3D" />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
