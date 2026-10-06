/**
 * @vitest-environment jsdom
 *
 * MeshCoreAutoResponderSection number fields (#5649).
 *
 * The cooldown used to be bound through
 * `Math.max(0, Math.min(3600, parseInt(v, 10) || 0))`, so clearing it put "0"
 * straight back. It now clears, shows invalid, blocks the SaveBar, and the
 * saved trigger carries the retyped integer.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

interface CapturedSaveBar {
  hasChanges: boolean;
  onSave: () => Promise<void>;
  onDismiss: () => void;
  numberScope?: { invalid: boolean; reset: () => void };
}
const { saveBarCapture } = vi.hoisted(() => ({ saveBarCapture: { current: null as null | CapturedSaveBar } }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: CapturedSaveBar) => {
    saveBarCapture.current = options;
  },
}));

import { MeshCoreAutoResponderSection } from './MeshCoreAutoResponderSection';

const ONE_TRIGGER = [{
  id: 't1',
  name: 'Ping',
  enabled: true,
  pattern: '^ping',
  responseType: 'text',
  response: 'pong',
  channels: [],
  listenDMs: true,
  replyAsDM: false,
  cooldownSeconds: 60,
  preSendDelaySeconds: 5,
  scopeMode: 'inherit',
  scopeName: '',
}];

const posts = () => csrfFetchMock.mock.calls.filter(([url, init]) =>
  String(url).endsWith('/automation/responder') && (init as RequestInit | undefined)?.method === 'POST');

async function renderLoaded() {
  render(<MeshCoreAutoResponderSection baseUrl="" sourceId="src1" />);
  return (await screen.findByDisplayValue('60')) as HTMLInputElement;
}

describe('MeshCoreAutoResponderSection number fields (#5649)', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
    csrfFetchMock.mockReset().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/automation/responder') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
      if (url.includes('/automation/responder')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { enabled: true, triggers: ONE_TRIGGER } }) });
      }
      if (url.includes('/channels/all')) {
        return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
      }
      if (url.includes('/api/scripts')) {
        return Promise.resolve({ ok: true, json: async () => ({ scripts: [] }) });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
  });

  it('clears the cooldown, blocks Save while blank, and saves the retyped integer', async () => {
    const user = userEvent.setup();
    const cooldown = await renderLoaded();
    expect(saveBarCapture.current?.numberScope?.invalid).toBe(false);

    await user.click(cooldown);
    await user.keyboard('{Backspace}{Backspace}');
    // Blank stays blank: no "0", no "60" put back.
    expect(cooldown.value).toBe('');
    expect(cooldown).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));

    await user.keyboard('120');
    expect(cooldown.value).toBe('120');
    expect(cooldown).not.toHaveAttribute('aria-invalid');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(false));
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(posts()).toHaveLength(1);
    const body = JSON.parse((posts()[0][1] as RequestInit).body as string);
    expect(body.triggers[0].cooldownSeconds).toBe(120);
    expect(body.triggers[0].preSendDelaySeconds).toBe(5);
  });

  it('never hands the section a blank, NaN or 0-for-blank cooldown', async () => {
    const user = userEvent.setup();
    const cooldown = await renderLoaded();

    await user.clear(cooldown);
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));

    // The real SaveBar refuses to save while invalid. Even if a save ran, the
    // trigger still holds its last valid cooldown, not 0.
    await act(async () => { await saveBarCapture.current!.onSave(); });
    const body = JSON.parse((posts()[0][1] as RequestInit).body as string);
    expect(body.triggers[0].cooldownSeconds).toBe(60);
  });

  it('blocks a cooldown above the 3600 s limit instead of clamping it', async () => {
    const user = userEvent.setup();
    const cooldown = await renderLoaded();

    await user.clear(cooldown);
    await user.type(cooldown, '99999');
    expect(cooldown.value).toBe('99999');
    expect(cooldown).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));
  });

  it('blocks a pre-send delay above 120 s', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const delay = screen.getByDisplayValue('5') as HTMLInputElement;

    await user.clear(delay);
    await user.type(delay, '121');
    expect(delay).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));
  });
});
