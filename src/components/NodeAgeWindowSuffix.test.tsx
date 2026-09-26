/**
 * @vitest-environment jsdom
 *
 * NodeAgeWindowSuffix (#5344): the " · last 24h" / " · all" cutoff beside the
 * Nodes list count. Rendered against the real en.json strings.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import NodeAgeWindowSuffix from './NodeAgeWindowSuffix';

vi.mock('react-i18next', async () => {
  const { readFileSync } = await import('fs');
  const en = JSON.parse(readFileSync(`${process.cwd()}/public/locales/en.json`, 'utf-8'));
  const t = (key: string, opts?: Record<string, unknown>) =>
    String(typeof en[key] === 'string' ? en[key] : opts?.defaultValue ?? key)
      .replace(/\{\{(\w+)\}\}/g, (_m, n) => String(opts?.[n] ?? ''));
  return { useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: vi.fn() } }) };
});

describe('NodeAgeWindowSuffix', () => {
  it('shows the Settings window beside the count', () => {
    render(<h3>Nodes (122)<NodeAgeWindowSuffix hours={24} /></h3>);
    expect(screen.getByRole('heading')).toHaveTextContent('Nodes (122) · last 24h');
    expect(screen.getByTestId('node-age-window')).toHaveAttribute(
      'title',
      'The Nodes list shows nodes heard in this window (last 24h). Change it in Settings > Node Display.',
    );
  });

  it('reads "all" when the window is 0, negative, or unset', () => {
    for (const hours of [0, -1, undefined, null]) {
      const { unmount } = render(<h3>Nodes (5)<NodeAgeWindowSuffix hours={hours} /></h3>);
      expect(screen.getByRole('heading')).toHaveTextContent('Nodes (5) · all');
      unmount();
    }
  });

  it('notes the separate infrastructure window on MeshCore lists', () => {
    render(<NodeAgeWindowSuffix hours={72} variant="meshcore" />);
    const el = screen.getByTestId('node-age-window');
    expect(el).toHaveTextContent('· last 3d');
    expect(el.getAttribute('title')).toMatch(/Repeaters and room servers use their own window/);
  });
});
