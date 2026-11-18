/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
vi.mock('../services/api', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));

import { parseUnifiedSenders, sendersForChannel, useUnifiedSenders } from './useUnifiedSenders';
import { parseMeshCoreLocalNodeName, useMeshCoreLocalNodeName } from './useMeshCoreLocalNodeName';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('useUnifiedSenders', () => {
  beforeEach(() => get.mockReset());

  it('parser unwraps data.channels and accepts {}', () => {
    expect(parseUnifiedSenders({ success: true, data: { channels: [{ name: 'a', sources: [] }] } })).toHaveLength(1);
    expect(parseUnifiedSenders({})).toEqual([]);
    expect(parseUnifiedSenders(null)).toEqual([]);
    expect(parseUnifiedSenders({ data: {} })).toEqual([]);
  });

  it('sendersForChannel matches exactly, then case-insensitively', () => {
    const s = (id: string) => ({ sourceId: id, sourceName: id, channelNumber: 0, canSend: true, sendKind: null, sendBlockedReason: null, reactionsOutbound: null });
    const channels = [{ name: '#Public', sources: [s('a')] }, { name: '#public', sources: [s('b')] }];
    expect(sendersForChannel(channels, '#public')[0].sourceId).toBe('b');
    expect(sendersForChannel(channels, '#PUBLIC')[0].sourceId).toBe('a');
    expect(sendersForChannel(channels, 'none')).toEqual([]);
    expect(sendersForChannel(undefined, 'x')).toEqual([]);
  });

  it('does not fetch when disabled, fetches when enabled', async () => {
    get.mockResolvedValue({ data: { channels: [] } });
    renderHook(() => useUnifiedSenders(false), { wrapper });
    expect(get).not.toHaveBeenCalled();
    const { result } = renderHook(() => useUnifiedSenders(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/api/unified/senders');
  });
});

describe('useMeshCoreLocalNodeName', () => {
  beforeEach(() => get.mockReset());

  it('parses the name', () => {
    expect(parseMeshCoreLocalNodeName({ data: { localNode: { name: 'Node1' } } })).toBe('Node1');
    expect(parseMeshCoreLocalNodeName({ data: { localNode: null } })).toBeNull();
    expect(parseMeshCoreLocalNodeName({})).toBeNull();
  });

  it('returns the name, and null on failure', async () => {
    get.mockResolvedValueOnce({ data: { localNode: { name: 'Node1' } } });
    const ok = renderHook(() => useMeshCoreLocalNodeName('c/1', true), { wrapper });
    await waitFor(() => expect(ok.result.current).toBe('Node1'));
    expect(get).toHaveBeenCalledWith('/api/sources/c%2F1/meshcore/status');

    get.mockRejectedValueOnce(new Error('403'));
    const bad = renderHook(() => useMeshCoreLocalNodeName('d', true), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(bad.result.current).toBeNull();
  });

  it('does not fetch when disabled', () => {
    renderHook(() => useMeshCoreLocalNodeName('c', false), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });
});
