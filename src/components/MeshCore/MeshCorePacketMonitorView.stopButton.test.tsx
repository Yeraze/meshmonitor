/**
 * @vitest-environment jsdom
 *
 * #4957: the MeshCore Packet Monitor must expose a Stop control in the
 * always-visible toolbar so a persisted server-side capture can be turned off
 * without digging into the Filters panel. Capture state is the global
 * `meshcore_packet_log_enabled` setting, POSTed to /api/settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

let hasPermissionImpl: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => hasPermissionImpl(r, a) }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: null } }),
}));

import { MeshCorePacketMonitorView } from './MeshCorePacketMonitorView';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const loadResponse = (enabled: boolean) =>
  jsonResponse({ packets: [], enabled, maxCount: 1000, maxAgeHours: 24 });

describe('MeshCorePacketMonitorView Stop button (#4957)', () => {
  const baseUrl = '';
  const sourceId = 'mc-1';

  beforeEach(() => {
    csrfFetchMock.mockReset();
    hasPermissionImpl = () => true;
  });

  it('shows Stop while capturing and POSTs 0 to stop', async () => {
    csrfFetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return jsonResponse({ success: true });
      return loadResponse(true); // /packets load reports capture on
    });

    render(<MeshCorePacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    const stopBtn = await screen.findByTitle('Stop capturing');
    fireEvent.click(stopBtn);

    await waitFor(() => {
      const postCall = csrfFetchMock.mock.calls.find(
        ([, o]) => (o as RequestInit | undefined)?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const [url, options] = postCall!;
      expect(url).toBe(`${baseUrl}/api/settings`);
      expect(JSON.parse((options as RequestInit).body as string)).toEqual({ meshcore_packet_log_enabled: '0' });
    });
  });

  it('shows Start when capture is off and POSTs 1 to start', async () => {
    csrfFetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return jsonResponse({ success: true });
      return loadResponse(false);
    });

    render(<MeshCorePacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    const startBtn = await screen.findByTitle('Start capturing');
    fireEvent.click(startBtn);

    await waitFor(() => {
      const postCall = csrfFetchMock.mock.calls.find(
        ([, o]) => (o as RequestInit | undefined)?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ meshcore_packet_log_enabled: '1' });
    });
  });

  it('hides the Stop/Start control without settings:write', async () => {
    csrfFetchMock.mockImplementation(async () => loadResponse(true));
    hasPermissionImpl = (resource) => resource !== 'settings';

    render(<MeshCorePacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    // Wait for the load to settle (Pause control is always present).
    await screen.findByTitle('Pause');
    expect(screen.queryByTitle('Stop capturing')).toBeNull();
    expect(screen.queryByTitle('Start capturing')).toBeNull();
  });
});
