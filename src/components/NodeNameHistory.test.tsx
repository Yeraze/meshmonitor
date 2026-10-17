/**
 * @vitest-environment jsdom
 *
 * Name History section (#5862): hidden until the node has a rename, newest
 * first, collapsed past five entries, and marks a rename seen on several
 * sources.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import NodeNameHistory from './NodeNameHistory';
import type { NodeNameHistoryEntry } from '../services/api';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  const t = (key: string, opts?: string | { defaultValue?: string; count?: number }) => {
    if (typeof opts === 'string') return opts;
    return (opts?.defaultValue ?? key).replace('{{count}}', String(opts?.count ?? ''));
  };
  return createReactI18nextMock(t);
});

const getNodeNameHistory = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    setBaseUrl: () => {},
    getNodeNameHistory: (...args: unknown[]) => getNodeNameHistory(...args),
  },
}));

const entry = (i: number, over: Partial<NodeNameHistoryEntry> = {}): NodeNameHistoryEntry => ({
  oldLongName: `Name ${i - 1}`,
  newLongName: `Name ${i}`,
  oldShortName: `N${i - 1}`,
  newShortName: `N${i}`,
  changedAt: 1_700_000_000_000 + i * 60_000,
  sourceIds: ['a'],
  ...over,
});

describe('NodeNameHistory (#5862)', () => {
  beforeEach(() => getNodeNameHistory.mockReset());

  it('renders nothing when the node was never renamed', async () => {
    getNodeNameHistory.mockResolvedValue([]);
    const { container } = render(<NodeNameHistory nodeId="!9e80e848" />);
    await waitFor(() => expect(getNodeNameHistory).toHaveBeenCalledWith('!9e80e848'));
    expect(container).toBeEmptyDOMElement();
  });

  it('lists renames with old and new names, and the source count when merged', async () => {
    getNodeNameHistory.mockResolvedValue([entry(2, { sourceIds: ['a', 'b'] }), entry(1)]);
    render(<NodeNameHistory nodeId="!9e80e848" />);

    const section = await screen.findByTestId('node-name-history');
    const items = section.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Name 1 (N1)');
    expect(items[0].textContent).toContain('Name 2 (N2)');
    expect(items[0].textContent).toContain('Seen on 2 sources');
    expect(items[1].textContent).not.toContain('Seen on');
  });

  it('collapses past five entries behind "Show all"', async () => {
    getNodeNameHistory.mockResolvedValue([8, 7, 6, 5, 4, 3, 2, 1].map(i => entry(i)));
    render(<NodeNameHistory nodeId="!9e80e848" />);

    const section = await screen.findByTestId('node-name-history');
    expect(section.querySelectorAll('li')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8' }));
    expect(section.querySelectorAll('li')).toHaveLength(8);
  });

  it('skips the request with no node id', () => {
    render(<NodeNameHistory nodeId={null} />);
    expect(getNodeNameHistory).not.toHaveBeenCalled();
  });
});
