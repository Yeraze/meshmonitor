/**
 * @vitest-environment jsdom
 *
 * Meshtastic Auto Responder, one workflow with MeshCore (#5808):
 *   - Add trigger opens a new TriggerCard; Done validates and collapses it.
 *   - Delete asks first and only edits the draft; the SaveBar saves.
 *   - Triggers the user did not edit are saved byte-for-byte as loaded.
 *   - The test box matches locally and sends nothing.
 *   - The cooldown field blocks Done and the SaveBar while blank (#5649).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutoResponderSection from './AutoResponderSection';
import type { AutoResponderTrigger } from './auto-responder/types';
import type { Channel } from '../types/device';

const { csrfFetchMock, saveBarCapture } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  saveBarCapture: { current: null as null | { hasChanges: boolean; onSave: () => Promise<void>; numberScope?: { invalid: boolean } } },
}));
vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetchMock }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '' }));
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (o: NonNullable<typeof saveBarCapture.current>) => { saveBarCapture.current = o; },
}));
vi.mock('../services/api', () => ({ default: { get: vi.fn().mockResolvedValue({ scripts: [] }) } }));
vi.mock('./ScriptTestModal', () => ({ default: () => null }));

const channels: Channel[] = [
  { id: 0, name: 'Primary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
];

// Deliberately untidy saved shapes: a legacy single `channel`, an array
// pattern, an untrimmed response, an unknown extra field. A save must not
// "fix" any of them unless the user edited that trigger.
const SAVED: AutoResponderTrigger[] = [
  { id: 'legacy', trigger: 'hello', responseType: 'text', response: 'hi there ', channel: 0 },
  { id: 'multi', trigger: ['weather', 'weather {city}'], responseType: 'http', response: 'https://wttr.in/{city}', channels: ['dm', 0], multiline: true, cooldownSeconds: 30 },
  { id: 'extra', trigger: 'ping', responseType: 'text', response: 'pong {city}', channels: ['dm'], verifyResponse: true, extraField: 'keep me' } as AutoResponderTrigger,
];

function renderSection(triggers: AutoResponderTrigger[] = SAVED, enabled = true) {
  return render(
    <AutoResponderSection
      enabled={enabled}
      triggers={triggers}
      channels={channels}
      skipIncompleteNodes={false}
      baseUrl=""
      onEnabledChange={() => {}}
      onTriggersChange={() => {}}
      onSkipIncompleteNodesChange={() => {}}
    />,
  );
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const posts = () => csrfFetchMock.mock.calls.filter(([url, init]) =>
  String(url).includes('/api/settings') && (init as RequestInit | undefined)?.method === 'POST');
const savedTriggersJson = () => {
  const body = JSON.parse((posts()[posts().length - 1][1] as RequestInit).body as string);
  return body.autoResponderTriggers as string;
};
const save = async () => { await act(async () => { await saveBarCapture.current!.onSave(); }); };
const cards = () => screen.queryAllByTestId('trigger-card');

describe('AutoResponderSection hybrid workflow (#5808)', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
    csrfFetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  });

  it('shows saved triggers collapsed, with no inline add form', async () => {
    renderSection();
    await settle();
    expect(cards()).toHaveLength(3);
    expect(cards().every((c) => !c.hasAttribute('data-expanded'))).toBe(true);
    // The old inline add row and its Add / Clear buttons are gone.
    expect(screen.queryByRole('button', { name: 'common.add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'common.clear' })).toBeNull();
    expect(screen.getByRole('button', { name: /auto_responder\.add_trigger/ })).toBeInTheDocument();
  });

  it('saves untouched triggers byte-for-byte, even after opening and closing one', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    // Open a card and close it without changing anything.
    await user.click(within(cards()[0]).getByRole('button', { name: /common\.edit/ }));
    expect(cards()[0]).toHaveAttribute('data-expanded');
    await user.click(within(cards()[0]).getByRole('button', { name: /common\.done/ }));
    expect(cards()[0]).not.toHaveAttribute('data-expanded');
    expect(saveBarCapture.current?.hasChanges).toBe(false);

    // Change something unrelated (the section toggle) and save.
    await user.click(screen.getByLabelText('auto_responder.enable_aria'));
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await save();
    expect(savedTriggersJson()).toBe(JSON.stringify(SAVED));
  });

  it('Add trigger opens a new card; Done validates, then collapses; Save sends the normalised trigger', async () => {
    const user = userEvent.setup();
    renderSection([]);
    await settle();

    await user.click(screen.getByRole('button', { name: /auto_responder\.add_trigger/ }));
    expect(cards()).toHaveLength(1);
    const card = cards()[0];
    expect(card).toHaveAttribute('data-expanded');

    // Done on a blank trigger keeps it open and shows inline errors.
    await user.click(within(card).getByRole('button', { name: /common\.done/ }));
    expect(card).toHaveAttribute('data-expanded');
    expect(within(card).getAllByRole('alert').map((a) => a.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('auto_responder.trigger_empty'), expect.stringContaining('auto_responder.response_empty')]),
    );

    await user.type(within(card).getByLabelText('auto_responder.trigger_label'), 'status, stat {{node}');
    await user.type(within(card).getByLabelText('auto_responder.response_label'), '  all good {{node}  ');
    await user.click(within(card).getByLabelText(/Channel 0: Primary|auto_responder\.channel_option/));
    await user.click(within(card).getByRole('button', { name: /common\.done/ }));
    expect(cards()[0]).not.toHaveAttribute('data-expanded');

    await save();
    const saved = JSON.parse(savedTriggersJson()) as AutoResponderTrigger[];
    expect(saved).toHaveLength(1);
    const { id, ...rest } = saved[0];
    expect(typeof id).toBe('string');
    // Same shape the old Add / Save-edit paths produced.
    expect(rest).toEqual({
      trigger: ['status', 'stat {node}'],
      syntax: 'pattern',
      responseType: 'text',
      response: 'all good {node}',
      multiline: false,
      verifyResponse: false,
      channels: ['dm', 0],
    });
  });

  it('Save refuses an invalid edited trigger and opens it', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();
    await user.click(within(cards()[1]).getByRole('button', { name: /common\.edit/ }));
    const url = within(cards()[1]).getByLabelText('auto_responder.response_label');
    await user.clear(url);
    await user.type(url, 'ftp://nope');
    // Collapse is refused while invalid.
    await user.click(within(cards()[1]).getByRole('button', { name: /common\.done/ }));
    expect(cards()[1]).toHaveAttribute('data-expanded');
    await save();
    expect(posts()).toHaveLength(0);
    expect(within(cards()[1]).getByRole('alert')).toHaveTextContent('auto_responder.url_protocol');
  });

  it('Delete asks first, then removes the trigger from the draft only', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    await user.click(within(cards()[2]).getByRole('button', { name: /common\.delete/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('ping')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: /common\.delete/ }));
    expect(cards()).toHaveLength(2);
    // Nothing was sent until Save.
    expect(posts()).toHaveLength(0);

    await save();
    expect(savedTriggersJson()).toBe(JSON.stringify(SAVED.slice(0, 2)));
  });

  it('the test box matches locally, previews the reply, and sends nothing', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();
    csrfFetchMock.mockClear();

    const box = screen.getByLabelText(/auto_responder\.test_pattern_matching/);
    await user.clear(box);
    await user.type(box, 'weather Miami');
    const line = screen.getAllByTestId('pattern-test-line')[0];
    // The HTTP trigger matches with its parameter filled into the preview.
    expect(within(line).getByText('https://wttr.in/Miami')).toBeInTheDocument();
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('a blank cooldown blocks Done and the SaveBar until a number is typed (#5649)', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();
    await user.click(within(cards()[1]).getByRole('button', { name: /common\.edit/ }));
    const cooldown = within(cards()[1]).getByRole('spinbutton') as HTMLInputElement;
    expect(cooldown.value).toBe('30');

    await user.clear(cooldown);
    expect(cooldown.value).toBe('');
    expect(within(cards()[1]).getByRole('button', { name: /common\.done/ })).toBeDisabled();
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));

    await user.type(cooldown, '120');
    expect(within(cards()[1]).getByRole('button', { name: /common\.done/ })).not.toBeDisabled();
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(false));
    await user.click(within(cards()[1]).getByRole('button', { name: /common\.done/ }));
    await save();
    const saved = JSON.parse(savedTriggersJson()) as AutoResponderTrigger[];
    expect(saved[1].cooldownSeconds).toBe(120);
    // The other two are untouched.
    expect(JSON.stringify(saved[0])).toBe(JSON.stringify(SAVED[0]));
    expect(JSON.stringify(saved[2])).toBe(JSON.stringify(SAVED[2]));
  });

  it('turning the section off disables Add, Edit and Delete', async () => {
    renderSection(SAVED, false);
    await settle();
    expect(screen.getByRole('button', { name: /auto_responder\.add_trigger/ })).toBeDisabled();
    expect(within(cards()[0]).getByRole('button', { name: /common\.edit/ })).toBeDisabled();
    expect(within(cards()[0]).getByRole('button', { name: /common\.delete/ })).toBeDisabled();
  });

  it('a regex-mode trigger is saved unsplit and the test box matches it anywhere (#5924)', async () => {
    const user = userEvent.setup();
    renderSection([]);
    await settle();

    await user.click(screen.getByRole('button', { name: /auto_responder\.add_trigger/ }));
    const card = cards()[0];
    const mode = within(card).getByRole('combobox', { name: /responder_syntax\.label|Match mode/ }) as HTMLSelectElement;
    expect(mode.value).toBe('pattern');
    await user.selectOptions(mode, 'regex');
    // The commas in {1,3} would split a pattern; a regex stays whole.
    await user.type(within(card).getByLabelText('auto_responder.trigger_label'), '🔋\\s*(?<level>\\d{{1,3})');
    await user.type(within(card).getByLabelText('auto_responder.response_label'), 'level {{level}');
    await user.click(within(card).getByLabelText(/Channel 0: Primary|auto_responder\.channel_option/));
    await user.click(within(card).getByRole('button', { name: /common\.done/ }));
    expect(cards()[0]).not.toHaveAttribute('data-expanded');

    const box = screen.getByLabelText(/auto_responder\.test_pattern_matching/);
    await user.clear(box);
    await user.type(box, 'battery 🔋 42 left');
    const line = screen.getAllByTestId('pattern-test-line')[0];
    expect(within(line).getByText('level 42')).toBeInTheDocument();

    await save();
    const [saved] = JSON.parse(savedTriggersJson()) as AutoResponderTrigger[];
    expect(saved.syntax).toBe('regex');
    expect(saved.trigger).toBe('🔋\\s*(?<level>\\d{1,3})');
  });

  it('a saved trigger with no syntax is pattern mode, and the test box applies homoglyphs (#5924)', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();
    await user.click(within(cards()[0]).getByRole('button', { name: /common\.edit/ }));
    expect((within(cards()[0]).getByRole('combobox', { name: /responder_syntax\.label|Match mode/ }) as HTMLSelectElement).value).toBe('pattern');

    const box = screen.getByLabelText(/auto_responder\.test_pattern_matching/);
    await user.clear(box);
    // Cyrillic "е" and "о" in "hellо" normalise to Latin, as on the server.
    await user.type(box, 'h\u0435ll\u043e');
    const line = screen.getAllByTestId('pattern-test-line')[0];
    expect(within(line).getByText('hi there')).toBeInTheDocument();
  });
});
