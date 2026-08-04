/**
 * @vitest-environment jsdom
 *
 * MeshCoreTimerTriggersSection — receive-only mode (#4547 Phase 2 WP4).
 *
 * "Run now" is the second of the two immediate-TX controls WP4 gates (the
 * first is Auto-Announce's "Send Now"). Everything else in this section is
 * a saved trigger definition the scheduler reads later, so per interview
 * decision 5 it stays fully editable — only "Run now" disables, and only it
 * needs the direct `csrfFetch` 409 fallback (this handler doesn't go
 * through `useMeshCore`).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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

import { MeshCoreTimerTriggersSection } from './MeshCoreTimerTriggersSection';

const CONTROL_TOOLTIP = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';
const BLOCKED_TOAST = 'Receive-only mode is on for this MeshCore source — nothing was sent.';

const ONE_TRIGGER = [{
  id: 'tr1',
  name: 'Beacon',
  enabled: true,
  scheduleType: 'cron',
  cronExpression: '0 */6 * * *',
  responseType: 'text',
  response: 'hello',
  destination: 'channel',
  channelIndex: 0,
  scopeMode: 'inherit',
  scopeName: '',
}];

function mockFetch() {
  return vi.fn((url: string) => {
    if (url.includes('/automation/timers')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { triggers: ONE_TRIGGER } }) });
    }
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
    }
    if (url.includes('/api/scripts')) {
      return Promise.resolve({ ok: true, json: async () => ({ scripts: [] }) });
    }
    if (url.includes('/contacts')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

async function waitForRunNowEnabled() {
  await waitFor(() => {
    const btn = screen.getByRole('button', { name: /run now/i });
    expect(btn).not.toBeDisabled();
  });
}

describe('MeshCoreTimerTriggersSection receive-only', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockImplementation(mockFetch());
  });

  it('renders the paused note when receiveOnly is true, and nothing when false', async () => {
    const { rerender } = render(
      <MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" receiveOnly={false} />,
    );
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" receiveOnly />);
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(/receive-only mode/i);
  });

  it('disables Run now with the receive-only tooltip when receiveOnly is true', async () => {
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" receiveOnly />);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /run now/i });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', CONTROL_TOOLTIP);
    });
  });

  it('enables Run now (no tooltip) once its own preconditions are met and receiveOnly is false', async () => {
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" receiveOnly={false} />);
    await waitForRunNowEnabled();
    const btn = screen.getByRole('button', { name: /run now/i });
    expect(btn).not.toHaveAttribute('title');
  });

  it('leaves the trigger name input editable when receive-only', async () => {
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" receiveOnly />);
    await waitFor(() => {
      const input = screen.queryByDisplayValue('Beacon') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input).not.toBeDisabled();
    });
  });

  it('leaves the cron expression input editable when receive-only', async () => {
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" receiveOnly />);
    await waitFor(() => {
      const input = screen.queryByDisplayValue('0 */6 * * *') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input).not.toBeDisabled();
    });
  });

  it('runNow: a 409 TX_DISABLED response raises the receive-only toast, not the generic run-failed toast', async () => {
    csrfFetchMock.mockReset().mockImplementation((url: string) => {
      if (url.includes('/run')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ success: false, code: 'TX_DISABLED' }),
        });
      }
      return mockFetch()(url);
    });
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" receiveOnly={false} />);
    await waitForRunNowEnabled();

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(BLOCKED_TOAST, 'warning');
    });
    expect(showToastMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/run failed/i),
      'error',
    );
  });
});
