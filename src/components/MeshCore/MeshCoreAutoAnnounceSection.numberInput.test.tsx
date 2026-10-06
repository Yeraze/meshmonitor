/**
 * @vitest-environment jsdom
 *
 * MeshCoreAutoAnnounceSection number fields (#5649).
 *
 * The announce interval is a mesh timer with a 1-hour floor. A value under the
 * floor, or a blank, must be blocked: never sent, never turned into 0, and
 * never quietly replaced by the floor.
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

import { MeshCoreAutoAnnounceSection } from './MeshCoreAutoAnnounceSection';

const posts = () => csrfFetchMock.mock.calls.filter(([url, init]) =>
  String(url).endsWith('/automation/announce') && (init as RequestInit | undefined)?.method === 'POST');
const lastBody = () => JSON.parse((posts()[posts().length - 1][1] as RequestInit).body as string);

async function renderLoaded() {
  render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" />);
  const input = (await screen.findByLabelText('Interval (hours)')) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe('6'));
  return input;
}

describe('MeshCoreAutoAnnounceSection announce interval (#5649)', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
    csrfFetchMock.mockReset().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/automation/announce/preview')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, preview: '' }) });
      }
      if (url.includes('/channels/all')) {
        return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
      }
      if (url.includes('/automation/announce') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { lastRunAt: null } }) });
      }
      if (url.includes('/automation/announce')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { enabled: true, channelIndexes: [0], intervalHours: 6, advertEnabled: false } }),
        });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
  });

  it('blocks an interval under the 1-hour floor: not sent, not 0, not the floor', async () => {
    const user = userEvent.setup();
    const interval = await renderLoaded();

    await user.clear(interval);
    await user.type(interval, '0');
    expect(interval.value).toBe('0');
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));
    // 0 was never handed to the section, so it does not even look dirty.
    expect(saveBarCapture.current?.hasChanges).toBe(false);

    // The real SaveBar refuses to save while invalid. Even a forced save
    // carries the last valid interval.
    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(lastBody().intervalHours).toBe(6);
  });

  it('blocks a blank interval and then saves the retyped integer', async () => {
    const user = userEvent.setup();
    const interval = await renderLoaded();

    await user.clear(interval);
    expect(interval.value).toBe('');
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));

    await user.type(interval, '12');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(false));
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(lastBody().intervalHours).toBe(12);
  });

  it('blocks an interval above the 168-hour limit', async () => {
    const user = userEvent.setup();
    const interval = await renderLoaded();

    await user.clear(interval);
    await user.type(interval, '500');
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));
  });

  it('Dismiss puts the saved interval back in a blank field', async () => {
    const user = userEvent.setup();
    const interval = await renderLoaded();

    await user.clear(interval);
    await user.tab();
    expect(interval.value).toBe('');

    // useSaveBar wires numberScope.reset() into Dismiss; the mock stands in for it.
    act(() => {
      saveBarCapture.current!.onDismiss();
      saveBarCapture.current!.numberScope!.reset();
    });
    await waitFor(() => expect(interval.value).toBe('6'));
    expect(interval).not.toHaveAttribute('aria-invalid');
  });
});
