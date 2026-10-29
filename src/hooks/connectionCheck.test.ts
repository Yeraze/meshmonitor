import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  connectionCheckDelay,
  fetchConnectionStatus,
  mergeConnectionIntoPollCache,
  refreshPollCache,
} from './connectionCheck';

vi.mock('../init', () => ({ appBasename: '' }));

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const DOWN = { connected: false, nodeResponsive: false, configuring: false, userDisconnected: false };

describe('connectionCheckDelay', () => {
  it('steps 5 s, 10 s, 20 s, then stays at 30 s', () => {
    expect([0, 1, 2, 3, 4, 50].map(connectionCheckDelay)).toEqual([5000, 10000, 20000, 30000, 30000, 30000]);
  });
});

describe('fetchConnectionStatus', () => {
  it('reads /api/connection for the source, not /api/poll', async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonResponse(DOWN));
    await expect(fetchConnectionStatus(authFetch, '/mm', 'a b')).resolves.toEqual(DOWN);
    expect(authFetch).toHaveBeenCalledWith('/mm/api/connection?sourceId=a%20b', undefined, undefined);
  });

  it('reads the unscoped status with no source', async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonResponse(DOWN));
    await fetchConnectionStatus(authFetch, '', null);
    expect(authFetch.mock.calls[0][0]).toBe('/api/connection');
  });

  it('throws on a failed request', async () => {
    const authFetch = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    await expect(fetchConnectionStatus(authFetch, '', 's')).rejects.toThrow('500');
  });
});

describe('mergeConnectionIntoPollCache', () => {
  it('updates the cached connection but keeps the fetch time', () => {
    const qc = new QueryClient();
    qc.setQueryData(['poll', 's'], { connection: { ...DOWN, connected: true, nodeIp: '10.0.0.1' }, nodes: [{ nodeNum: 1 }] }, { updatedAt: 1000 });
    mergeConnectionIntoPollCache(qc, 's', DOWN);
    const data = qc.getQueryData<{ connection: Record<string, unknown>; nodes: unknown[] }>(['poll', 's']);
    expect(data?.connection.connected).toBe(false);
    expect(data?.connection.nodeIp).toBe('10.0.0.1');
    expect(data?.nodes).toHaveLength(1);
    expect(qc.getQueryState(['poll', 's'])?.dataUpdatedAt).toBe(1000);
  });

  it('does nothing when no poll is cached', () => {
    const qc = new QueryClient();
    mergeConnectionIntoPollCache(qc, 's', DOWN);
    expect(qc.getQueryData(['poll', 's'])).toBeUndefined();
  });
});

describe('refreshPollCache', () => {
  it('reads the full poll for the source into the shared query entry', async () => {
    const qc = new QueryClient();
    const authFetch = vi.fn().mockResolvedValue(jsonResponse({ nodes: [] }));
    await refreshPollCache(qc, authFetch, '', 's');
    expect(authFetch.mock.calls[0][0]).toBe('/api/poll?sourceId=s');
    expect(qc.getQueryData(['poll', 's'])).toEqual({ nodes: [] });
  });

  it('shares a read that finished within the last 3 s', async () => {
    const qc = new QueryClient();
    const authFetch = vi.fn().mockResolvedValue(jsonResponse({ nodes: [] }));
    await refreshPollCache(qc, authFetch, '', 's');
    await refreshPollCache(qc, authFetch, '', 's');
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
