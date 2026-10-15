/**
 * @vitest-environment jsdom
 *
 * Meshtastic Timer Triggers, one workflow with MeshCore (#5812):
 *   - Saved timers show as collapsed TriggerCards; the old add form is gone.
 *   - Add opens a new card; Done validates (name, cron, script / message)
 *     and collapses; Save sends the normalised timer in the same shape.
 *   - Timers the user did not edit are saved byte-for-byte as loaded, and
 *     the card toggle changes only `enabled`.
 *   - Delete asks first (shared ConfirmDialog) and only edits the draft.
 *   - SaveBar Dismiss restores the saved list; a successful save clears dirty
 *     without waiting for the parent prop.
 *   - Test opens the script test modal only on an explicit click.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TimerTriggersSection from './TimerTriggersSection';
import type { TimerTrigger } from './auto-responder/types';
import type { Channel } from '../types/device';

const { csrfFetchMock, saveBarCapture, scriptTestProps } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  saveBarCapture: { current: null as null | { id: string; hasChanges: boolean; onSave: () => Promise<void>; onDismiss: () => void } },
  scriptTestProps: { current: null as null | Record<string, unknown> },
}));
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetchMock }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '?sourceId=s1' }));
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (o: NonNullable<typeof saveBarCapture.current>) => { saveBarCapture.current = o; },
}));
vi.mock('../services/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue({
      scripts: [
        { path: '/data/scripts/report.py', filename: 'report.py', language: 'Python', name: 'Daily Report' },
        { path: '/data/scripts/plain.sh', filename: 'plain.sh', language: 'Shell' },
      ],
    }),
  },
}));
vi.mock('./ScriptTestModal', () => ({
  default: (props: Record<string, unknown>) => {
    scriptTestProps.current = props;
    return <div data-testid="script-test-modal" />;
  },
}));

const channels: Channel[] = [
  { id: 0, name: 'Primary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
  { id: 1, name: 'Ops', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
];

// Deliberately untidy saved shapes: no responseType (legacy script), an
// untrimmed name, run history, an unknown extra field. A save must not "fix"
// any of them unless the user edited that timer.
const SAVED: TimerTrigger[] = [
  { id: 'legacy', name: 'Legacy ', cronExpression: '0 * * * *', scriptPath: '/data/scripts/plain.sh', channel: 'none', enabled: true, lastRun: 1700000000000, lastResult: 'success' },
  { id: 'text', name: 'Hello', cronExpression: '*/30 * * * *', responseType: 'text', response: 'hi {VERSION}', channel: 1, enabled: false },
  { id: 'extra', name: 'Extra', cronExpression: '0 6 * * *', responseType: 'script', scriptPath: '/data/scripts/report.py', scriptArgs: '--x', channel: 0, enabled: true, extraField: 'keep me' } as TimerTrigger,
];

function renderSection(triggers: TimerTrigger[] = SAVED, onTriggersChange = vi.fn()) {
  const view = render(
    <TimerTriggersSection triggers={triggers} channels={channels} baseUrl="" onTriggersChange={onTriggersChange} />,
  );
  return { ...view, onTriggersChange };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const posts = () => csrfFetchMock.mock.calls.filter(([url, init]) =>
  String(url).includes('/api/settings') && (init as RequestInit | undefined)?.method === 'POST');
const lastBody = () => JSON.parse((posts()[posts().length - 1][1] as RequestInit).body as string);
const save = async () => { await act(async () => { await saveBarCapture.current!.onSave(); }); };
const cards = () => screen.queryAllByTestId('trigger-card');

describe('TimerTriggersSection hybrid workflow (#5812)', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
    scriptTestProps.current = null;
    csrfFetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  });

  it('shows saved timers collapsed, with the SaveBar id and no add form', async () => {
    renderSection();
    await settle();
    expect(saveBarCapture.current?.id).toBe('timer-triggers');
    expect(cards()).toHaveLength(3);
    expect(cards().every((c) => !c.hasAttribute('data-expanded'))).toBe(true);
    expect(screen.queryByText('automation.timer_triggers.add_new')).toBeNull();
    expect(screen.queryByText(/automation\.timer_triggers\.existing/)).toBeNull();
    // Summary shows the cron string; the last run is a chip.
    expect(within(cards()[0]).getByText('0 * * * *')).toBeInTheDocument();
    expect(within(cards()[0]).getByText(/\(success\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('script-test-modal')).toBeNull();
  });

  it('payload shape: untouched timers are saved byte-for-byte; the toggle changes only enabled', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    // Open and close a card without editing: still clean.
    await user.click(within(cards()[0]).getByRole('button', { name: /common\.edit/ }));
    await user.click(within(cards()[0]).getByRole('button', { name: /common\.done/ }));
    expect(saveBarCapture.current?.hasChanges).toBe(false);

    // Flip the second timer's toggle and save.
    await user.click(within(cards()[1]).getByRole('checkbox'));
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await save();

    expect(posts()).toHaveLength(1);
    expect(String(posts()[0][0])).toBe('/api/settings?sourceId=s1');
    const body = lastBody();
    expect(Object.keys(body)).toEqual(['timerTriggers']);
    const expected = SAVED.map((tr) => (tr.id === 'text' ? { ...tr, enabled: true } : tr));
    expect(body.timerTriggers).toBe(JSON.stringify(expected));
    // Dirty clears on success even though the parent prop has not changed.
    expect(saveBarCapture.current?.hasChanges).toBe(false);
  });

  it('Add opens a new card; Done validates, then collapses; Save sends the normalised timer', async () => {
    const user = userEvent.setup();
    const { onTriggersChange } = renderSection([]);
    await settle();

    await user.click(screen.getByRole('button', { name: /automation\.timer_triggers\.add/ }));
    expect(cards()).toHaveLength(1);
    const card = cards()[0];
    expect(card).toHaveAttribute('data-expanded');

    // Done on a blank timer keeps it open with the name and script errors.
    await user.click(within(card).getByRole('button', { name: /common\.done/ }));
    expect(card).toHaveAttribute('data-expanded');
    expect(within(card).getAllByRole('alert').map((a) => a.textContent)).toEqual(
      expect.arrayContaining(['automation.timer_triggers.name_required', 'automation.timer_triggers.script_required']),
    );

    // A bad cron shows live and blocks Done.
    const cron = within(card).getByLabelText('automation.timer_triggers.schedule');
    await user.clear(cron);
    await user.type(cron, 'not a cron');
    expect(within(card).getByText('automation.timer_triggers.invalid_cron')).toBeInTheDocument();
    await user.clear(cron);
    await user.type(cron, ' 15 4 * * * ');

    // Picking a script fills the blank name from its metadata.
    await user.selectOptions(within(card).getByLabelText('automation.timer_triggers.script'), '/data/scripts/report.py');
    expect(within(card).getByLabelText('automation.timer_triggers.name')).toHaveValue('Daily Report');
    await user.type(within(card).getByLabelText('automation.timer_triggers.script_args'), '  --fast ');
    await user.selectOptions(within(card).getByLabelText('automation.timer_triggers.channel'), 'none');

    await user.click(within(card).getByRole('button', { name: /common\.done/ }));
    expect(card).not.toHaveAttribute('data-expanded');

    await save();
    const saved = JSON.parse(lastBody().timerTriggers);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      id: expect.any(String),
      name: 'Daily Report',
      cronExpression: '15 4 * * *',
      responseType: 'script',
      scriptPath: '/data/scripts/report.py',
      scriptArgs: '--fast',
      channel: 'none',
      enabled: true,
    });
    expect(onTriggersChange).toHaveBeenCalledWith(saved);
  });

  it('a text timer needs a message, saves trimmed, and drops script fields', async () => {
    const user = userEvent.setup();
    renderSection([]);
    await settle();
    await user.click(screen.getByRole('button', { name: /automation\.timer_triggers\.add/ }));
    const card = cards()[0];
    await user.type(within(card).getByLabelText('automation.timer_triggers.name'), 'Status');
    await user.click(within(card).getByRole('radio', { name: 'automation.timer_triggers.type_text' }));

    // Save refuses while the message is blank and keeps the card open.
    await save();
    expect(posts()).toHaveLength(0);
    expect(within(card).getByText('automation.timer_triggers.message_required')).toBeInTheDocument();

    await user.type(within(card).getByLabelText('automation.timer_triggers.message'), ' {{NODECOUNT} online ');
    await user.selectOptions(within(card).getByLabelText('automation.timer_triggers.channel'), '1');
    await save();
    const saved = JSON.parse(lastBody().timerTriggers);
    expect(saved[0]).toMatchObject({ name: 'Status', responseType: 'text', response: '{NODECOUNT} online', channel: 1 });
    expect(saved[0]).not.toHaveProperty('scriptPath');
    expect(saved[0]).not.toHaveProperty('scriptArgs');
  });

  it('Delete asks first through the shared dialog, and only edits the draft', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    await user.click(within(cards()[1]).getByRole('button', { name: /common\.delete/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Hello')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /common\.cancel/ }));
    expect(cards()).toHaveLength(3);

    await user.click(within(cards()[1]).getByRole('button', { name: /common\.delete/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /common\.delete/ }));
    expect(cards()).toHaveLength(2);
    expect(posts()).toHaveLength(0);
    expect(saveBarCapture.current?.hasChanges).toBe(true);

    await save();
    expect(lastBody().timerTriggers).toBe(JSON.stringify([SAVED[0], SAVED[2]]));
  });

  it('Dismiss restores the saved list and closes the open card', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();
    await user.click(screen.getByRole('button', { name: /automation\.timer_triggers\.add/ }));
    expect(cards()).toHaveLength(4);
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    act(() => saveBarCapture.current!.onDismiss());
    expect(cards()).toHaveLength(3);
    expect(cards().every((c) => !c.hasAttribute('data-expanded'))).toBe(true);
    expect(saveBarCapture.current?.hasChanges).toBe(false);
  });

  it('Test opens the script test modal only when clicked, with the trigger script', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();
    // Text timers have no Test button.
    expect(within(cards()[1]).queryByRole('button', { name: /common\.test/ })).toBeNull();
    expect(screen.queryByTestId('script-test-modal')).toBeNull();

    await user.click(within(cards()[2]).getByRole('button', { name: /common\.test/ }));
    expect(screen.getByTestId('script-test-modal')).toBeInTheDocument();
    expect(scriptTestProps.current).toMatchObject({
      triggerType: 'timer', scriptPath: '/data/scripts/report.py', scriptArgs: '--x', timerId: 'extra',
    });
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('a 403 keeps the draft dirty', async () => {
    const user = userEvent.setup();
    csrfFetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const { onTriggersChange } = renderSection();
    await settle();
    await user.click(within(cards()[0]).getByRole('checkbox'));
    await save();
    expect(onTriggersChange).not.toHaveBeenCalled();
    expect(saveBarCapture.current?.hasChanges).toBe(true);
  });

  it('shows the filter only once there are more than five timers', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`, name: i === 4 ? 'Needle' : `Timer ${i}`, cronExpression: '0 * * * *', scriptPath: '/data/scripts/plain.sh', channel: 0 as const, enabled: true,
    }));
    const user = userEvent.setup();
    const five = renderSection(many.slice(0, 5));
    await settle();
    expect(screen.queryByRole('searchbox')).toBeNull();
    five.unmount();

    renderSection(many);
    await settle();
    await user.type(screen.getByRole('searchbox'), 'needle');
    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).getByText('Needle')).toBeInTheDocument();
  });
});
