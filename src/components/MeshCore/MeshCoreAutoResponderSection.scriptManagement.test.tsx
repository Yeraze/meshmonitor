/**
 * @vitest-environment jsdom
 *
 * MeshCore Auto-Responder Script Management panel (#6223):
 *   - the shared ScriptManagement panel renders inline, listing scripts from
 *     the global /api/scripts library (parity with the Meshtastic responder);
 *   - deleting a script through the panel re-fetches /api/scripts so the
 *     responseType='script' picker and the panel list both refresh.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
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

const SCRIPTS = [
  { path: '/data/scripts/weather.py', filename: 'weather.py', name: 'Weather', language: 'Python' },
  { path: '/data/scripts/ping.sh', filename: 'ping.sh', language: 'Shell' },
];

// Count of GET /api/scripts calls (no POST/DELETE body/method).
const scriptGets = () => csrfFetchMock.mock.calls.filter(([url, init]) =>
  String(url).endsWith('/api/scripts') && !(init as RequestInit | undefined)?.method);

function mockFetch(scripts: unknown[]) {
  csrfFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/automation/responder')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { enabled: true, triggers: [] } }) });
    }
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
    }
    if (url.includes('/api/scripts/') && init?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    }
    if (url.endsWith('/api/scripts')) {
      return Promise.resolve({ ok: true, json: async () => ({ scripts }) });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

describe('MeshCoreAutoResponderSection Script Management (#6223)', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
    csrfFetchMock.mockReset();
  });

  it('renders the shared Script Management panel inline', async () => {
    mockFetch(SCRIPTS);
    render(<MeshCoreAutoResponderSection baseUrl="" sourceId="src1" />);
    // The panel's collapsible header uses the shared auto_responder key.
    expect(await screen.findByText('auto_responder.script_management')).toBeInTheDocument();
  });

  it('lists the global /api/scripts library and refreshes it after a delete', async () => {
    const user = userEvent.setup();
    mockFetch(SCRIPTS);
    render(<MeshCoreAutoResponderSection baseUrl="" sourceId="src1" />);

    // Open the panel.
    await user.click(await screen.findByText('auto_responder.script_management'));

    // Both library scripts are listed (shared with the Meshtastic panel).
    expect(await screen.findByText(/weather\.py/)).toBeInTheDocument();
    expect(screen.getByText(/ping\.sh/)).toBeInTheDocument();

    const getsBefore = scriptGets().length;
    expect(getsBefore).toBeGreaterThanOrEqual(1);

    // Delete the first script via the panel → confirm in the modal.
    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
    await user.click(deleteButtons[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^(auto_responder\.deleting|common\.delete|delete)$/i }));

    // A DELETE went out, then /api/scripts was re-fetched (picker + panel refresh).
    await waitFor(() => {
      const delCall = csrfFetchMock.mock.calls.find(([url, init]) =>
        String(url).includes('/api/scripts/') && (init as RequestInit | undefined)?.method === 'DELETE');
      expect(delCall).toBeTruthy();
    });
    await waitFor(() => expect(scriptGets().length).toBeGreaterThan(getsBefore));
  });
});
