/**
 * @vitest-environment jsdom
 *
 * useReticulum — poll-based status/destinations/interfaces/conversations
 * fetch + favorite toggle (#3960 Phase 1b WP1), extended in Phase 2 WP5 with
 * LXMF conversation/message fetch, `sendMessage`, and the two
 * `reticulum:*` Socket.io live updates. Pins: the `{success,data}` envelope
 * unwrap (`api.get`/`api.post` do NOT unwrap `data` — CLAUDE.md), the 30s
 * poll cadence for the four polled fields (R4, no push events for those),
 * that `enabled: false` suppresses all fetching, and that the socket layer
 * degrades gracefully when `socket` is `null` (no WebSocketProvider yet).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { EventEmitter } from 'events';

vi.mock('../../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

// A minimal Socket.io-client double: real EventEmitter semantics so the
// hook's `socket.on(event, cb)` registrations can be triggered from the test
// via `fakeSocket.emit(event, payload)`, exactly mirroring how a real
// Socket.io client invokes its own listeners on an incoming server push.
class FakeSocket extends EventEmitter {
  connected = true;
  io = { on: vi.fn(), off: vi.fn() };
}

// `vi.mock` factories are hoisted above the rest of the file, so a plain
// `let` referenced inside one would hit the TDZ the first time the factory
// actually runs. `vi.hoisted` gives us a container that's safe to close
// over — its own initializer is hoisted alongside the mock calls, and tests
// mutate `.current` afterward to swap the socket per-test (including to
// `null`, for the "no WebSocketProvider yet" case).
const socketHolder = vi.hoisted(() => ({ current: null as FakeSocket | null }));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({
    state: { connected: true, socketId: 's1', error: null, socket: socketHolder.current },
    enabled: true,
  }),
}));

import api from '../../../services/api';
import { useReticulum } from './useReticulum';

let fakeSocket: FakeSocket;
import type {
  ReticulumStatus,
  ReticulumDestinationRow,
  ReticulumInterfaceRow,
  ReticulumConversation,
  ReticulumMessageRow,
  ReticulumIdentity,
  ReticulumPathRow,
  ReticulumProbeResult,
  ReticulumRemoteStatus,
} from '../../../types/reticulum';

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>;

function baseStatus(overrides: Partial<ReticulumStatus> = {}): ReticulumStatus {
  return {
    connected: true,
    mode: 'attach',
    interfaceCount: 1,
    destinationCount: 2,
    ...overrides,
  };
}

function baseDestination(overrides: Partial<ReticulumDestinationRow> = {}): ReticulumDestinationRow {
  return {
    sourceId: 's1',
    destinationHash: 'hash1',
    identityHash: null,
    appName: 'lxmf',
    aspects: 'delivery',
    displayName: 'Node A',
    appDataB64: null,
    hops: 2,
    nextHopInterface: 'TCPServer',
    rssi: -80,
    snr: 5,
    quality: 90,
    announceCount: 3,
    firstSeen: 1000,
    lastSeen: 2000,
    lastAnnounceAt: 2000,
    isFavorite: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function baseInterface(overrides: Partial<ReticulumInterfaceRow> = {}): ReticulumInterfaceRow {
  return {
    sourceId: 's1',
    interfaceName: 'TCPServer',
    interfaceType: 'TCPServerInterface',
    interfaceHash: null,
    mode: 'full',
    status: 'online',
    online: true,
    bitrate: 115200,
    txBytes: 1024,
    rxBytes: 2048,
    lastSeenAt: 2000,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function baseMessage(overrides: Partial<ReticulumMessageRow> = {}): ReticulumMessageRow {
  return {
    id: 's1_hashA',
    sourceId: 's1',
    fromHash: 'peerHashA',
    toHash: 'selfHash',
    title: null,
    content: 'hello',
    timestamp: 5000,
    receivedAt: 5001,
    createdAt: 5001,
    state: 'delivered',
    method: 'opportunistic',
    signatureValidated: true,
    ratcheted: false,
    fields: null,
    replyToHash: null,
    threadHash: null,
    rssi: null,
    snr: null,
    quality: null,
    ...overrides,
  };
}

function baseConversation(overrides: Partial<ReticulumConversation> = {}): ReticulumConversation {
  return {
    peerHash: 'peerHashA',
    lastMessage: baseMessage(),
    messageCount: 1,
    ...overrides,
  };
}

function basePath(overrides: Partial<ReticulumPathRow> = {}): ReticulumPathRow {
  return {
    sourceId: 's1',
    destinationHash: 'destHashA',
    viaHash: 'viaHashA',
    hops: 2,
    interfaceName: 'TCPServer',
    expiresAt: 9999999,
    updatedAt: 2000,
    ...overrides,
  };
}

/** Resolves the five GET calls (status, destinations, interfaces, conversations, paths) in order. */
function mockSnapshot(
  status: ReticulumStatus = baseStatus(),
  destinations: ReticulumDestinationRow[] = [baseDestination()],
  interfaces: ReticulumInterfaceRow[] = [baseInterface()],
  conversations: ReticulumConversation[] = [baseConversation()],
  paths: ReticulumPathRow[] = [basePath()],
) {
  mockedGet
    .mockResolvedValueOnce({ success: true, data: status })
    .mockResolvedValueOnce({ success: true, data: destinations })
    .mockResolvedValueOnce({ success: true, data: interfaces })
    .mockResolvedValueOnce({ success: true, data: conversations })
    .mockResolvedValueOnce({ success: true, data: paths });
}

/** Resolves the identity GET call (separate effect, fires alongside the snapshot poll). */
function mockIdentity(identity: ReticulumIdentity = { destinationHash: 'selfHash', displayName: 'Me' }) {
  mockedGet.mockResolvedValueOnce({ success: true, data: identity });
}

describe('useReticulum', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedPost.mockReset();
    fakeSocket = new FakeSocket();
    socketHolder.current = fakeSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches and unwraps status/destinations/interfaces/conversations on mount', async () => {
    mockSnapshot();
    mockIdentity();

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/status');
    expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/destinations');
    expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/interfaces');
    expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/messages');
    expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/paths');

    expect(result.current.status).toEqual(baseStatus());
    expect(result.current.destinations).toEqual([baseDestination()]);
    expect(result.current.interfaces).toEqual([baseInterface()]);
    expect(result.current.conversations).toEqual([baseConversation()]);
    expect(result.current.paths).toEqual([basePath()]);
    expect(result.current.loading).toBe(false);
    expect(result.current.conversationsLoading).toBe(false);
    expect(result.current.error).toBeNull();

    // A future "just use the body" regression (reading fields straight off
    // the un-enveloped response) must fail here.
    expect((result.current.status as unknown as { success?: boolean }).success).toBeUndefined();
  });

  it('fetches and unwraps its own identity separately from the poll', async () => {
    mockSnapshot();
    mockIdentity({ destinationHash: 'abc123', displayName: 'My RNS Node' });

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

    await waitFor(() => expect(result.current.identity).not.toBeNull());
    expect(result.current.identity).toEqual({ destinationHash: 'abc123', displayName: 'My RNS Node' });
  });

  it('tolerates an unwrapped (no {data} envelope) response', async () => {
    mockedGet
      .mockResolvedValueOnce(baseStatus())
      .mockResolvedValueOnce([baseDestination()])
      .mockResolvedValueOnce([baseInterface()])
      .mockResolvedValueOnce([baseConversation()])
      .mockResolvedValueOnce([basePath()])
      .mockResolvedValueOnce({ destinationHash: null, displayName: null });

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.status).toEqual(baseStatus());
    expect(result.current.destinations).toEqual([baseDestination()]);
    expect(result.current.conversations).toEqual([baseConversation()]);
    expect(result.current.paths).toEqual([basePath()]);
  });

  it('enabled: false short-circuits all fetching', async () => {
    const { result } = renderHook(() => useReticulum({ sourceId: 's1', enabled: false }));

    // Give any accidental async fetch a tick to fire.
    await act(async () => { await Promise.resolve(); });

    expect(mockedGet).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.destinations).toEqual([]);
    expect(result.current.interfaces).toEqual([]);
    expect(result.current.conversations).toEqual([]);
    expect(result.current.paths).toEqual([]);
  });

  it('polls again after 30s (R4 — no push events for the snapshot, poll is the only refresh)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSnapshot();
    mockIdentity();
    mockSnapshot(baseStatus({ destinationCount: 5 }));

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

    await waitFor(() => expect(result.current.status?.destinationCount).toBe(2));
    expect(mockedGet).toHaveBeenCalledTimes(6);

    await act(async () => {
      vi.advanceTimersByTime(30000);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.status?.destinationCount).toBe(5));
  });

  it('surfaces a fetch error without throwing', async () => {
    mockedGet.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe('network down');
    expect(result.current.loading).toBe(false);
  });

  it('refresh() re-fetches immediately', async () => {
    mockSnapshot();
    mockIdentity();
    mockSnapshot(baseStatus({ interfaceCount: 9 }));

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
    await waitFor(() => expect(result.current.status?.interfaceCount).toBe(1));

    await act(async () => { await result.current.refresh(); });

    expect(result.current.status?.interfaceCount).toBe(9);
  });

  describe('toggleFavorite', () => {
    it('POSTs to /destinations/:hash/favorite and patches the local list from the response', async () => {
      mockSnapshot(baseStatus(), [baseDestination({ destinationHash: 'hashA', isFavorite: false })]);
      mockIdentity();
      mockedPost.mockResolvedValueOnce({
        success: true,
        data: { destinationHash: 'hashA', isFavorite: true },
      });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.destinations).toHaveLength(1));

      let ok: boolean = false;
      await act(async () => {
        ok = await result.current.toggleFavorite('hashA', true);
      });

      expect(ok).toBe(true);
      expect(mockedPost).toHaveBeenCalledWith(
        '/api/sources/s1/reticulum/destinations/hashA/favorite',
        { favorite: true },
      );
      expect(result.current.destinations[0].isFavorite).toBe(true);
    });

    it('encodes the destination hash in the URL', async () => {
      mockSnapshot();
      mockIdentity();
      mockedPost.mockResolvedValueOnce({ success: true, data: { destinationHash: 'a/b', isFavorite: true } });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.destinations).toHaveLength(1));

      await act(async () => { await result.current.toggleFavorite('a/b', true); });

      expect(mockedPost).toHaveBeenCalledWith(
        '/api/sources/s1/reticulum/destinations/a%2Fb/favorite',
        { favorite: true },
      );
    });

    it('returns false and sets an error on failure, without touching the list', async () => {
      mockSnapshot(baseStatus(), [baseDestination({ destinationHash: 'hashA', isFavorite: false })]);
      mockIdentity();
      mockedPost.mockRejectedValueOnce(new Error('forbidden'));

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.destinations).toHaveLength(1));

      let ok: boolean = true;
      await act(async () => {
        ok = await result.current.toggleFavorite('hashA', true);
      });

      expect(ok).toBe(false);
      expect(result.current.error).toBe('forbidden');
      expect(result.current.destinations[0].isFavorite).toBe(false);
    });
  });

  describe('loadConversation / loadMoreMessages', () => {
    it('fetches a conversation newest-first response and sorts it oldest-first for display', async () => {
      mockSnapshot();
      mockIdentity();
      const older = baseMessage({ id: 's1_older', timestamp: 1000, receivedAt: 1000 });
      const newer = baseMessage({ id: 's1_newer', timestamp: 2000, receivedAt: 2000 });
      mockedGet.mockResolvedValueOnce({ success: true, data: [newer, older] });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      await act(async () => { await result.current.loadConversation('peerHashA'); });

      expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/messages/peerHashA?limit=50');
      expect(result.current.activePeerHash).toBe('peerHashA');
      expect(result.current.messages.map(m => m.id)).toEqual(['s1_older', 's1_newer']);
    });

    it('loadMoreMessages pages older history with a before cursor and prepends it', async () => {
      mockSnapshot();
      mockIdentity();
      const page1 = baseMessage({ id: 's1_p1', timestamp: 5000 });
      mockedGet.mockResolvedValueOnce({ success: true, data: [page1] });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());
      await act(async () => { await result.current.loadConversation('peerHashA'); });
      expect(result.current.hasMoreMessages).toBe(false); // page1 has only 1 row, < 50

      // Force hasMoreMessages true by loading a full page, then request more.
      const fullPage = Array.from({ length: 50 }, (_, i) => baseMessage({ id: `s1_full${i}`, timestamp: 10000 + i }));
      mockedGet.mockResolvedValueOnce({ success: true, data: fullPage });
      await act(async () => { await result.current.loadConversation('peerHashA'); });
      expect(result.current.hasMoreMessages).toBe(true);

      const older = baseMessage({ id: 's1_older2', timestamp: 9000 });
      mockedGet.mockResolvedValueOnce({ success: true, data: [older] });
      await act(async () => { await result.current.loadMoreMessages(); });

      expect(mockedGet).toHaveBeenLastCalledWith(
        expect.stringContaining('/api/sources/s1/reticulum/messages/peerHashA?before=10000&limit=50'),
      );
      expect(result.current.messages[0].id).toBe('s1_older2');
      expect(result.current.hasMoreMessages).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('POSTs and appends the returned row to messages when it matches the active peer', async () => {
      mockSnapshot();
      mockIdentity();
      mockedGet.mockResolvedValueOnce({ success: true, data: [] });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());
      await act(async () => { await result.current.loadConversation('peerHashA'); });

      const sentRow = baseMessage({ id: 's1_sent1', fromHash: 'selfHash', toHash: 'peerHashA', content: 'hi there', state: 'sending' });
      mockedPost.mockResolvedValueOnce({ success: true, data: sentRow });

      let row: ReticulumMessageRow | null = null;
      await act(async () => {
        row = await result.current.sendMessage({ to: 'peerHashA', content: 'hi there' });
      });

      expect(mockedPost).toHaveBeenCalledWith('/api/sources/s1/reticulum/messages', { to: 'peerHashA', content: 'hi there' });
      expect(row).toEqual(sentRow);
      expect(result.current.messages.some(m => m.id === 's1_sent1')).toBe(true);
      expect(result.current.conversations.find(c => c.peerHash === 'peerHashA')?.lastMessage.id).toBe('s1_sent1');
    });

    it('does not append to messages when the sent row targets a different (inactive) peer', async () => {
      mockSnapshot();
      mockIdentity();
      mockedGet.mockResolvedValueOnce({ success: true, data: [] });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());
      await act(async () => { await result.current.loadConversation('peerHashA'); });

      const sentRow = baseMessage({ id: 's1_sent2', fromHash: 'selfHash', toHash: 'someOtherPeer' });
      mockedPost.mockResolvedValueOnce({ success: true, data: sentRow });

      await act(async () => { await result.current.sendMessage({ to: 'someOtherPeer', content: 'hi' }); });

      expect(result.current.messages.some(m => m.id === 's1_sent2')).toBe(false);
      expect(result.current.conversations.find(c => c.peerHash === 'someOtherPeer')?.lastMessage.id).toBe('s1_sent2');
    });

    it('returns null and sets an error on failure', async () => {
      mockSnapshot();
      mockIdentity();
      mockedPost.mockRejectedValueOnce(new Error('not connected'));

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      let row: ReticulumMessageRow | null = null;
      await act(async () => {
        row = await result.current.sendMessage({ to: 'peerHashA', content: 'hi' });
      });

      expect(row).toBeNull();
      expect(result.current.error).toBe('not connected');
    });
  });

  describe('socket live updates', () => {
    it('joins the per-source room on connect', async () => {
      mockSnapshot();
      mockIdentity();
      const emitSpy = vi.spyOn(fakeSocket, 'emit');

      renderHook(() => useReticulum({ sourceId: 's1' }));

      await waitFor(() => expect(emitSpy).toHaveBeenCalledWith('join-source', 's1'));
    });

    it('reticulum:message for the active peer appends to messages and updates conversations', async () => {
      mockSnapshot();
      mockIdentity();
      mockedGet.mockResolvedValueOnce({ success: true, data: [] });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());
      await act(async () => { await result.current.loadConversation('peerHashA'); });

      const inbound = baseMessage({ id: 's1_inbound1', fromHash: 'peerHashA', toHash: 'selfHash', content: 'new message', timestamp: 99999 });
      act(() => { fakeSocket.emit('reticulum:message', inbound); });

      await waitFor(() => expect(result.current.messages.some(m => m.id === 's1_inbound1')).toBe(true));
      expect(result.current.conversations.find(c => c.peerHash === 'peerHashA')?.lastMessage.id).toBe('s1_inbound1');
    });

    it('reticulum:message for a different source is ignored', async () => {
      mockSnapshot();
      mockIdentity();
      mockedGet.mockResolvedValueOnce({ success: true, data: [] });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());
      await act(async () => { await result.current.loadConversation('peerHashA'); });

      const inbound = baseMessage({ id: 'otherSource_inbound1', sourceId: 'other-source', fromHash: 'peerHashA' });
      act(() => { fakeSocket.emit('reticulum:message', inbound); });

      await act(async () => { await Promise.resolve(); });
      expect(result.current.messages.some(m => m.id === 'otherSource_inbound1')).toBe(false);
    });

    it('reticulum:delivery-state:updated patches a matching message and conversation summary', async () => {
      mockSnapshot();
      mockIdentity();
      const sentRow = baseMessage({ id: 's1_dstate1', fromHash: 'selfHash', toHash: 'peerHashA', state: 'sending' });
      mockedGet.mockResolvedValueOnce({ success: true, data: [sentRow] });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());
      await act(async () => { await result.current.loadConversation('peerHashA'); });
      expect(result.current.messages[0].state).toBe('sending');

      act(() => {
        fakeSocket.emit('reticulum:delivery-state:updated', {
          sourceId: 's1', id: 's1_dstate1', hash: 'dstate1', state: 'delivered', method: 'opportunistic',
        });
      });

      await waitFor(() => expect(result.current.messages[0].state).toBe('delivered'));
    });

    it('gracefully no-ops the socket effect when socket is null', async () => {
      socketHolder.current = null;
      mockSnapshot();
      mockIdentity();

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

      await waitFor(() => expect(result.current.status).not.toBeNull());
      // No throw, and the polled snapshot still loads normally.
      expect(result.current.status).toEqual(baseStatus());
    });
  });

  describe('probe (Phase 4 WP4)', () => {
    it('POSTs /paths/probe and stores the result', async () => {
      mockSnapshot();
      mockIdentity();
      const probeResult: ReticulumProbeResult = { destinationHash: 'destHashA', ok: true, rttMs: 123, hops: 2, error: null };
      mockedPost.mockResolvedValueOnce({ success: true, data: probeResult });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      let returned: ReticulumProbeResult | null = null;
      await act(async () => {
        returned = await result.current.probe('destHashA');
      });

      expect(mockedPost).toHaveBeenCalledWith('/api/sources/s1/reticulum/paths/probe', { destinationHash: 'destHashA' });
      expect(returned).toEqual(probeResult);
      expect(result.current.probeResult).toEqual(probeResult);
      expect(result.current.probingHash).toBeNull();
    });

    it('forwards timeoutS when provided', async () => {
      mockSnapshot();
      mockIdentity();
      mockedPost.mockResolvedValueOnce({ success: true, data: { destinationHash: 'destHashA', ok: false, rttMs: null, hops: null, error: null } });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      await act(async () => { await result.current.probe('destHashA', 30); });

      expect(mockedPost).toHaveBeenCalledWith('/api/sources/s1/reticulum/paths/probe', { destinationHash: 'destHashA', timeoutS: 30 });
    });

    it('sets probingHash while the request is in flight', async () => {
      mockSnapshot();
      mockIdentity();
      let resolvePost: (value: unknown) => void = () => {};
      mockedPost.mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve; }));

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      let probePromise: Promise<ReticulumProbeResult | null> = Promise.resolve(null);
      act(() => { probePromise = result.current.probe('destHashA'); });

      await waitFor(() => expect(result.current.probingHash).toBe('destHashA'));

      await act(async () => {
        resolvePost({ success: true, data: { destinationHash: 'destHashA', ok: true, rttMs: 50, hops: 1, error: null } });
        await probePromise;
      });

      expect(result.current.probingHash).toBeNull();
    });

    it('returns null and sets an error on failure', async () => {
      mockSnapshot();
      mockIdentity();
      mockedPost.mockRejectedValueOnce(new Error('bridge unreachable'));

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      let returned: ReticulumProbeResult | null = { destinationHash: 'x', ok: true, rttMs: 1, hops: 1, error: null };
      await act(async () => {
        returned = await result.current.probe('destHashA');
      });

      expect(returned).toBeNull();
      expect(result.current.error).toBe('bridge unreachable');
      expect(result.current.probingHash).toBeNull();
    });
  });

  describe('queryRemoteStatus (Phase 4 WP4)', () => {
    it('GETs /remote-status/:hash and stores the result', async () => {
      mockSnapshot();
      mockIdentity();
      const remoteStatus: ReticulumRemoteStatus = {
        destinationHash: 'remoteHashA',
        ok: true,
        status: { interfaces: [], linkCount: 0 },
        path: [],
        error: null,
      };
      mockedGet.mockResolvedValueOnce({ success: true, data: remoteStatus });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      let returned: ReticulumRemoteStatus | null = null;
      await act(async () => {
        returned = await result.current.queryRemoteStatus('remoteHashA');
      });

      expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/remote-status/remoteHashA');
      expect(returned).toEqual(remoteStatus);
      expect(result.current.remoteStatus).toEqual(remoteStatus);
      expect(result.current.remoteStatusLoading).toBe(false);
    });

    it('appends the timeoutS query param when provided', async () => {
      mockSnapshot();
      mockIdentity();
      mockedGet.mockResolvedValueOnce({
        success: true,
        data: { destinationHash: 'remoteHashA', ok: false, status: null, path: null, error: 'timeout' },
      });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      await act(async () => { await result.current.queryRemoteStatus('remoteHashA', 20); });

      expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/remote-status/remoteHashA?timeoutS=20');
    });

    it('encodes the destination hash in the URL', async () => {
      mockSnapshot();
      mockIdentity();
      mockedGet.mockResolvedValueOnce({
        success: true,
        data: { destinationHash: 'a/b', ok: false, status: null, path: null, error: null },
      });

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      await act(async () => { await result.current.queryRemoteStatus('a/b'); });

      expect(mockedGet).toHaveBeenCalledWith('/api/sources/s1/reticulum/remote-status/a%2Fb');
    });

    it('returns null and sets an error on failure', async () => {
      mockSnapshot();
      mockIdentity();
      mockedGet.mockRejectedValueOnce(new Error('access denied'));

      const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
      await waitFor(() => expect(result.current.status).not.toBeNull());

      let returned: ReticulumRemoteStatus | null = { destinationHash: 'x', ok: true, status: null, path: null, error: null };
      await act(async () => {
        returned = await result.current.queryRemoteStatus('remoteHashA');
      });

      expect(returned).toBeNull();
      expect(result.current.error).toBe('access denied');
      expect(result.current.remoteStatusLoading).toBe(false);
    });
  });
});
