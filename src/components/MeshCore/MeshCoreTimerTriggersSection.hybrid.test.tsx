/**
 * @vitest-environment jsdom
 *
 * MeshCore Timer Triggers, one workflow with Meshtastic (#5812):
 *   - Saved triggers show as collapsed TriggerCards (schedule, action,
 *     destination, last run); the old always-open cards and Add form are gone.
 *   - Add opens a new card; Done needs a name and a valid cron / interval.
 *   - Untouched triggers are saved byte-for-byte to the same endpoint.
 *   - Delete asks first and only edits the draft; Dismiss restores.
 *   - "Run now" stays an explicit card action, off for new or changed
 *     triggers (it runs the saved copy), and fires one POST per click.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
    let s = typeof fallback === 'string' ? fallback : key;
    const vars = (typeof fallback === 'object' ? fallback : opts) ?? {};
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{{${k}}}`, String(v));
    return s;
  };
  return createReactI18nextMock(t);
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

const { csrfFetchMock, showToastMock, saveBarCapture } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  showToastMock: vi.fn(),
  saveBarCapture: { current: null as null | { id: string; hasChanges: boolean; onSave: () => Promise<void>; onDismiss: () => void } },
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: showToastMock }) }));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetchMock }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (o: NonNullable<typeof saveBarCapture.current>) => { saveBarCapture.current = o; },
}));

import { MeshCoreTimerTriggersSection } from './MeshCoreTimerTriggersSection';

// Untidy saved shapes: no destination, no advertMode (legacy flood), an extra
// field, run history. A save must send them back exactly as loaded.
const SAVED = [
  { id: 'c1', name: 'Beacon', enabled: true, scheduleType: 'cron', cronExpression: '0 */6 * * *', responseType: 'text', response: 'hello', destination: 'channel', channelIndex: 1, scopeMode: 'inherit', scopeName: '', lastRun: 1700000000000, lastResult: 'error', lastError: 'boom' },
  { id: 'i1', name: 'Advert', enabled: true, scheduleType: 'interval', intervalMinutes: 90, responseType: 'advert', extra: 'keep' },
  { id: 'd1', name: 'Ping Bob', enabled: false, scheduleType: 'cron', cronExpression: '15 * * * *', responseType: 'text', response: 'yo', destination: 'dm', contactPublicKey: 'abcdef0123456789' },
];

function mockFetch(triggers: unknown[] = SAVED) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/run')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { ok: true } }) });
    }
    if (url.includes('/automation/timers') && init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    }
    if (url.includes('/automation/timers')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { triggers } }) });
    }
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Public' }, { id: 1, name: 'Ops' }]) });
    }
    if (url.includes('/api/scripts')) {
      return Promise.resolve({ ok: true, json: async () => ({ scripts: [] }) });
    }
    if (url.includes('/contacts')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [{ publicKey: 'abcdef0123456789', advName: 'Bob' }] }) });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

const cards = () => screen.queryAllByTestId('trigger-card');
const posts = (part = '/automation/timers') => csrfFetchMock.mock.calls.filter(([url, init]) =>
  String(url).includes(part) && (init as RequestInit | undefined)?.method === 'POST' && !String(url).includes('/run'));
const runs = () => csrfFetchMock.mock.calls.filter(([url]) => String(url).includes('/run'));
const save = async () => { await act(async () => { await saveBarCapture.current!.onSave(); }); };
const loadedCards = async (n: number) => waitFor(() => expect(cards()).toHaveLength(n));

describe('MeshCoreTimerTriggersSection hybrid workflow (#5812)', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockImplementation(mockFetch());
  });

  it('shows saved triggers collapsed with schedule, destination and last run', async () => {
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await loadedCards(3);
    expect(saveBarCapture.current?.id).toBe('meshcore-timer-triggers');
    expect(cards().every((c) => !c.hasAttribute('data-expanded'))).toBe(true);
    expect(screen.queryByPlaceholderText('Trigger name')).toBeNull();

    expect(within(cards()[0]).getByText('0 */6 * * *')).toBeInTheDocument();
    await waitFor(() => expect(within(cards()[0]).getByText('Ops')).toBeInTheDocument());
    expect(within(cards()[0]).getByText(/Last run: .* — boom/)).toBeInTheDocument();
    expect(within(cards()[1]).getByText(/every 90 min/)).toBeInTheDocument();
    expect(within(cards()[1]).getByText(/Flood/)).toBeInTheDocument();
    await waitFor(() => expect(within(cards()[2]).getByText('Bob')).toBeInTheDocument());
  });

  it('payload shape: untouched triggers are saved byte-for-byte to the same endpoint', async () => {
    const user = userEvent.setup();
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await loadedCards(3);

    await user.click(within(cards()[0]).getByRole('button', { name: /edit/i }));
    await user.click(within(cards()[0]).getByRole('button', { name: /done/i }));
    expect(saveBarCapture.current?.hasChanges).toBe(false);

    await user.click(within(cards()[2]).getByRole('checkbox', { name: 'Enable Ping Bob' }));
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await save();

    expect(posts()).toHaveLength(1);
    expect(String(posts()[0][0])).toBe('/api/sources/src1/meshcore/automation/timers');
    const body = (posts()[0][1] as RequestInit).body as string;
    const expected = SAVED.map((tr) => (tr.id === 'd1' ? { ...tr, enabled: true } : tr));
    expect(body).toBe(JSON.stringify({ triggers: expected }));
    expect(saveBarCapture.current?.hasChanges).toBe(false);
  });

  it('Add opens a new card; Done needs a name and a valid cron; Save sends it', async () => {
    const user = userEvent.setup();
    csrfFetchMock.mockImplementation(mockFetch([]));
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Add trigger' }));
    expect(cards()).toHaveLength(1);
    const card = cards()[0];
    expect(card).toHaveAttribute('data-expanded');
    // Opens clean, not in red.
    expect(within(card).queryByRole('alert')).toBeNull();

    await user.click(within(card).getByRole('button', { name: /done/i }));
    expect(card).toHaveAttribute('data-expanded');
    expect(within(card).getByRole('alert')).toHaveTextContent('Name is required');

    await user.type(within(card).getByPlaceholderText('Trigger name'), 'Morning');
    const cron = within(card).getByDisplayValue('0 */6 * * *');
    await user.clear(cron);
    await user.type(cron, 'bogus');
    expect(within(card).getByRole('alert')).toHaveTextContent('Invalid cron expression');
    await user.click(within(card).getByRole('button', { name: /done/i }));
    expect(card).toHaveAttribute('data-expanded');

    await user.clear(cron);
    await user.type(cron, '0 7 * * *');
    await user.click(within(card).getByRole('button', { name: /done/i }));
    expect(card).not.toHaveAttribute('data-expanded');

    await save();
    const sent = JSON.parse((posts()[0][1] as RequestInit).body as string).triggers;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: 'Morning', enabled: true, scheduleType: 'cron', cronExpression: '0 7 * * *',
      responseType: 'text', advertMode: 'zero_hop', destination: 'channel', channelIndex: 0,
    });
  });

  it('Save refuses a saved trigger with a bad cron and opens it', async () => {
    const user = userEvent.setup();
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await loadedCards(3);
    await user.click(within(cards()[0]).getByRole('button', { name: /edit/i }));
    const cron = within(cards()[0]).getByDisplayValue('0 */6 * * *');
    await user.clear(cron);
    await user.click(within(cards()[0]).getByRole('button', { name: /done/i }));
    expect(cards()[0]).toHaveAttribute('data-expanded');
    await save();
    expect(posts()).toHaveLength(0);
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining('Invalid cron'), 'error');
  });

  it('Delete asks first, only edits the draft, and Dismiss restores', async () => {
    const user = userEvent.setup();
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await loadedCards(3);

    await user.click(within(cards()[1]).getByRole('button', { name: /delete/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Advert')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /delete/i }));
    expect(cards()).toHaveLength(2);
    expect(posts()).toHaveLength(0);
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    act(() => saveBarCapture.current!.onDismiss());
    expect(cards()).toHaveLength(3);
    expect(saveBarCapture.current?.hasChanges).toBe(false);
  });

  it('Run now: one POST per click on a saved trigger; off for a new or changed one', async () => {
    const user = userEvent.setup();
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await loadedCards(3);

    const runBtn = (i: number) => within(cards()[i]).getByRole('button', { name: /run now/i });
    expect(runBtn(0)).not.toBeDisabled();
    // A disabled trigger cannot run (as before).
    expect(runBtn(2)).toBeDisabled();
    expect(runs()).toHaveLength(0);

    fireEvent.click(runBtn(0));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith('Trigger fired', 'success'));
    expect(runs()).toHaveLength(1);
    expect(String(runs()[0][0])).toBe('/api/sources/src1/meshcore/automation/timers/c1/run');

    // Edit it: Run now waits for the save.
    await user.click(within(cards()[0]).getByRole('button', { name: /edit/i }));
    await user.type(within(cards()[0]).getByPlaceholderText('Trigger name'), '!');
    expect(runBtn(0)).toBeDisabled();
    expect(runBtn(0)).toHaveAttribute('title', 'Save your changes before running this trigger.');

    // A new trigger cannot run before it is saved.
    await user.click(screen.getByRole('button', { name: 'Add trigger' }));
    expect(within(cards()[3]).getByRole('button', { name: /run now/i })).toBeDisabled();
    expect(runs()).toHaveLength(1);
  });

  it('shows the filter only once there are more than five triggers', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`, name: i === 3 ? 'Needle' : `Timer ${i}`, enabled: true, scheduleType: 'cron', cronExpression: '0 * * * *', responseType: i === 3 ? 'advert' : 'text', response: 'x',
    }));
    csrfFetchMock.mockImplementation(mockFetch(many));
    const user = userEvent.setup();
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await loadedCards(6);
    await user.selectOptions(screen.getByRole('combobox', { name: /filter by type/i }), 'advert');
    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).getByText('Needle')).toBeInTheDocument();
  });
});
