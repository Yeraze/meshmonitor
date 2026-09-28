/**
 * @vitest-environment jsdom
 *
 * Ignore / Block (#5408): a run of consecutive ignored messages collapses into
 * one "N ignored messages" row that expands on click.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      const template = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? ''));
    },
  }),
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import { findIgnoredRuns } from './meshcoreIgnoredRuns';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const now = Date.now();
function msg(id: string, offset: number, text: string, filtered?: 'ignore' | 'block'): MeshCoreMessage {
  return { id, fromPublicKey: 'channel-0', fromName: 'Someone', text, timestamp: now - 10_000 + offset, ...(filtered ? { filtered } : {}) };
}

const MESSAGES = [
  msg('a', 0, 'visible one'),
  msg('b', 1, 'spam one', 'ignore'),
  msg('c', 2, 'spam two', 'ignore'),
  msg('d', 3, 'spam three', 'block'),
  msg('e', 4, 'visible two'),
  msg('f', 5, 'spam four', 'ignore'),
];

describe('findIgnoredRuns', () => {
  it('groups consecutive filtered messages and breaks on a normal one', () => {
    const runs = findIgnoredRuns(MESSAGES);
    expect(runs.get(0)).toBeUndefined();
    expect(runs.get(1)).toEqual({ key: 'b', startIndex: 1, count: 3 });
    expect(runs.get(3)).toBe(runs.get(1));
    expect(runs.get(4)).toBeUndefined();
    expect(runs.get(5)).toEqual({ key: 'f', startIndex: 5, count: 1 });
  });
});

describe('MeshCoreMessageStream — ignored runs', () => {
  it('collapses each run into one row and hides its messages', () => {
    render(<MeshCoreMessageStream messages={MESSAGES} onSend={async () => true} />);
    const rows = screen.getAllByTestId('mc-ignored-run');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('3 ignored messages');
    expect(rows[1].textContent).toContain('1 ignored messages');
    expect(screen.getByText('visible one')).toBeTruthy();
    expect(screen.getByText('visible two')).toBeTruthy();
    expect(screen.queryByText('spam one')).toBeNull();
    expect(screen.queryByText('spam three')).toBeNull();
    expect(screen.queryByText('spam four')).toBeNull();
  });

  it('expands a run on click and collapses it again', () => {
    render(<MeshCoreMessageStream messages={MESSAGES} onSend={async () => true} />);
    const first = screen.getAllByTestId('mc-ignored-run')[0];
    fireEvent.click(within(first).getByRole('button'));
    expect(screen.getByText('spam one')).toBeTruthy();
    expect(screen.getByText('spam two')).toBeTruthy();
    expect(screen.getByText('spam three')).toBeTruthy();
    // The other run stays collapsed.
    expect(screen.queryByText('spam four')).toBeNull();

    const toggle = screen.getByRole('button', { name: /Hide 3 ignored messages/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.queryByText('spam one')).toBeNull();
  });

  it('renders normally when nothing is filtered', () => {
    render(<MeshCoreMessageStream messages={[msg('x', 0, 'plain')]} onSend={async () => true} />);
    expect(screen.queryByTestId('mc-ignored-run')).toBeNull();
    expect(screen.getByText('plain')).toBeTruthy();
  });
});
