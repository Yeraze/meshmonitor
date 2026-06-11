/**
 * @vitest-environment jsdom
 *
 * Issue #3413: when an OTA flash is blocked by Safety Rail 5 (half-flash
 * marker), the wizard surfaces an inline recovery panel instead of the raw
 * "DELETE /api/firmware/recovery-marker/..." toast. The "Clear Flag & Retry"
 * action is gated on a basic "node is online and accepting connections" check
 * derived from the live poll connection state.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- hoisted mutable mock state -----------------------------------------
const h = vi.hoisted(() => ({
  pollData: {
    connection: { connected: true, nodeResponsive: true },
    config: {
      localNodeInfo: { nodeId: '!9ea3e00c', nodeNum: 123 },
      meshtasticNodeIp: '1.2.3.4',
      meshtasticSourceType: 'meshtastic_tcp',
      deviceMetadata: { firmwareVersion: '2.5.0' },
    },
    nodes: [] as unknown[],
  },
  statusResponse: {
    success: true,
    status: {
      state: 'awaiting-confirm',
      step: 'preflight',
      message: 'Ready to begin',
      logs: [] as string[],
      preflightInfo: { gatewayIp: '1.2.3.4' },
    },
    channel: 'stable',
    customUrl: '',
    lastChecked: null,
  },
  csrfFetch: vi.fn(),
  showToast: vi.fn(),
}));

// --- mocks ---------------------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : _key,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = JSON.stringify(opts.queryKey);
    if (key === JSON.stringify(['firmware', 'status'])) return { data: h.statusResponse };
    if (key === JSON.stringify(['firmware', 'releases']))
      return { data: { success: true, releases: [], channel: 'stable' } };
    if (key === JSON.stringify(['firmware', 'backups']))
      return { data: { success: true, backups: [] } };
    return { data: undefined };
  },
  useQueryClient: () => ({
    getQueryData: () => undefined,
    invalidateQueries: vi.fn(),
    removeQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../../hooks/usePoll', () => ({ usePoll: () => ({ data: h.pollData }) }));
vi.mock('../../contexts/DataContext', () => ({
  useData: () => ({ setConnectionStatus: vi.fn() }),
}));

import FirmwareUpdateSection from './FirmwareUpdateSection';

const resp = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const HALF_FLASH_409 = {
  success: false,
  error:
    'Node "!9ea3e00c" is flagged as half-flashed from a previous OTA attempt. ' +
    'Recover via USB, then DELETE /api/firmware/recovery-marker/!9ea3e00c to clear the flag.',
};

beforeEach(() => {
  h.csrfFetch.mockReset();
  h.showToast.mockReset();
  h.pollData.connection = { connected: true, nodeResponsive: true };
});

describe('FirmwareUpdateSection — half-flash recovery panel (issue #3413)', () => {
  it('shows the inline recovery panel (not a raw toast) when confirm returns the 409', async () => {
    h.csrfFetch.mockImplementation((url: string) => {
      if (url.includes('/update/confirm')) return Promise.resolve(resp(409, HALF_FLASH_409));
      return Promise.resolve(resp(200, {}));
    });

    render(<FirmwareUpdateSection baseUrl="" />);
    fireEvent.click(screen.getByText('Confirm & Proceed'));

    await screen.findByText('Device flagged as half-flashed');
    // The raw "DELETE /api/..." instruction is NOT surfaced as a toast.
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it('online node: the clear-and-retry button is enabled and re-runs confirm after clearing', async () => {
    let confirmCalls = 0;
    let deletedUrl = '';
    h.csrfFetch.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.includes('/update/confirm')) {
        confirmCalls += 1;
        return Promise.resolve(confirmCalls === 1 ? resp(409, HALF_FLASH_409) : resp(200, { success: true }));
      }
      if (opts?.method === 'DELETE' && url.includes('/recovery-marker/')) {
        deletedUrl = url;
        return Promise.resolve(resp(200, { success: true, removed: 1 }));
      }
      return Promise.resolve(resp(200, {}));
    });

    render(<FirmwareUpdateSection baseUrl="" />);
    fireEvent.click(screen.getByText('Confirm & Proceed'));

    const clearBtn = await screen.findByText("I've Recovered via USB — Clear Flag & Retry");
    expect((clearBtn as HTMLButtonElement).disabled).toBe(false);
    expect(
      screen.getByText('Node is online and accepting connections — it appears to have recovered.')
    ).toBeTruthy();

    fireEvent.click(clearBtn);

    await waitFor(() => expect(confirmCalls).toBe(2));
    // Marker cleared for the encoded nodeId, then the confirm step re-ran.
    expect(deletedUrl).toContain('/recovery-marker/');
    expect(deletedUrl).toContain(encodeURIComponent('!9ea3e00c'));
  });

  it('offline node: the clear-and-retry button is disabled and the offline hint is shown', async () => {
    h.pollData.connection = { connected: false, nodeResponsive: false };
    h.csrfFetch.mockImplementation((url: string) => {
      if (url.includes('/update/confirm')) return Promise.resolve(resp(409, HALF_FLASH_409));
      return Promise.resolve(resp(200, {}));
    });

    render(<FirmwareUpdateSection baseUrl="" />);
    fireEvent.click(screen.getByText('Confirm & Proceed'));

    const clearBtn = await screen.findByText("I've Recovered via USB — Clear Flag & Retry");
    expect((clearBtn as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        'Node is not online and accepting connections yet. Recover it via USB and wait for it to reconnect.'
      )
    ).toBeTruthy();
  });
});
