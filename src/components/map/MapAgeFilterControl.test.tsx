/**
 * @vitest-environment jsdom
 *
 * MapAgeFilterControl (#5344): the shared Map Features age filter used by BOTH
 * NodesTab and DashboardMap. Rendered against the real en.json strings so the
 * user-facing wording is pinned.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MapAgeFilterControl from './MapAgeFilterControl';

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

describe('MapAgeFilterControl', () => {
  it('labels the control and names the Settings window at the All stop', () => {
    render(<MapAgeFilterControl maxNodeAgeHours={24} effectiveMaxAgeHours={24} onChange={vi.fn()} />);
    const slider = screen.getByRole('slider', { name: 'Map age filter' });
    expect(slider).toHaveAttribute('aria-valuetext', 'All (24h from Settings)');
    expect(screen.getByTestId('map-age-showing')).toHaveTextContent('Showing: All (24h from Settings)');
    expect(screen.getByText("Narrows the Settings node window. It can't widen it.")).toBeInTheDocument();
    // Scoped spacing class sits beside the shared row class (both panels).
    expect(slider.closest('.map-control-item')?.className).toMatch(/control/);
  });

  it('shows the narrowed window when the slider sits below the Settings cap', () => {
    render(<MapAgeFilterControl maxNodeAgeHours={24} effectiveMaxAgeHours={6} onChange={vi.fn()} />);
    expect(screen.getByTestId('map-age-showing')).toHaveTextContent('Showing: last 6h');
  });

  it('reads "no limit in Settings" when the Settings window is 0 (show all)', () => {
    render(<MapAgeFilterControl maxNodeAgeHours={0} effectiveMaxAgeHours={Infinity} onChange={vi.fn()} />);
    expect(screen.getByTestId('map-age-showing')).toHaveTextContent('Showing: All (no limit in Settings)');
  });

  it('formats a multi-day Settings window in days', () => {
    render(<MapAgeFilterControl maxNodeAgeHours={168} effectiveMaxAgeHours={168} onChange={vi.fn()} />);
    expect(screen.getByTestId('map-age-showing')).toHaveTextContent('Showing: All (7d from Settings)');
  });

  it('stores null at the top stop and a stop value below it', () => {
    const onChange = vi.fn();
    // Stops for a 24h cap: 1h, 3h, 6h, 12h, 24h(All). Start at 6h (index 2).
    render(<MapAgeFilterControl maxNodeAgeHours={24} effectiveMaxAgeHours={6} onChange={onChange} />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '4' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.change(slider, { target: { value: '1' } });
    expect(onChange).toHaveBeenLastCalledWith(3);
  });
});
