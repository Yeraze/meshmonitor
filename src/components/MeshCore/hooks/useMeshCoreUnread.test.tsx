/**
 * @vitest-environment jsdom
 *
 * Tests for the page-level useMeshCoreUnread hook (#3891): channel unread from
 * the polled channel-counts endpoint, DM unread from the in-memory message
 * pool, and the enabled gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const csrfFetchMock = vi.fn();
vi.mock('../../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

import { useMeshCoreUnread } from './useMeshCoreUnread';

const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const contacts = [{ publicKey: SELF }, { publicKey: PEER }] as any;

function routeFetch(latestTimestamps: Record<number, number>) {
  csrfFetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => [{ id: 0 }, { id: 1 }] });
    }
    if (url.includes('/channel-counts')) {
      return Promise.resolve({ ok: true, json: async () => ({ latestTimestamps }) });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

describe('useMeshCoreUnread', () => {
  beforeEach(() => {
    localStorage.clear();
    csrfFetchMock.mockReset();
  });

  it('flags channels unread when the server latest timestamp beats the read marker', async () => {
    routeFetch({ 1: 5000 });
    const { result } = renderHook(() =>
      useMeshCoreUnread({ baseUrl: '', sourceId: 'src1', messages: [], contacts, selfKey: SELF, enabled: true }),
    );
    await waitFor(() => expect(result.current.channels).toBe(true));
  });

  it('does not flag channels when everything is already read', async () => {
    localStorage.setItem('meshmonitor-meshcore-channel-lastread-src1', JSON.stringify({ 1: 9000 }));
    routeFetch({ 1: 5000 });
    const { result } = renderHook(() =>
      useMeshCoreUnread({ baseUrl: '', sourceId: 'src1', messages: [], contacts, selfKey: SELF, enabled: true }),
    );
    // Give the fetch a tick to resolve, then assert it stays false.
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.channels).toBe(false);
  });

  it('flags DMs unread from an incoming message in the pool (no fetch needed)', () => {
    routeFetch({});
    const messages = [{ fromPublicKey: PEER, toPublicKey: SELF, timestamp: 1000, text: 'hi' }] as any;
    const { result } = renderHook(() =>
      useMeshCoreUnread({ baseUrl: '', sourceId: 'src1', messages, contacts, selfKey: SELF, enabled: true }),
    );
    expect(result.current.dms).toBe(true);
  });

  it('does not poll or flag anything when disabled', async () => {
    routeFetch({ 1: 5000 });
    const { result } = renderHook(() =>
      useMeshCoreUnread({ baseUrl: '', sourceId: 'src1', messages: [], contacts, selfKey: SELF, enabled: false }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(csrfFetchMock).not.toHaveBeenCalled();
    expect(result.current.channels).toBe(false);
    expect(result.current.dms).toBe(false);
  });
});
