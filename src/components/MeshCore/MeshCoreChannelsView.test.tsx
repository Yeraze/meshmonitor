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
    // Scope helpers invoked by the component when status.connected is true; the
    // component swallows failures, but mocking them avoids unhandled rejections.
    getDefaultScope: vi.fn().mockResolvedValue(''),
    discoverRegions: vi.fn().mockResolvedValue({ regions: [] }),
    fetchSavedRegions: vi.fn().mockResolvedValue([]),
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

describe('MeshCoreChannelsView — unread indicator (#3703)', () => {
  // Route the list, per-channel-messages, and channel-counts endpoints. The
  // counts endpoint now also returns `latestTimestamps` (idx → max ms) which
  // drives the unread comparison.
  function routedFetch(opts: {
    latestTimestamps?: Record<number, number>;
    counts?: Record<number, number>;
    messagesByChannel?: Record<number, MeshCoreMessage[]>;
  }) {
    return vi.fn((url: string) => {
      if (url.includes('/api/channels/all')) {
        return Promise.resolve(jsonResponse([
          { id: 0, name: 'Public' },
          { id: 1, name: 'Town' },
        ]));
      }
      if (url.includes('/messages/channel-counts')) {
        return Promise.resolve(jsonResponse({
          success: true,
          counts: opts.counts ?? {},
          latestTimestamps: opts.latestTimestamps ?? {},
        }));
      }
      const m = url.match(/\/messages\/channel\/(\d+)/);
      if (m) {
        const idx = Number(m[1]);
        const data = opts.messagesByChannel?.[idx] ?? [];
        return Promise.resolve(jsonResponse({ success: true, data, count: data.length }));
      }
      return Promise.resolve(jsonResponse({ success: true, data: [] }));
    });
  }

  beforeEach(() => {
    localStorage.clear();
  });

  it('flags an inactive channel as unread when its latest message is newer than the (absent) last-read marker', async () => {
    // Active channel is Public (idx 0). Town (idx 1) has a newer message and has
    // never been opened, so it must show an unread dot.
    csrfFetchMock.mockImplementation(routedFetch({
      latestTimestamps: { 0: 100, 1: 9999 },
      counts: { 0: 1, 1: 1 },
    }));

    const { container } = render(
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
    await waitFor(() => expect(container.querySelector('.mc-channel-unread-dot')).toBeTruthy());

    // The active channel (Public) must NOT be unread.
    const publicRow = screen.getByText('# Public').closest('.mc-channel-row');
    expect(publicRow?.classList.contains('unread')).toBe(false);
  });

  it('clears the unread state for a channel once it is opened', async () => {
    csrfFetchMock.mockImplementation(routedFetch({
      latestTimestamps: { 0: 100, 1: 9999 },
      counts: { 0: 1, 1: 1 },
      messagesByChannel: { 1: [{ id: 't1', fromPublicKey: 'channel-1', text: 'town msg', timestamp: 9999 }] },
    }));

    const { container } = render(
      <MeshCoreChannelsView
        messages={[]}
        contacts={contacts}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    await waitFor(() => expect(container.querySelector('.mc-channel-unread-dot')).toBeTruthy());

    // Open Town — it becomes the active/viewed channel and should clear.
    fireEvent.click(screen.getByText('# Town'));
    await waitFor(() => expect(container.querySelector('.mc-channel-unread-dot')).toBeNull());

    // The last-read marker was persisted for this source/channel.
    const stored = JSON.parse(localStorage.getItem('meshmonitor-meshcore-channel-lastread-src-a') ?? '{}');
    expect(stored['1']).toBeGreaterThanOrEqual(9999);
  });

  it('does not flag a channel unread when its last-read marker is current', async () => {
    localStorage.setItem(
      'meshmonitor-meshcore-channel-lastread-src-a',
      JSON.stringify({ 1: 9999 }),
    );
    csrfFetchMock.mockImplementation(routedFetch({
      latestTimestamps: { 0: 100, 1: 9999 },
      counts: { 0: 1, 1: 1 },
    }));

    const { container } = render(
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
    // Give the counts/latest fetch a tick to resolve (both rows show "1 messages").
    await waitFor(() => expect(screen.getAllByText('1 messages').length).toBe(2));
    expect(container.querySelector('.mc-channel-unread-dot')).toBeNull();
  });

  it('reorders channels with unread first when the sort toggle is enabled', async () => {
    csrfFetchMock.mockImplementation(routedFetch({
      latestTimestamps: { 0: 100, 1: 9999 },
      counts: { 0: 1, 1: 1 },
    }));

    const { container } = render(
      <MeshCoreChannelsView
        messages={[]}
        contacts={contacts}
        status={makeStatus()}
        actions={makeActions()}
        baseUrl=""
        sourceId="src-a"
      />,
    );

    await waitFor(() => expect(container.querySelector('.mc-channel-unread-dot')).toBeTruthy());

    // Default order: Public (idx 0) first.
    let names = Array.from(container.querySelectorAll('.mc-channel-row-name')).map(n => n.textContent);
    expect(names[0]).toBe('# Public');

    // Enable "unread first" — Town (unread) should jump to the top.
    fireEvent.click(screen.getByTitle('Show channels with unread messages first'));
    await waitFor(() => {
      const reordered = Array.from(container.querySelectorAll('.mc-channel-row-name')).map(n => n.textContent);
      expect(reordered[0]).toBe('# Town');
    });
    expect(localStorage.getItem('meshmonitor-meshcore-channel-sort-unread-first')).toBe('true');
  });
});

describe('MeshCoreChannelsView — reply uses the originating scope (#3851)', () => {
  beforeEach(() => {
    csrfFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages/channel/')) {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse([{ id: 0, name: 'Public' }]));
    });
  });

  it('replying to a scoped channel message sets the send scope to its region', async () => {
    const scoped: MeshCoreMessage[] = [
      { id: 'r0s', fromPublicKey: 'channel-0', fromName: 'Bob', text: 'scoped hi', timestamp: 1000, scopeName: 'augsburg', scopeCode: 99 },
    ];
    render(
      <MeshCoreChannelsView messages={scoped} contacts={contacts} status={makeStatus()} actions={makeActions()} baseUrl="" sourceId="src-a" />,
    );
    await waitFor(() => screen.getByText('scoped hi'));
    // The send-scope widget is hidden until a reply (or manual toggle).
    expect(screen.queryByLabelText('Send scope')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const scopeInput = (await screen.findByLabelText('Send scope')) as HTMLInputElement;
    expect(scopeInput.value).toBe('augsburg');
  });

  it('replying to an unscoped (scopeCode 0) message sends unscoped (empty scope)', async () => {
    const unscoped: MeshCoreMessage[] = [
      { id: 'r0u', fromPublicKey: 'channel-0', fromName: 'Cara', text: 'plain hi', timestamp: 1000, scopeCode: 0 },
    ];
    render(
      <MeshCoreChannelsView messages={unscoped} contacts={contacts} status={makeStatus()} actions={makeActions()} baseUrl="" sourceId="src-a" />,
    );
    await waitFor(() => screen.getByText('plain hi'));
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const scopeInput = (await screen.findByLabelText('Send scope')) as HTMLInputElement;
    expect(scopeInput.value).toBe('');
  });

  it('leaves the scope at the default for a scoped-but-unknown message (HMAC code, no name)', async () => {
    const unknown: MeshCoreMessage[] = [
      { id: 'r0x', fromPublicKey: 'channel-0', fromName: 'Dee', text: 'mystery scope', timestamp: 1000, scopeCode: 4242 },
    ];
    render(
      <MeshCoreChannelsView messages={unknown} contacts={contacts} status={makeStatus()} actions={makeActions()} baseUrl="" sourceId="src-a" />,
    );
    await waitFor(() => screen.getByText('mystery scope'));
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    // Region name isn't recoverable from the code → scope override stays hidden
    // (the reply falls back to the channel/source default).
    expect(screen.queryByLabelText('Send scope')).toBeNull();
  });
});

// Issue #3888: an explicit "Unscoped" affordance when composing so users can
// reliably send a channel message with no region scope, without the old
// type-a-char-then-delete trick. `overrideScope === ''` = explicit unscoped;
// `null` (untouched) = fall back to the channel/source default scope.
describe('MeshCoreChannelsView — explicit Unscoped send (#3888)', () => {
  beforeEach(() => {
    csrfFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/messages/channel/')) {
        return Promise.resolve(jsonResponse({ success: true, data: [] }));
      }
      return Promise.resolve(jsonResponse([{ id: 0, name: 'Public' }]));
    });
  });

  it('sends explicitly unscoped (scope = "") when the Unscoped button is clicked', async () => {
    const actions = makeActions();
    render(
      <MeshCoreChannelsView messages={[]} contacts={contacts} status={makeStatus()} actions={actions} baseUrl="" sourceId="src-a" />,
    );
    await waitFor(() => screen.getByText('# Public'));

    // Open the scope-override control (collapsed by default).
    fireEvent.click(screen.getByText('Scope: unscoped'));
    // Click the discoverable "Unscoped" affordance.
    const unscopedBtn = await screen.findByRole('button', { name: 'Unscoped' });
    fireEvent.click(unscopedBtn);
    // Active state disambiguates '' (unscoped) from null (default) — both leave
    // the free-text input empty.
    expect(unscopedBtn.getAttribute('aria-pressed')).toBe('true');
    expect(unscopedBtn.classList.contains('active')).toBe(true);

    const input = screen.getByPlaceholderText('Type a message…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'no scope please' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Send'));
    });

    // The empty-string scope arg is passed through — the backend treats '' as
    // explicit unscoped (distinct from omitting the arg).
    expect(actions.sendMessage).toHaveBeenCalledWith('no scope please', undefined, 0, '');
  });

  it('sends with NO scope override (default scope) when the control is opened but untouched', async () => {
    const actions = makeActions();
    render(
      <MeshCoreChannelsView messages={[]} contacts={contacts} status={makeStatus()} actions={actions} baseUrl="" sourceId="src-a" />,
    );
    await waitFor(() => screen.getByText('# Public'));

    // Open the control but do NOT click Unscoped — overrideScope stays null.
    fireEvent.click(screen.getByText('Scope: unscoped'));

    const input = screen.getByPlaceholderText('Type a message…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'use default' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Send'));
    });

    // No 4th arg → backend resolves the channel/source default scope.
    expect(actions.sendMessage).toHaveBeenCalledWith('use default', undefined, 0);
  });

  it('marks the Unscoped button active after replying to an unscoped message', async () => {
    const unscoped: MeshCoreMessage[] = [
      { id: 'r0u', fromPublicKey: 'channel-0', fromName: 'Cara', text: 'plain hi', timestamp: 1000, scopeCode: 0 },
    ];
    render(
      <MeshCoreChannelsView messages={unscoped} contacts={contacts} status={makeStatus()} actions={makeActions()} baseUrl="" sourceId="src-a" />,
    );
    await waitFor(() => screen.getByText('plain hi'));
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));

    // handleReply set overrideScope to '' — the Unscoped button reflects it.
    const unscopedBtn = await screen.findByRole('button', { name: 'Unscoped' });
    expect(unscopedBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
