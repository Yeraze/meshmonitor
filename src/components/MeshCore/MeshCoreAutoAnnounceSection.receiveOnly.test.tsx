/**
 * @vitest-environment jsdom
 *
 * MeshCoreAutoAnnounceSection — receive-only mode (#4547 Phase 2 WP4).
 *
 * "Send Now" is one of the two immediate-TX controls WP4 gates (the other is
 * Timer Triggers' "Run now"). Everything else in this section is a saved
 * setting the scheduler reads later, so per interview decision 5 it stays
 * fully editable — only "Send Now" disables, and only it needs the direct
 * `csrfFetch` 409 fallback (this handler doesn't go through `useMeshCore`).
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

import { MeshCoreAutoAnnounceSection } from './MeshCoreAutoAnnounceSection';

const CONTROL_TOOLTIP = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';
const BLOCKED_TOAST = 'Receive-only mode is on for this MeshCore source — nothing was sent.';

function mockFetch() {
  return vi.fn((url: string) => {
    if (url.includes('/automation/announce/preview')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, preview: '' }) });
    }
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
    }
    if (url.includes('/automation/announce/send')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
    }
    if (url.includes('/automation/announce')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { enabled: true, channelIndexes: [0] } }),
      });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

async function waitForSendNowEnabled() {
  await waitFor(() => {
    const btn = screen.getByRole('button', { name: /send now/i });
    expect(btn).not.toBeDisabled();
  });
}

describe('MeshCoreAutoAnnounceSection receive-only', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockImplementation(mockFetch());
  });

  it('renders the paused note when receiveOnly is true, and nothing when false', async () => {
    const { rerender } = render(
      <MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" receiveOnly={false} />,
    );
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" receiveOnly />);
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(/receive-only mode/i);
  });

  it('disables Send Now with the receive-only tooltip when receiveOnly is true', async () => {
    render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" receiveOnly />);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /send now/i });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', CONTROL_TOOLTIP);
    });
  });

  it('enables Send Now (no tooltip) once its own preconditions are met and receiveOnly is false', async () => {
    render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" receiveOnly={false} />);
    await waitForSendNowEnabled();
    const btn = screen.getByRole('button', { name: /send now/i });
    expect(btn).not.toHaveAttribute('title');
  });

  it('leaves the message template textarea editable when receive-only and the section is enabled', async () => {
    render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" receiveOnly />);
    await waitFor(() => {
      const textarea = document.getElementById('meshcoreAnnounceMessage') as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      expect(textarea).not.toBeDisabled();
    });
  });

  it('leaves the master enable checkbox editable regardless of receiveOnly', async () => {
    const { container } = render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" receiveOnly />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    const master = container.querySelector('.automation-section-header input[type="checkbox"]');
    expect(master).not.toBeNull();
    expect(master).not.toBeDisabled();
  });

  it('sendNow: a 409 TX_DISABLED response raises the receive-only toast, not the generic failure toast', async () => {
    csrfFetchMock.mockReset().mockImplementation((url: string) => {
      if (url.includes('/automation/announce/send')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ success: false, code: 'TX_DISABLED' }),
        });
      }
      return mockFetch()(url);
    });
    render(<MeshCoreAutoAnnounceSection baseUrl="" sourceId="src1" receiveOnly={false} />);
    await waitForSendNowEnabled();

    fireEvent.click(screen.getByRole('button', { name: /send now/i }));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(BLOCKED_TOAST, 'warning');
    });
    expect(showToastMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/failed to send announcement/i),
      'error',
    );
  });
});
