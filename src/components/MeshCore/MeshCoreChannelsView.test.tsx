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
  // Required by config/i18n (pulled in transitively via SettingsContext, which
  // the embedded <LinkPreview> imports). Without these the mock is incomplete.
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
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
    csrfFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages/channel/')) {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse([
        { id: 0, name: 'Public' },
        { id: 1, name: 'Town' },
        { id: 2, name: 'Operators' },
      ]));
    });

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
    const calledChannelsUrl = csrfFetchMock.mock.calls
      .map((c) => c[0] as string)
      .find((u) => u.includes('/api/channels/all'));
    expect(calledChannelsUrl).toContain('/api/channels/all?sourceId=src-a');
  });

  it('falls back to a synthetic Public channel when the API returns nothing', async () => {
    csrfFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages/channel/')) {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse([]));
    });

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
    csrfFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages/channel/')) {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse([
        { id: 0, name: 'Public' },
        { id: 5, name: '' }, // blank
      ]));
    });

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
    // Fresh Response per call (a Response body can only be read once) and a
    // valid payload for the per-channel backlog fetch this view now issues.
    csrfFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages/channel/')) {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse([
        { id: 0, name: 'Public' },
        { id: 1, name: 'Town' },
        { id: 2, name: 'Operators' },
      ]));
    });
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

    // Default selected channel is 0. waitFor lets the per-channel backlog fetch
    // settle (it returns empty here; the live `messages` prop supplies content).
    await waitFor(() => {
      expect(screen.getByText('hi from chan 0')).toBeTruthy();
      expect(screen.getByText('legacy local on 0')).toBeTruthy();
    });
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

    await waitFor(() => {
      expect(screen.getByText('hi from chan 1')).toBeTruthy();
      expect(screen.getByText('my reply on 1')).toBeTruthy();
    });
    expect(screen.queryByText('hi from chan 0')).toBeNull();
    expect(screen.queryByText('hi from chan 2')).toBeNull();
    expect(screen.queryByText('legacy local on 0')).toBeNull();
    expect(screen.queryByText('private dm')).toBeNull();
  });
});

describe('MeshCoreChannelsView — per-channel backlog fetch (#3442)', () => {
  // Route csrfFetch by URL so the channel-list and per-channel-messages
  // endpoints can return different payloads.
  function routedFetch(messagesByChannel: Record<number, MeshCoreMessage[]>, countsByChannel?: Record<number, number>) {
    return vi.fn((url: string) => {
      if (url.includes('/api/channels/all')) {
        return Promise.resolve(jsonResponse([
          { id: 0, name: 'Public' },
          { id: 1, name: 'Town' },
        ]));
      }
      if (url.includes('/messages/channel-counts')) {
        return Promise.resolve(jsonResponse({ success: true, counts: countsByChannel ?? {} }));
      }
      const m = url.match(/\/messages\/channel\/(\d+)/);
      if (m) {
        const idx = Number(m[1]);
        return Promise.resolve(jsonResponse({ success: true, data: messagesByChannel[idx] ?? [], count: (messagesByChannel[idx] ?? []).length }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: [] }));
    });
  }

  it('renders the fetched backlog even when the live messages pool is empty', async () => {
    csrfFetchMock.mockImplementation(routedFetch({
      0: [{ id: 'h0', fromPublicKey: 'channel-0', text: 'backlog on public', timestamp: 500 }],
    }));

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

    await waitFor(() => expect(screen.getByText('backlog on public')).toBeTruthy());

    // The per-channel endpoint was hit for channel 0.
    const hitChannel0 = csrfFetchMock.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/meshcore/messages/channel/0'),
    );
    expect(hitChannel0).toBe(true);
  });

  it('merges live messages with the fetched backlog and dedupes by id', async () => {
    csrfFetchMock.mockImplementation(routedFetch({
      0: [
        { id: 'h0', fromPublicKey: 'channel-0', text: 'old backlog', timestamp: 100 },
        { id: 'dup', fromPublicKey: 'channel-0', text: 'shared', timestamp: 200 },
      ],
    }));

    // `dup` is in both the backlog and the live pool; `live-new` only in live.
    const liveMessages: MeshCoreMessage[] = [
      { id: 'dup', fromPublicKey: 'channel-0', text: 'shared', timestamp: 200 },
      { id: 'live-new', fromPublicKey: 'channel-0', text: 'fresh live', timestamp: 300 },
    ];

    render(
      <MeshCoreChannelsView
        messages={liveMessages}
        contacts={contacts}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    await waitFor(() => expect(screen.getByText('old backlog')).toBeTruthy());
    expect(screen.getByText('fresh live')).toBeTruthy();
    // Deduped — only one node for the shared id.
    expect(screen.getAllByText('shared')).toHaveLength(1);
  });

  it('shows accurate per-channel counts from the counts endpoint, even for an inactive busy channel', async () => {
    // Public (active, idx 0) is quiet; Town (inactive, idx 1) has many messages
    // that are NOT in the shared live pool. The badge must still show Town's
    // real count from the counts endpoint, not 0.
    csrfFetchMock.mockImplementation(routedFetch(
      { 0: [{ id: 'h0', fromPublicKey: 'channel-0', text: 'just one', timestamp: 1 }] },
      { 0: 1, 1: 137 },
    ));

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

    await waitFor(() => expect(screen.getByText('# Town')).toBeTruthy());
    // Town's badge reflects the 137 persisted messages despite an empty live pool.
    await waitFor(() => expect(screen.getByText('137 messages')).toBeTruthy());
  });

  it('switches the fetched backlog when a different channel is selected', async () => {
    csrfFetchMock.mockImplementation(routedFetch({
      0: [{ id: 'h0', fromPublicKey: 'channel-0', text: 'public backlog', timestamp: 100 }],
      1: [{ id: 'h1', fromPublicKey: 'channel-1', text: 'town backlog', timestamp: 110 }],
    }));

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

    await waitFor(() => expect(screen.getByText('public backlog')).toBeTruthy());

    fireEvent.click(screen.getByText('# Town'));
    await waitFor(() => expect(screen.getByText('town backlog')).toBeTruthy());
    expect(screen.queryByText('public backlog')).toBeNull();
  });
});

describe('MeshCoreChannelsView — sending', () => {
  it('passes the active channel idx to actions.sendMessage', async () => {
    csrfFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages/channel/')) {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse([
        { id: 0, name: 'Public' },
        { id: 2, name: 'Ops' },
      ]));
    });

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
