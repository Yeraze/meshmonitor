/**
 * @vitest-environment jsdom
 *
 * Server-backed read state in the MeshCore unread store (#4607).
 *
 * The store used to keep last-read markers in localStorage alone, which is
 * per-BROWSER — two operators sharing a machine shared one set of markers.
 * These tests pin the properties that make the durable, per-user server copy
 * safe to layer on top of the existing synchronous API:
 *  - reads merge local + server by taking the LATER value, so nothing rewinds;
 *  - writes reach the server;
 *  - and with no transport configured the store behaves exactly as before.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  configureReadStateTransport,
  hydrateReadState,
  resetReadStateCache,
  loadChannelLastRead,
  loadDmLastRead,
  markChannelRead,
  markDmRead,
  channelLastReadKey,
  dmLastReadKey,
  type ReadStateTransport,
} from './meshcoreUnreadStore';

const SRC = 'source-a';

function makeTransport(data: Record<string, Record<string, number>> | null): ReadStateTransport & {
  saves: Array<[string, string, string, number]>;
} {
  const saves: Array<[string, string, string, number]> = [];
  return {
    saves,
    load: vi.fn().mockResolvedValue(data),
    save: vi.fn(async (sourceId, kind, key, ts) => {
      saves.push([sourceId, kind, key, ts]);
    }),
  } as any;
}

beforeEach(() => {
  localStorage.clear();
  resetReadStateCache();
  configureReadStateTransport(null);
});

describe('meshcoreUnreadStore — server read state (#4607)', () => {
  it('behaves as localStorage-only when no transport is configured', async () => {
    markChannelRead(SRC, 0, 1000);
    // No throw, no network — and hydration is a quiet no-op.
    await hydrateReadState(SRC);
    expect(loadChannelLastRead(SRC)[0]).toBe(1000);
  });

  it('merges hydrated server markers into synchronous reads', async () => {
    configureReadStateTransport(makeTransport({
      meshcore_channel: { '0': 5000 },
      meshcore_dm: { peerA: 7000 },
    }));

    await hydrateReadState(SRC);

    expect(loadChannelLastRead(SRC)[0]).toBe(5000);
    expect(loadDmLastRead(SRC).peerA).toBe(7000);
  });

  it('keeps the LATER marker when local and server disagree', async () => {
    // A marker written in this tab may not have round-tripped yet; an older
    // server value must not overwrite it and re-light the unread dot.
    localStorage.setItem(channelLastReadKey(SRC), JSON.stringify({ 0: 9000 }));
    localStorage.setItem(dmLastReadKey(SRC), JSON.stringify({ peerA: 100 }));

    configureReadStateTransport(makeTransport({
      meshcore_channel: { '0': 1000 },
      meshcore_dm: { peerA: 8000 },
    }));
    await hydrateReadState(SRC);

    expect(loadChannelLastRead(SRC)[0]).toBe(9000); // local ahead
    expect(loadDmLastRead(SRC).peerA).toBe(8000);   // server ahead
  });

  it('scopes hydrated markers to their source', async () => {
    configureReadStateTransport(makeTransport({
      meshcore_channel: { '0': 5000 },
      meshcore_dm: {},
    }));
    await hydrateReadState(SRC);

    expect(loadChannelLastRead('other-source')[0]).toBeUndefined();
  });

  it('mirrors a channel mark-read to the server', () => {
    const transport = makeTransport({ meshcore_channel: {}, meshcore_dm: {} });
    configureReadStateTransport(transport);

    markChannelRead(SRC, 3, 4242);

    expect(transport.save).toHaveBeenCalledWith(SRC, 'meshcore_channel', '3', 4242);
  });

  it('mirrors a DM mark-read to the server', () => {
    const transport = makeTransport({ meshcore_channel: {}, meshcore_dm: {} });
    configureReadStateTransport(transport);

    markDmRead(SRC, 'peerA', 999);

    expect(transport.save).toHaveBeenCalledWith(SRC, 'meshcore_dm', 'peerA', 999);
  });

  it('does not write to the server when the marker would move backwards', () => {
    const transport = makeTransport({ meshcore_channel: {}, meshcore_dm: {} });
    configureReadStateTransport(transport);

    markChannelRead(SRC, 0, 5000);
    (transport.save as any).mockClear();
    markChannelRead(SRC, 0, 1000);

    expect(transport.save).not.toHaveBeenCalled();
  });

  it('survives a failing server without breaking reads', async () => {
    const failing: ReadStateTransport = {
      load: vi.fn().mockRejectedValue(new Error('offline')),
      save: vi.fn().mockRejectedValue(new Error('offline')),
    };
    configureReadStateTransport(failing);

    await expect(hydrateReadState(SRC)).resolves.toBeUndefined();
    expect(() => markChannelRead(SRC, 0, 1000)).not.toThrow();
    // localStorage still holds the marker, so the UI keeps working.
    expect(loadChannelLastRead(SRC)[0]).toBe(1000);
  });

  it('hydrates a source only once unless forced', async () => {
    const transport = makeTransport({ meshcore_channel: {}, meshcore_dm: {} });
    configureReadStateTransport(transport);

    await hydrateReadState(SRC);
    await hydrateReadState(SRC);
    expect(transport.load).toHaveBeenCalledTimes(1);

    await hydrateReadState(SRC, true);
    expect(transport.load).toHaveBeenCalledTimes(2);
  });

  it('tolerates a server response with no read state at all', async () => {
    configureReadStateTransport(makeTransport(null));
    await hydrateReadState(SRC);
    expect(loadChannelLastRead(SRC)).toEqual({});
  });
});
