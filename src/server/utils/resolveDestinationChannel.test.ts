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
import { resolveDestinationChannel, resolveBroadcastChannel } from './resolveDestinationChannel.js';

type DbFacade = Parameters<typeof resolveDestinationChannel>[2];

function fakeDb(getNode: ReturnType<typeof vi.fn>): DbFacade {
  return { nodes: { getNode } } as unknown as DbFacade;
}

function fakeChannelDb(getAllChannels: ReturnType<typeof vi.fn>): DbFacade {
  return { channels: { getAllChannels } } as unknown as DbFacade;
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

/**
 * `resolveBroadcastChannel` picks a channel every node in the mesh can decrypt
 * (the well-known default key "AQ==", or an unencrypted slot). This is what
 * traceroute needs so intermediate nodes can append to the route — and why
 * hardcoding slot 0 was wrong: slot 0 can carry a private key (issue #3696).
 */
describe('resolveBroadcastChannel', () => {
  let getAllChannels: ReturnType<typeof vi.fn>;
  let db: DbFacade;

  beforeEach(() => {
    getAllChannels = vi.fn();
    db = fakeChannelDb(getAllChannels);
  });

  it('scopes the channel lookup to the manager sourceId', async () => {
    getAllChannels.mockResolvedValue([{ id: 0, psk: 'AQ==' }]);
    await resolveBroadcastChannel(manager, db);
    expect(getAllChannels).toHaveBeenCalledWith('meshtastic-src');
  });

  it('returns the default-keyed channel when it is slot 0', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'AQ==' },
      { id: 2, psk: 'cHJpdmF0ZWtleQ==' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('returns the default-keyed channel even when it is NOT slot 0', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZWtleQ==' }, // private primary
      { id: 3, psk: 'AQ==' },             // default-keyed secondary
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(3);
  });

  it('treats an unencrypted (null/empty PSK) channel as mesh-readable', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZWtleQ==' },
      { id: 1, psk: null },
      { id: 2, psk: '' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(1);
  });

  it('prefers the lowest-numbered mesh-readable channel', async () => {
    getAllChannels.mockResolvedValue([
      { id: 5, psk: 'AQ==' },
      { id: 1, psk: 'AQ==' },
      { id: 3, psk: 'AQ==' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(1);
  });

  it('falls back to channel 0 when every channel uses a private key', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZTA=' },
      { id: 2, psk: 'cHJpdmF0ZTI=' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('falls back to channel 0 when there are no channels at all', async () => {
    getAllChannels.mockResolvedValue([]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('ignores channels with out-of-range indices', async () => {
    getAllChannels.mockResolvedValue([
      { id: 101, psk: 'AQ==' }, // bogus MQTT-style index, must be skipped
      { id: 4, psk: 'AQ==' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(4);
  });

  it('does NOT select a DISABLED slot even though its NULL psk looks mesh-readable (#4173)', async () => {
    // Reporter's config: PRIMARY(0) uses a private key; slots 1–7 are DISABLED
    // (role 0) with a NULL psk. A disabled slot has no key on the node, so
    // encoding a traceroute on it NAKs NO_CHANNEL (6). The disabled NULL-psk
    // slots must be skipped and we fall back to the enabled PRIMARY slot 0.
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZWtleQ==', role: 1 }, // PRIMARY, private key
      { id: 1, psk: null, role: 0 },               // DISABLED
      { id: 2, psk: null, role: 0 },               // DISABLED
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('skips a DISABLED (null-psk) slot in favor of a lower-priority enabled default-keyed one', async () => {
    getAllChannels.mockResolvedValue([
      { id: 1, psk: null, role: 0 },   // DISABLED (null psk) — must be skipped
      { id: 2, psk: 'AQ==', role: 2 }, // enabled SECONDARY on the default key
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(2);
  });

  it('selects an enabled default-keyed SECONDARY over a private PRIMARY', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZQ==', role: 1 }, // PRIMARY, private
      { id: 3, psk: 'AQ==', role: 2 },         // enabled default-key SECONDARY
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(3);
  });
});
