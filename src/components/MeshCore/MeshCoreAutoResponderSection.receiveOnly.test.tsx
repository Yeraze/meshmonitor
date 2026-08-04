/**
 * @vitest-environment jsdom
 *
 * MeshCoreAutoResponderSection — receive-only mode (#4547 Phase 2 WP4).
 *
 * No immediate-TX control lives in this section (Auto-Responder only fires
 * from the scheduler on an incoming message match, never from a button
 * here), so the only receive-only behavior is the paused note. Interview
 * decision 5: configuration inputs stay fully editable while receive-only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

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

const { saveBarCapture } = vi.hoisted(() => ({ saveBarCapture: { current: null as unknown } }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
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
  cooldownSeconds: 0,
  preSendDelaySeconds: 0,
  scopeMode: 'inherit',
  scopeName: '',
}];

describe('MeshCoreAutoResponderSection receive-only', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockImplementation((url: string) => {
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

  it('renders the paused note when receiveOnly is true, and nothing when false', async () => {
    const { rerender } = render(
      <MeshCoreAutoResponderSection baseUrl="" sourceId="src1" receiveOnly={false} />,
    );
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<MeshCoreAutoResponderSection baseUrl="" sourceId="src1" receiveOnly />);
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(/receive-only mode/i);
  });

  it('leaves an existing trigger\'s pattern input editable when receive-only', async () => {
    render(<MeshCoreAutoResponderSection baseUrl="" sourceId="src1" receiveOnly />);
    await waitFor(() => {
      const input = screen.queryByDisplayValue('^ping') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input).not.toBeDisabled();
    });
  });

  it('leaves the master enable checkbox editable regardless of receiveOnly', async () => {
    const { container } = render(<MeshCoreAutoResponderSection baseUrl="" sourceId="src1" receiveOnly />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    const master = container.querySelector('.automation-section-header input[type="checkbox"]');
    expect(master).not.toBeNull();
    expect(master).not.toBeDisabled();
  });
});
