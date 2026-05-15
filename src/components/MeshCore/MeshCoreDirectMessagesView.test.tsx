/**
 * @vitest-environment jsdom
 *
 * Tests for the MeshCore DM/Node-Detail view's hosting of the per-node
 * telemetry-retrieval config panel. The panel was moved here from
 * `MeshCoreNodesView` and should only mount when:
 *   - the selected DM peer has a real 64-hex MeshCore pubkey, AND
 *   - the view is in per-source mode (sourceId + baseUrl are passed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

import { MeshCoreDirectMessagesView } from './MeshCoreDirectMessagesView';
import type { MeshCoreActions, ConnectionStatus, MeshCoreMessage } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

function makeActions(overrides: Partial<MeshCoreActions> = {}): MeshCoreActions {
  return {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(true),
    setDeviceName: vi.fn().mockResolvedValue(true),
    setRadioParams: vi.fn().mockResolvedValue(true),
    setCoords: vi.fn().mockResolvedValue(true),
    setAdvertLocPolicy: vi.fn().mockResolvedValue(true),
    setTelemetryModeBase: vi.fn().mockResolvedValue(true),
    setTelemetryModeLoc: vi.fn().mockResolvedValue(true),
    setTelemetryModeEnv: vi.fn().mockResolvedValue(true),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    ...overrides,
  };
}

function makeStatus(): ConnectionStatus {
  return {
    connected: true,
    deviceType: 1,
    deviceTypeName: 'companion',
    config: null,
    localNode: { publicKey: 'self'.padEnd(64, '0'), name: 'self', advType: 1 },
  };
}

const REAL_PK = 'a'.repeat(64);
const REAL_PK_2 = 'b'.repeat(64);

const realContact: MeshCoreContact = {
  publicKey: REAL_PK,
  advName: 'Remote Bob',
  advType: 1,
  rssi: -72,
  snr: 8.5,
  pathLen: 2,
  lastSeen: Date.now(),
};

const messages: MeshCoreMessage[] = [];

beforeEach(() => {
  csrfFetchMock.mockReset();
  csrfFetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: { enabled: false, intervalMinutes: 60, lastRequestAt: null },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
});

describe('MeshCoreDirectMessagesView — per-node telemetry-config panel', () => {
  it('renders the telemetry-retrieval panel when the selected peer has a real 64-hex pubkey and sourceId is set', async () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    // Pick the peer in the DM sidebar.
    fireEvent.click(screen.getByText('Remote Bob'));

    await waitFor(() => {
      expect(screen.getByText('Telemetry Retrieval')).toBeTruthy();
    });

    // Panel made its GET against the per-node telemetry-config endpoint.
    expect(csrfFetchMock).toHaveBeenCalled();
    const calledUrl = csrfFetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/sources/src-a/meshcore/nodes/');
    expect(calledUrl).toContain(REAL_PK);
    expect(calledUrl).toContain('/telemetry-config');
  });

  it('does NOT render the telemetry-retrieval panel when sourceId is not provided (singleton mode)', () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[realContact]}
        status={makeStatus()}
        actions={makeActions()}
      />,
    );

    fireEvent.click(screen.getByText('Remote Bob'));

    expect(screen.queryByText('Telemetry Retrieval')).toBeNull();
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('does NOT render the panel for a non-64-hex peer key (e.g. inbound prefix-only)', () => {
    const prefixOnly: MeshCoreContact = {
      publicKey: 'cafebabe1234', // 12 hex chars — fails the real-key gate
      advName: 'Prefix Pete',
      advType: 1,
    };

    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[prefixOnly]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    fireEvent.click(screen.getByText('Prefix Pete'));

    expect(screen.queryByText('Telemetry Retrieval')).toBeNull();
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('refetches telemetry config when switching from one real-pubkey peer to another', async () => {
    render(
      <MeshCoreDirectMessagesView
        messages={messages}
        contacts={[
          realContact,
          { ...realContact, publicKey: REAL_PK_2, advName: 'Remote Carol' },
        ]}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    fireEvent.click(screen.getByText('Remote Bob'));
    await waitFor(() => {
      const urls = csrfFetchMock.mock.calls.map(c => c[0] as string);
      expect(urls.some(u => u.includes(REAL_PK))).toBe(true);
    });

    fireEvent.click(screen.getByText('Remote Carol'));
    await waitFor(() => {
      const urls = csrfFetchMock.mock.calls.map(c => c[0] as string);
      expect(urls.some(u => u.includes(REAL_PK_2))).toBe(true);
    });
  });
});
