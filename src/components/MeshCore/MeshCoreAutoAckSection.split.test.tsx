/**
 * @vitest-environment jsdom
 *
 * MeshCoreAutoAckSection — "Split long messages" toggle (#5564).
 *
 * Default off; the airtime warning sits next to the toggle whether it is on
 * or off, so the operator reads it before opting in.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { hasPermissionMock } = vi.hoisted(() => ({ hasPermissionMock: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

interface SaveBarOptions { hasChanges: boolean; onSave: () => Promise<void>; onDismiss: () => void; }
const { saveBarCapture } = vi.hoisted(() => ({ saveBarCapture: { current: null as unknown } }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    saveBarCapture.current = options;
  },
}));
const saveBar = () => saveBarCapture.current as SaveBarOptions;

import { MeshCoreAutoAckSection } from './MeshCoreAutoAckSection';

const AUTOACK_URL = '/api/sources/src1/meshcore/automation/autoack';

function mockServer(data: Record<string, unknown>) {
  csrfFetchMock.mockReset().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/automation/autoack')) {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
    }
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

const toggle = () => document.getElementById('meshcoreAutoAckSplitLongMessages') as HTMLInputElement;

async function renderLoaded(data: Record<string, unknown>) {
  mockServer(data);
  render(<MeshCoreAutoAckSection baseUrl="" sourceId="src1" />);
  // The regex input reflects loaded data, so this waits for the GET to land.
  await waitFor(() => expect(document.getElementById('meshcoreAutoAckRegex')).not.toBeDisabled());
}

describe('MeshCoreAutoAckSection — split long messages (#5564)', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    saveBarCapture.current = null;
  });

  it('is off by default when the server does not send the field', async () => {
    await renderLoaded({ enabled: true });
    expect(toggle()).not.toBeNull();
    expect(toggle().checked).toBe(false);
    expect(screen.getByLabelText('Split long messages')).toBe(toggle());
  });

  it('reflects a saved "on" value', async () => {
    await renderLoaded({ enabled: true, splitLongMessages: true });
    await waitFor(() => expect(toggle().checked).toBe(true));
  });

  it('shows the airtime warning next to the toggle, on or off', async () => {
    await renderLoaded({ enabled: true });
    const warning = screen.getByRole('note');
    expect(warning).toHaveTextContent('Long replies go out as up to 3 messages');
    expect(warning).toHaveTextContent('Each one is repeated by every repeater in range.');
    // Same setting block as the toggle.
    expect(warning.closest('.setting-item')).toBe(toggle().closest('.setting-item'));

    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);
    expect(screen.getByRole('note')).toHaveTextContent('Each one is repeated by every repeater in range.');
  });

  it('marks the section dirty and posts splitLongMessages on save', async () => {
    await renderLoaded({ enabled: true });
    expect(saveBar().hasChanges).toBe(false);

    fireEvent.click(toggle());
    await waitFor(() => expect(saveBar().hasChanges).toBe(true));

    await act(async () => { await saveBar().onSave(); });
    const post = csrfFetchMock.mock.calls.find(([url, init]) => url === AUTOACK_URL && init?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post![1].body as string).splitLongMessages).toBe(true);
    await waitFor(() => expect(saveBar().hasChanges).toBe(false));
  });

  it('posts false when left off', async () => {
    await renderLoaded({ enabled: true });
    await act(async () => { await saveBar().onSave(); });
    const post = csrfFetchMock.mock.calls.find(([url, init]) => url === AUTOACK_URL && init?.method === 'POST');
    expect(JSON.parse(post![1].body as string).splitLongMessages).toBe(false);
  });

  it('reverts the toggle on dismiss', async () => {
    await renderLoaded({ enabled: true });
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);
    act(() => saveBar().onDismiss());
    expect(toggle().checked).toBe(false);
  });

  it('disables the toggle without automation:write', async () => {
    hasPermissionMock.mockReturnValue(false);
    mockServer({ enabled: true });
    render(<MeshCoreAutoAckSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(toggle()).toBeDisabled();
  });

  it('disables the toggle while Auto-Acknowledge itself is off', async () => {
    mockServer({ enabled: false });
    render(<MeshCoreAutoAckSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(toggle()).toBeDisabled();
  });
});
