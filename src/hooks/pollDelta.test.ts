/**
 * Client side of the incremental poll: fetchPollData sends the cursor of the
 * reply it last merged, merges deltas onto that reply, keeps untouched nodes
 * and sections as the same objects, and falls back to a full read when a
 * delta does not fit.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { fetchPollData } from './usePoll';
import { clearPollBases, mergePollReply, PollDeltaMismatchError } from './pollDelta';

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const n = (nodeNum: number, lastHeard = 1) => ({ nodeNum, user: { id: `!${nodeNum}` }, lastHeard });

describe('fetchPollData with deltas', () => {
  beforeEach(() => clearPollBases());

  it('sends an empty cursor first, then the cursor of the last reply', async () => {
    const authFetch = vi.fn()
      .mockResolvedValueOnce(json({ nodes: [n(1), n(2)], channels: [{ id: 0 }], pollCursor: 'e.1' }))
      .mockResolvedValueOnce(json({ nodes: [n(2, 9)], removedNodes: [], unchangedSections: ['channels'], pollDelta: true, pollCursor: 'e.2' }))
      .mockResolvedValueOnce(json({ nodes: [], removedNodes: [], unchangedSections: ['channels'], pollDelta: true, pollCursor: 'e.2' }));

    const first = await fetchPollData(authFetch, '', 's');
    expect(authFetch.mock.calls[0][0]).toBe('/api/poll?sourceId=s&cursor=');
    expect(first).toEqual({ nodes: [n(1), n(2)], channels: [{ id: 0 }] });

    const second = await fetchPollData(authFetch, '', 's');
    expect(authFetch.mock.calls[1][0]).toBe('/api/poll?sourceId=s&cursor=e.1');
    expect(second.nodes).toEqual([n(1), n(2, 9)]);
    expect(second.nodes![0]).toBe(first.nodes![0]);
    expect(second.channels).toBe(first.channels);

    const third = await fetchPollData(authFetch, '', 's');
    expect(authFetch.mock.calls[2][0]).toBe('/api/poll?sourceId=s&cursor=e.2');
    expect(third.nodes).toBe(second.nodes);
  });

  it('a delta that does not fit is dropped and the poll is read in full', async () => {
    const authFetch = vi.fn()
      .mockResolvedValueOnce(json({ nodes: [n(1)], pollCursor: 'e.1' }))
      // Names node 7 in the order without sending it: cannot be merged.
      .mockResolvedValueOnce(json({ nodes: [], removedNodes: [], nodeOrder: [1, 7], unchangedSections: [], pollDelta: true, pollCursor: 'e.2' }))
      .mockResolvedValueOnce(json({ nodes: [n(1), n(7)], pollCursor: 'e.2' }));

    await fetchPollData(authFetch, '', null);
    const data = await fetchPollData(authFetch, '', null);
    expect(authFetch.mock.calls[2][0]).toBe('/api/poll?cursor=');
    expect(data.nodes).toEqual([n(1), n(7)]);
  });

  it('a poll that changed nothing leaves the query data as the same object (no re-render)', async () => {
    const qc = new QueryClient();
    const authFetch = vi.fn()
      .mockResolvedValueOnce(json({ nodes: [n(1)], connection: { connected: true }, pollCursor: 'e.1' }))
      .mockResolvedValue(json({ nodes: [], removedNodes: [], connection: { connected: true }, unchangedSections: [], pollDelta: true, pollCursor: 'e.1' }));
    const read = () => qc.fetchQuery({ queryKey: ['poll', 's'], queryFn: () => fetchPollData(authFetch, '', 's'), staleTime: 0 });
    await read();
    const before = qc.getQueryData(['poll', 's']);
    await read();
    expect(qc.getQueryData(['poll', 's'])).toBe(before);
  });

  it('a reply with no cursor (older server) is used as is and no cursor is sent next', async () => {
    const authFetch = vi.fn().mockResolvedValue(json({ nodes: [n(1)] }));
    await fetchPollData(authFetch, '', 's');
    await fetchPollData(authFetch, '', 's');
    expect(authFetch.mock.calls[1][0]).toBe('/api/poll?sourceId=s&cursor=');
  });
});

describe('mergePollReply', () => {
  it('rejects a delta with no base', () => {
    expect(() => mergePollReply(null, { pollDelta: true, nodes: [] })).toThrow(PollDeltaMismatchError);
  });

  it('rejects a delta that adds a node without the order', () => {
    const base = { nodes: [n(1)] } as never;
    expect(() => mergePollReply(base, { pollDelta: true, nodes: [n(2)] as never, removedNodes: [] })).toThrow(PollDeltaMismatchError);
  });
});
