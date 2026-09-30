/**
 * @vitest-environment jsdom
 *
 * #5500: a Repeater source's empty Packet Monitor explains that stock
 * repeater firmware does not stream packets over serial (a MESH_PACKET_LOGGING
 * build does).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

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

describe('MeshCorePacketMonitorView — Repeater source empty state (#5500)', () => {
  beforeEach(() => {
    csrfFetchMock.mockReset();
    hasPermissionImpl = () => true;
    csrfFetchMock.mockImplementation(async () => loadResponse(true));
  });

  it('explains the MESH_PACKET_LOGGING requirement on an empty Repeater log', async () => {
    render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-rep" isRepeaterSource />);
    const note = await screen.findByTestId('mcpm-repeater-note');
    expect(note.textContent).toMatch(/does not stream packets over serial/);
    expect(note.textContent).toMatch(/MESH_PACKET_LOGGING=1/);
    expect(screen.getByText(/Waiting for OTA traffic/)).toBeInTheDocument();
  });

  it('shows no Repeater note for other sources', async () => {
    render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-1" />);
    await waitFor(() => expect(screen.getByText(/Waiting for OTA traffic/)).toBeInTheDocument());
    expect(screen.queryByTestId('mcpm-repeater-note')).not.toBeInTheDocument();
  });

  it('hides the note once packets exist', async () => {
    csrfFetchMock.mockImplementation(async () =>
      jsonResponse({
        packets: [{ id: 1, sourceId: 'mc-rep', timestamp: 1_790_000_000_000, payloadType: 5, routeType: 1, hopCount: 0, snr: 7, rssi: -92, rawHex: '1540' }],
        enabled: true, maxCount: 1000, maxAgeHours: 24,
      }));
    render(<MeshCorePacketMonitorView baseUrl="" sourceId="mc-rep" isRepeaterSource />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.queryByTestId('mcpm-repeater-note')).not.toBeInTheDocument();
  });
});
