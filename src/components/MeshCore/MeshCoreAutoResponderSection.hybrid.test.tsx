/**
 * @vitest-environment jsdom
 *
 * MeshCore Auto-Responder, one workflow with Meshtastic (#5808):
 *   - triggers show as collapsed TriggerCards with their own enable toggle;
 *   - Add trigger opens a new card; Done needs a name and a valid regex;
 *   - Delete asks first and only edits the draft;
 *   - untouched triggers are saved byte-for-byte as loaded;
 *   - the test box mirrors the server's case-insensitive, unanchored match
 *     and sends nothing.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
const { csrfFetchMock, saveBarCapture } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  saveBarCapture: { current: null as null | { hasChanges: boolean; onSave: () => Promise<void> } },
}));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetchMock }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (o: NonNullable<typeof saveBarCapture.current>) => { saveBarCapture.current = o; },
}));

import { MeshCoreAutoResponderSection } from './MeshCoreAutoResponderSection';

// One trigger without the optional fields (an older save), one complete.
const SAVED = [
  { id: 't1', name: 'Ping', enabled: true, pattern: '^ping', response: 'pong {VERSION}', channels: [0], listenDMs: true, replyAsDM: false, cooldownSeconds: 60 },
  { id: 't2', name: 'Help', enabled: true, pattern: 'help', responseType: 'text', response: 'see docs', channels: [], listenDMs: true, replyAsDM: true, cooldownSeconds: 0, preSendDelaySeconds: 5, scopeMode: 'inherit', scopeName: '' },
];

const posts = () => csrfFetchMock.mock.calls.filter(([url, init]) =>
  String(url).endsWith('/automation/responder') && (init as RequestInit | undefined)?.method === 'POST');
const lastBody = () => JSON.parse((posts()[posts().length - 1][1] as RequestInit).body as string);
const save = async () => { await act(async () => { await saveBarCapture.current!.onSave(); }); };
const cards = () => screen.queryAllByTestId('trigger-card');

async function renderLoaded(triggers: unknown[] = SAVED) {
  csrfFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/automation/responder') && init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    }
    if (url.includes('/automation/responder')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { enabled: true, triggers } }) });
    }
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
    }
    if (url.includes('/api/scripts')) {
      return Promise.resolve({ ok: true, json: async () => ({ scripts: [] }) });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
  render(<MeshCoreAutoResponderSection baseUrl="" sourceId="src1" />);
  if (triggers.length > 0) await waitFor(() => expect(cards()).toHaveLength(triggers.length));
  else await screen.findByText(/no triggers configured yet/i);
}

describe('MeshCoreAutoResponderSection hybrid workflow (#5808)', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
    csrfFetchMock.mockReset();
  });

  it('shows triggers collapsed with name, summary and chips; no always-open card or add card', async () => {
    await renderLoaded();
    expect(cards().every((c) => !c.hasAttribute('data-expanded'))).toBe(true);
    expect(within(cards()[0]).getByText('Ping')).toBeInTheDocument();
    expect(within(cards()[0]).getByText('/^ping/')).toBeInTheDocument();
    expect(within(cards()[0]).getByText('Primary')).toBeInTheDocument();
    expect(within(cards()[1]).getByText('Reply as DM')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('^ping')).toBeNull();
    expect(document.querySelector('.meshcore-add-card')).toBeNull();
  });

  it('saves untouched triggers byte-for-byte, after toggling one trigger and opening another', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(within(cards()[1]).getByRole('button', { name: /edit/i }));
    await user.click(within(cards()[1]).getByRole('button', { name: /done/i }));
    expect(saveBarCapture.current?.hasChanges).toBe(false);

    await user.click(within(cards()[0]).getByRole('checkbox', { name: 'Enable Ping' }));
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await save();
    const body = lastBody();
    expect(JSON.stringify(body.triggers[0])).toBe(JSON.stringify({ ...SAVED[0], enabled: false }));
    expect(JSON.stringify(body.triggers[1])).toBe(JSON.stringify(SAVED[1]));
  });

  it('Add trigger opens a new card; Done needs a name and a valid regex; Save sends every field', async () => {
    const user = userEvent.setup();
    await renderLoaded([]);

    await user.click(screen.getByRole('button', { name: /add trigger/i }));
    const card = cards()[0];
    expect(card).toHaveAttribute('data-expanded');

    await user.click(within(card).getByRole('button', { name: /done/i }));
    expect(card).toHaveAttribute('data-expanded');
    const alerts = within(card).getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toEqual(expect.arrayContaining(['Name is required', 'Pattern is required']));

    await user.type(within(card).getByPlaceholderText('Trigger name'), 'Status');
    await user.type(within(card).getByPlaceholderText('^(test|ping)'), '^status$');
    await user.type(within(card).getByPlaceholderText(/Response text/), 'up {{DURATION}');
    await user.click(within(card).getByRole('button', { name: /done/i }));
    expect(cards()[0]).not.toHaveAttribute('data-expanded');

    await save();
    const [saved] = lastBody().triggers;
    const { id, ...rest } = saved;
    expect(typeof id).toBe('string');
    expect(rest).toEqual({
      name: 'Status',
      enabled: true,
      pattern: '^status$',
      responseType: 'text',
      response: 'up {DURATION}',
      channels: [],
      listenDMs: true,
      replyAsDM: false,
      cooldownSeconds: 60,
      preSendDelaySeconds: 0,
      scopeMode: 'inherit',
      scopeName: '',
    });
  });

  it('a regex the server would reject keeps the card open and blocks Save', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(within(cards()[0]).getByRole('button', { name: /edit/i }));
    const pattern = within(cards()[0]).getByDisplayValue('^ping');
    await user.clear(pattern);
    await user.type(pattern, '(?=ping)');
    expect(within(cards()[0]).getByRole('alert')).toHaveTextContent(/lookaround/i);
    await user.click(within(cards()[0]).getByRole('button', { name: /done/i }));
    expect(cards()[0]).toHaveAttribute('data-expanded');
    await save();
    expect(posts()).toHaveLength(0);
  });

  it('Delete asks first, then removes the trigger from the draft only', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(within(cards()[0]).getByRole('button', { name: /delete/i }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(cards()).toHaveLength(2);

    await user.click(within(cards()[0]).getByRole('button', { name: /delete/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /delete/i }));
    expect(cards()).toHaveLength(1);
    expect(posts()).toHaveLength(0);

    await save();
    expect(JSON.stringify(lastBody().triggers)).toBe(JSON.stringify([SAVED[1]]));
  });

  it('the test box matches case-insensitively anywhere in the message, skips disabled triggers, and sends nothing', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const callsBefore = csrfFetchMock.mock.calls.length;

    const box = screen.getByRole('textbox', { name: /test a message/i });
    await user.type(box, 'PING please{Enter}I need HELP now');
    const lines = screen.getAllByTestId('pattern-test-line');
    expect(within(lines[0]).getByText('Ping')).toBeInTheDocument();
    // Raw template: tokens are filled in by the server when it replies.
    expect(within(lines[0]).getByText('pong {VERSION}')).toBeInTheDocument();
    expect(within(lines[1]).getByText('Help')).toBeInTheDocument();
    expect(within(lines[1]).queryByText('Ping')).toBeNull();

    // A disabled trigger does not reply.
    await user.click(within(cards()[0]).getByRole('checkbox', { name: 'Enable Ping' }));
    expect(within(screen.getAllByTestId('pattern-test-line')[0]).getByText(/no trigger matches/i)).toBeInTheDocument();

    expect(csrfFetchMock.mock.calls.length).toBe(callsBefore);
  });
});
