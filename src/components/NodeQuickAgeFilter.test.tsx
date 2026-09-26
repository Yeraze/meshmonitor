/**
 * @vitest-environment jsdom
 *
 * NodeQuickAgeFilter (#5387): the view-only age picker beside the Nodes list
 * count. It replaces the read-only #5344 suffix. Rendered against the real
 * en.json strings.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import NodeQuickAgeFilter from './NodeQuickAgeFilter';
import { setNodeQuickAgeHours } from '../hooks/useNodeQuickAgeFilter';
import { NODE_QUICK_AGE_STORAGE_KEY } from '../utils/nodeQuickAgeFilter';

vi.mock('react-i18next', async () => {
  const { readFileSync } = await import('fs');
  const en = JSON.parse(readFileSync(`${process.cwd()}/public/locales/en.json`, 'utf-8'));
  const t = (key: string, opts?: Record<string, unknown>) =>
    String(typeof en[key] === 'string' ? en[key] : opts?.defaultValue ?? key)
      .replace(/\{\{(\w+)\}\}/g, (_m, n) => String(opts?.[n] ?? ''));
  return { useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: vi.fn() } }) };
});

const picker = () => screen.getByRole('combobox', { name: 'Node age window' }) as HTMLSelectElement;

afterEach(() => {
  act(() => setNodeQuickAgeHours(null));
  localStorage.clear();
});

describe('NodeQuickAgeFilter', () => {
  it('defaults to the Settings window and explains where it comes from', () => {
    render(<NodeQuickAgeFilter settingsHours={24} />);
    expect(picker().value).toBe('setting');
    expect(picker().selectedOptions[0]).toHaveTextContent('Setting (last 24h)');
    expect(picker()).toHaveAttribute(
      'title',
      'The Nodes list shows nodes heard in this window (last 24h). Change it in Settings > Node Display.',
    );
    const labels = Array.from(picker().options).map((o) => o.textContent);
    expect(labels).toEqual(['Setting (last 24h)', 'last 24h', 'last 3d', 'last 7d', 'last 30d', 'all']);
  });

  it('reads "Setting (all)" when the Settings window is 0 or unset', () => {
    for (const hours of [0, undefined, null]) {
      const { unmount } = render(<NodeQuickAgeFilter settingsHours={hours} />);
      expect(picker().selectedOptions[0]).toHaveTextContent('Setting (all)');
      unmount();
    }
  });

  it('picks a window for this viewer only, persists it locally, and "Setting" clears it', () => {
    render(<NodeQuickAgeFilter settingsHours={24} />);
    fireEvent.change(picker(), { target: { value: '168' } });
    expect(picker().value).toBe('168');
    expect(localStorage.getItem(NODE_QUICK_AGE_STORAGE_KEY)).toBe('168');
    expect(picker().getAttribute('title')).toMatch(/\(last 7d\).*your setting \(last 24h\) is unchanged/);
    expect(picker().className).toMatch(/overridden/);

    fireEvent.change(picker(), { target: { value: 'setting' } });
    expect(picker().value).toBe('setting');
    expect(localStorage.getItem(NODE_QUICK_AGE_STORAGE_KEY)).toBeNull();
    expect(picker().className).not.toMatch(/overridden/);
  });

  it('keeps every mounted picker in step (list header and map share one store)', () => {
    render(
      <>
        <NodeQuickAgeFilter settingsHours={24} />
        <NodeQuickAgeFilter settingsHours={24} variant="meshcore" />
      </>,
    );
    const [a, b] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(a, { target: { value: '0' } });
    expect(b.value).toBe('0');
    expect(b.getAttribute('title')).toMatch(/companions, repeaters, and room servers/);
  });

  it('notes the separate infrastructure window on MeshCore lists', () => {
    render(<NodeQuickAgeFilter settingsHours={72} variant="meshcore" />);
    expect(picker().getAttribute('title')).toMatch(/Repeaters and room servers use their own window/);
  });
});
