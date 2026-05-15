/**
 * @vitest-environment jsdom
 *
 * Tests for MeshCoreChannelsView phase 2:
 *   - reads the channel list from /api/channels/all?sourceId=...
 *   - falls back to a synthetic Channel 0 when the API returns nothing
 *   - filters messages per channel (received + locally-sent)
 *   - passes the active channelIdx to actions.sendMessage on broadcast
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, vars?: Record<string, unknown>) => {
      // Mimic i18next interpolation for the {{idx}} placeholder used by the
      // "unnamed channel" fallback so tests can assert on the rendered string.
      if (typeof fallback === 'string') {
        if (vars && typeof vars === 'object') {
          return fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String((vars as any)[k] ?? ''));
        }
        return fallback;
      }
      // when fallback was actually an interpolation `values` object, return key
      return key;
    },
  }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

import { MeshCoreChannelsView } from './MeshCoreChannelsView';
import type { MeshCoreActions, ConnectionStatus, MeshCoreMessage } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
    localNode: { publicKey: 'local-pubkey'.padEnd(64, '0'), name: 'self', advType: 1 },
  };
}

const contacts: MeshCoreContact[] = [];

beforeEach(() => {
  csrfFetchMock.mockReset();
});

describe('MeshCoreChannelsView — channel list rendering', () => {
  it('renders a tab for each channel returned by /api/channels/all', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 0, name: 'Public' },
        { id: 1, name: 'Town' },
        { id: 2, name: 'Operators' },
      ]),
    );

    render(
      <MeshCoreChannelsView
        messages={[]}
        contacts={contacts}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('# Public')).toBeTruthy();
      expect(screen.getByText('# Town')).toBeTruthy();
      expect(screen.getByText('# Operators')).toBeTruthy();
    });

    // Called the source-scoped /all endpoint.
    expect(csrfFetchMock).toHaveBeenCalled();
    const calledUrl = csrfFetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/channels/all?sourceId=src-a');
  });

  it('falls back to a synthetic Public channel when the API returns nothing', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse([]));

    render(
      <MeshCoreChannelsView
        messages={[]}
        contacts={contacts}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-empty"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('# Public')).toBeTruthy();
    });
  });

  it('substitutes "Channel N" when the device reports a blank channel name', async () => {
    csrfFetchMock.mockResolvedValueOnce(jsonResponse([
      { id: 0, name: 'Public' },
      { id: 5, name: '' }, // blank
    ]));

    render(
      <MeshCoreChannelsView
        messages={[]}
        contacts={contacts}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('# Channel 5')).toBeTruthy();
    });
  });
});

describe('MeshCoreChannelsView — per-channel message filter', () => {
  const messages: MeshCoreMessage[] = [
    // Received on channel 0
    { id: 'r0', fromPublicKey: 'channel-0', text: 'hi from chan 0', timestamp: 1000 },
    // Received on channel 1
    { id: 'r1', fromPublicKey: 'channel-1', text: 'hi from chan 1', timestamp: 1100 },
    // Received on channel 2
    { id: 'r2', fromPublicKey: 'channel-2', text: 'hi from chan 2', timestamp: 1200 },
    // Local outbound to channel 1 (phase-2 tagging via toPublicKey)
    { id: 's1', fromPublicKey: 'local-pubkey'.padEnd(64, '0'), toPublicKey: 'channel-1', text: 'my reply on 1', timestamp: 1300 },
    // Pre-phase-2 legacy local outbound (no toPublicKey) — should bucket into channel 0
    { id: 's0-legacy', fromPublicKey: 'local-pubkey'.padEnd(64, '0'), text: 'legacy local on 0', timestamp: 1400 },
    // A direct message — has a toPublicKey that is NOT channel-N, must not appear anywhere
    { id: 'dm', fromPublicKey: 'cafe'.padEnd(64, '0'), toPublicKey: 'beef'.padEnd(64, '0'), text: 'private dm', timestamp: 1500 },
  ];

  beforeEach(() => {
    csrfFetchMock.mockResolvedValue(
      jsonResponse([
        { id: 0, name: 'Public' },
        { id: 1, name: 'Town' },
        { id: 2, name: 'Operators' },
      ]),
    );
  });

  it('shows only channel-0 messages (received + legacy local) on the Public tab', async () => {
    render(
      <MeshCoreChannelsView
        messages={messages}
        contacts={contacts}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    await waitFor(() => screen.getByText('# Public'));

    // Default selected channel is 0.
    expect(screen.getByText('hi from chan 0')).toBeTruthy();
    expect(screen.getByText('legacy local on 0')).toBeTruthy();
    expect(screen.queryByText('hi from chan 1')).toBeNull();
    expect(screen.queryByText('hi from chan 2')).toBeNull();
    expect(screen.queryByText('my reply on 1')).toBeNull();
    expect(screen.queryByText('private dm')).toBeNull();
  });

  it('shows received + locally-sent messages on the Town (channel 1) tab', async () => {
    render(
      <MeshCoreChannelsView
        messages={messages}
        contacts={contacts}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    await waitFor(() => screen.getByText('# Town'));
    fireEvent.click(screen.getByText('# Town'));

    expect(screen.getByText('hi from chan 1')).toBeTruthy();
    expect(screen.getByText('my reply on 1')).toBeTruthy();
    expect(screen.queryByText('hi from chan 0')).toBeNull();
    expect(screen.queryByText('hi from chan 2')).toBeNull();
    expect(screen.queryByText('legacy local on 0')).toBeNull();
    expect(screen.queryByText('private dm')).toBeNull();
  });
});

describe('MeshCoreChannelsView — sending', () => {
  it('passes the active channel idx to actions.sendMessage', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 0, name: 'Public' },
        { id: 2, name: 'Ops' },
      ]),
    );

    const actions = makeActions();
    render(
      <MeshCoreChannelsView
        messages={[]}
        contacts={contacts}
        status={makeStatus()}
        actions={actions}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    await waitFor(() => screen.getByText('# Ops'));
    fireEvent.click(screen.getByText('# Ops'));

    const input = screen.getByPlaceholderText('Type a message…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'channel ops msg' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Send'));
    });

    expect(actions.sendMessage).toHaveBeenCalledWith('channel ops msg', undefined, 2);
  });
});
