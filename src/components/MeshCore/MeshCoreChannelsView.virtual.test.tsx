/**
 * @vitest-environment jsdom
 *
 * MeshCore virtual channels on a Companion's Channels page (#6159).
 *
 * A virtual channel (a Channel Database key the radio does not hold) is listed
 * by /api/channels/all with `virtual: true`. The view marks it `(Virtual)` and
 * hides the send bar when it is selected, because the key is not on the radio
 * and the channel is therefore receive-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/AuthContext', async () => ({
  AuthContext: (await import('react')).createContext(null),
  useAuth: () => ({ hasPermission: () => true }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

import { MeshCoreChannelsView } from './MeshCoreChannelsView';
import type { MeshCoreActions, ConnectionStatus } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeActions(): MeshCoreActions {
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
    getDefaultScope: vi.fn().mockResolvedValue(''),
    discoverRegions: vi.fn().mockResolvedValue({ regions: [] }),
    fetchSavedRegions: vi.fn().mockResolvedValue([]),
  } as unknown as MeshCoreActions;
}

function makeStatus(): ConnectionStatus {
  return {
    connected: true,
    deviceType: 1,
    deviceTypeName: 'companion',
    config: null,
    localNode: { publicKey: 'local-pubkey'.padEnd(64, '0'), name: 'self', advType: 1 },
  } as ConnectionStatus;
}

const CHANNELS = [
  { id: 1, name: 'Town' },
  { id: 1001, name: 'Secret Room', keyed: true, readOnly: true, virtual: true },
];

beforeEach(() => {
  csrfFetchMock.mockReset();
  csrfFetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/channels/all')) {
      return Promise.resolve(jsonResponse(CHANNELS));
    }
    // channel backlog + counts endpoints
    return Promise.resolve(jsonResponse({ success: true, data: [], hasMore: false }));
  });
});

function renderView() {
  return render(
    <MeshCoreChannelsView
      messages={[]}
      contacts={[] as MeshCoreContact[]}
      status={makeStatus()}
      actions={makeActions()}
      baseUrl=""
      sourceId="src-companion"
    />,
  );
}

describe('MeshCoreChannelsView — virtual channels (#6159)', () => {
  it('marks a virtual channel with a (Virtual) tag in the list', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Secret Room')).toBeTruthy());
    expect(screen.getByText('(Virtual)')).toBeTruthy();
    // A normal channel carries no (Virtual) tag.
    expect(screen.getByText('Town')).toBeTruthy();
  });

  it('shows the send bar on a normal channel but hides it on a virtual channel', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Town')).toBeTruthy());

    // Normal channel: the composer is present.
    fireEvent.click(screen.getByText('Town'));
    await waitFor(() => expect(screen.getByPlaceholderText('Type a message…')).toBeTruthy());

    // Virtual channel: the composer (text box + Send button) is hidden.
    fireEvent.click(screen.getByText('Secret Room'));
    await waitFor(() => expect(screen.queryByPlaceholderText('Type a message…')).toBeNull());
    expect(screen.queryByText('Send')).toBeNull();
  });
});
