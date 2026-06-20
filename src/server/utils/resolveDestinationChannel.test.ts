/**
 * Tests for `resolveDestinationChannel` — the shared channel resolver used by
 * the telemetry / traceroute / position / nodeInfo / neighborInfo request routes.
 *
 * Issue #3573 background: these routes used to look up the destination's channel
 * with the request-body `sourceId`, which the telemetry frontend never sent. With
 * `sourceId` undefined, `getNode` cross-source-matched a row from an MQTT source
 * whose stored `channel` was an out-of-range value (e.g. 101 — Meshtastic channels
 * are 0–7). The request then went out on that bogus channel and was never answered.
 * This helper scopes the lookup to the manager's real `sourceId` and clamps to 0–7.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveDestinationChannel } from './resolveDestinationChannel.js';

type DbFacade = Parameters<typeof resolveDestinationChannel>[2];

function fakeDb(getNode: ReturnType<typeof vi.fn>): DbFacade {
  return { nodes: { getNode } } as unknown as DbFacade;
}

const manager = { sourceId: 'meshtastic-src' };

describe('resolveDestinationChannel', () => {
  let getNode: ReturnType<typeof vi.fn>;
  let db: DbFacade;

  beforeEach(() => {
    getNode = vi.fn();
    db = fakeDb(getNode);
  });

  it('scopes the node lookup to the manager sourceId, not any body sourceId', async () => {
    getNode.mockResolvedValue({ channel: 0 });
    await resolveDestinationChannel(0x1234, manager, db);
    expect(getNode).toHaveBeenCalledWith(0x1234, 'meshtastic-src');
  });

  it('returns the stored channel when it is a valid index', async () => {
    getNode.mockResolvedValue({ channel: 3 });
    expect(await resolveDestinationChannel(0x1234, manager, db)).toBe(3);
  });

  it('clamps an out-of-range stored channel (the MQTT channel=101 bug) to 0', async () => {
    getNode.mockResolvedValue({ channel: 101 });
    expect(await resolveDestinationChannel(0x1234, manager, db)).toBe(0);
  });

  it('defaults to 0 when the node is not found on this source', async () => {
    getNode.mockResolvedValue(null);
    expect(await resolveDestinationChannel(0x1234, manager, db)).toBe(0);
  });

  it('defaults to 0 when the stored channel is null/undefined', async () => {
    getNode.mockResolvedValue({ channel: null });
    expect(await resolveDestinationChannel(0x1234, manager, db)).toBe(0);
  });

  it('honors a valid explicit channel without querying the database', async () => {
    expect(await resolveDestinationChannel(0x1234, manager, db, 5)).toBe(5);
    expect(getNode).not.toHaveBeenCalled();
  });

  it('ignores an out-of-range explicit channel and falls back to the stored channel', async () => {
    getNode.mockResolvedValue({ channel: 2 });
    expect(await resolveDestinationChannel(0x1234, manager, db, 101)).toBe(2);
    expect(getNode).toHaveBeenCalledWith(0x1234, 'meshtastic-src');
  });

  it('ignores a non-numeric explicit channel and uses the stored channel', async () => {
    getNode.mockResolvedValue({ channel: 1 });
    expect(await resolveDestinationChannel(0x1234, manager, db, 'two' as unknown as number)).toBe(1);
  });

  it('rejects a negative explicit channel', async () => {
    getNode.mockResolvedValue({ channel: 0 });
    expect(await resolveDestinationChannel(0x1234, manager, db, -1)).toBe(0);
  });
});
