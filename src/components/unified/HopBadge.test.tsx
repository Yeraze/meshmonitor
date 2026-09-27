/**
 * @vitest-environment jsdom
 *
 * Per-source hop badge in the Unified Messages collapsed row (#5366).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '../../../public/locales/en.json';
import HopBadge from './HopBadge';

// Interpolate against the real English catalog so the accessible label is
// asserted as a user would hear it.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const tpl = (en as unknown as Record<string, string>)[key] ?? key;
      return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(opts?.[k] ?? ''));
    },
  }),
}));

describe('HopBadge (#5366)', () => {
  it('shows the hop count with a label naming the source', () => {
    render(<HopBadge reception={{ hopStart: 3, hopLimit: 1 }} sourceName="Base Station" />);
    const badge = screen.getByTestId('unified-hop-badge');
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('aria-label')).toBe('Heard by Base Station: 2 hops');
    expect(badge.getAttribute('title')).toBe('Heard by Base Station: 2 hops');
  });

  it('shows 0 for a direct reception', () => {
    render(<HopBadge reception={{ hopStart: 3, hopLimit: 3 }} sourceName="Roof" />);
    const badge = screen.getByTestId('unified-hop-badge');
    expect(badge.textContent).toBe('0');
    expect(badge.getAttribute('aria-label')).toBe('Heard by Roof: direct');
  });

  it('shows the raw number for counts of 10 and above', () => {
    render(<HopBadge reception={{ hopStart: null, hopLimit: null, hopCount: 11 }} sourceName="MC" />);
    expect(screen.getByTestId('unified-hop-badge').textContent).toBe('11');
  });

  it('shows ? and an unknown label when hopStart is missing', () => {
    render(<HopBadge reception={{ hopStart: null, hopLimit: 3 }} sourceName="Old Node" />);
    const badge = screen.getByTestId('unified-hop-badge');
    expect(badge.textContent).toBe('?');
    expect(badge.getAttribute('aria-label')).toBe('Heard by Old Node: hop count unknown');
  });

  it('shows ? for a corrupt pair where hopLimit exceeds hopStart', () => {
    render(<HopBadge reception={{ hopStart: 1, hopLimit: 3 }} sourceName="Bad" />);
    expect(screen.getByTestId('unified-hop-badge').textContent).toBe('?');
  });

  it('renders no emoji', () => {
    render(<HopBadge reception={{ hopStart: 5, hopLimit: 2 }} sourceName="X" />);
    expect(/\p{Extended_Pictographic}|⃣/u.test(screen.getByTestId('unified-hop-badge').textContent ?? '')).toBe(false);
  });
});
