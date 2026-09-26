/**
 * @vitest-environment jsdom
 *
 * MapAircraftDisplayControl (#5364/#5365 Phase 1 WP4): the shared Map Features
 * "Likely aircraft" control used by BOTH NodesTab and DashboardMap. Rendered
 * against the real en.json strings so the user-facing wording is pinned.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MapAircraftDisplayControl from './MapAircraftDisplayControl';

vi.mock('react-i18next', async () => {
  const { readFileSync } = await import('fs');
  const en = JSON.parse(readFileSync(`${process.cwd()}/public/locales/en.json`, 'utf-8'));
  const lookup = (key: string): string | undefined => {
    if (typeof en[key] === 'string') return en[key];
    const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
    return typeof v === 'string' ? v : undefined;
  };
  const t = (key: string, opts?: Record<string, unknown>) =>
    (lookup(key) ?? String(opts?.defaultValue ?? key)).replace(/\{\{(\w+)\}\}/g, (_m, n) => String(opts?.[n] ?? ''));
  return { useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: vi.fn() } }) };
});

describe('MapAircraftDisplayControl', () => {
  it('renders three radios, checks the current one, and has a data-testid', () => {
    render(<MapAircraftDisplayControl mode="mark" onChange={vi.fn()} />);
    expect(screen.getByTestId('map-aircraft-mode')).toBeInTheDocument();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    const checked = radios.find((r) => r.checked);
    expect(checked?.value).toBe('mark');
    expect(screen.getByText('Show')).toBeInTheDocument();
    expect(screen.getByText('Mark')).toBeInTheDocument();
    expect(screen.getByText('Hide')).toBeInTheDocument();
  });

  it('calls onChange with the clicked mode', () => {
    const onChange = vi.fn();
    render(<MapAircraftDisplayControl mode="mark" onChange={onChange} />);
    fireEvent.click(screen.getByDisplayValue('hide'));
    expect(onChange).toHaveBeenCalledWith('hide');
    fireEvent.click(screen.getByDisplayValue('show'));
    expect(onChange).toHaveBeenCalledWith('show');
  });

  it('shows the count line when aircraftCount is provided', () => {
    render(<MapAircraftDisplayControl mode="mark" onChange={vi.fn()} aircraftCount={3} />);
    expect(screen.getByText(/3 on the map\./)).toBeInTheDocument();
  });

  it('omits the count line when aircraftCount is not provided', () => {
    render(<MapAircraftDisplayControl mode="mark" onChange={vi.fn()} />);
    expect(screen.queryByText(/on the map\./)).not.toBeInTheDocument();
  });

  it('reflects the current mode when it changes to hide/show', () => {
    const { rerender } = render(<MapAircraftDisplayControl mode="show" onChange={vi.fn()} />);
    expect((screen.getByDisplayValue('show') as HTMLInputElement).checked).toBe(true);
    rerender(<MapAircraftDisplayControl mode="hide" onChange={vi.fn()} />);
    expect((screen.getByDisplayValue('hide') as HTMLInputElement).checked).toBe(true);
  });

  it('contains no emoji in its rendered text', () => {
    const { container } = render(
      <MapAircraftDisplayControl mode="mark" onChange={vi.fn()} aircraftCount={2} />,
    );
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
