/**
 * @vitest-environment jsdom
 *
 * useReticulum (#3960 Phase 1b WP1) — poll-based status/destinations/
 * interfaces fetch + favorite toggle. Pins: the `{success,data}` envelope
 * unwrap (`api.get`/`api.post` do NOT unwrap `data` — CLAUDE.md), the 30s
 * poll cadence (R4, no Socket.io events for Reticulum), and that
 * `enabled: false` suppresses all fetching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import api from '../../../services/api';
import { useReticulum } from './useReticulum';
import type { ReticulumStatus, ReticulumDestinationRow, ReticulumInterfaceRow } from '../../../types/reticulum';

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

/** Resolves the three GET calls (status, destinations, interfaces) in order. */
function mockSnapshot(
  status: ReticulumStatus = baseStatus(),
  destinations: ReticulumDestinationRow[] = [baseDestination()],
  interfaces: ReticulumInterfaceRow[] = [baseInterface()],
) {
  mockedGet
    .mockResolvedValueOnce({ success: true, data: status })
    .mockResolvedValueOnce({ success: true, data: destinations })
    .mockResolvedValueOnce({ success: true, data: interfaces });
}

describe('useReticulum', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedPost.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches and unwraps status/destinations/interfaces on mount', async () => {
    mockSnapshot();

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(mockedGet).toHaveBeenNthCalledWith(1, '/api/sources/s1/reticulum/status');
    expect(mockedGet).toHaveBeenNthCalledWith(2, '/api/sources/s1/reticulum/destinations');
    expect(mockedGet).toHaveBeenNthCalledWith(3, '/api/sources/s1/reticulum/interfaces');

    expect(result.current.status).toEqual(baseStatus());
    expect(result.current.destinations).toEqual([baseDestination()]);
    expect(result.current.interfaces).toEqual([baseInterface()]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    // A future "just use the body" regression (reading fields straight off
    // the un-enveloped response) must fail here.
    expect((result.current.status as unknown as { success?: boolean }).success).toBeUndefined();
  });

  it('tolerates an unwrapped (no {data} envelope) response', async () => {
    mockedGet
      .mockResolvedValueOnce(baseStatus())
      .mockResolvedValueOnce([baseDestination()])
      .mockResolvedValueOnce([baseInterface()]);

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.status).toEqual(baseStatus());
    expect(result.current.destinations).toEqual([baseDestination()]);
  });

  it('enabled: false short-circuits all fetching', async () => {
    const { result } = renderHook(() => useReticulum({ sourceId: 's1', enabled: false }));

    // Give any accidental async fetch a tick to fire.
    await act(async () => { await Promise.resolve(); });

    expect(mockedGet).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
    expect(result.current.destinations).toEqual([]);
    expect(result.current.interfaces).toEqual([]);
  });

  it('polls again after 30s (R4 — no push events, poll is the only refresh)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSnapshot();
    mockSnapshot(baseStatus({ destinationCount: 5 }));

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));

    await waitFor(() => expect(result.current.status?.destinationCount).toBe(2));
    expect(mockedGet).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(30000);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.status?.destinationCount).toBe(5));
    expect(mockedGet).toHaveBeenCalledTimes(6);
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
    mockSnapshot(baseStatus({ interfaceCount: 9 }));

    const { result } = renderHook(() => useReticulum({ sourceId: 's1' }));
    await waitFor(() => expect(result.current.status?.interfaceCount).toBe(1));

    await act(async () => { await result.current.refresh(); });

    expect(result.current.status?.interfaceCount).toBe(9);
    expect(mockedGet).toHaveBeenCalledTimes(6);
  });

  describe('toggleFavorite', () => {
    it('POSTs to /destinations/:hash/favorite and patches the local list from the response', async () => {
      mockSnapshot(baseStatus(), [baseDestination({ destinationHash: 'hashA', isFavorite: false })]);
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
});
