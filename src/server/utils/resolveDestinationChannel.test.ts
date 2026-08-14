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
 * AND relay: a mesh-readable PSK (any 1-byte shorthand, or unencrypted) whose
 * name also matches a firmware ModemPreset display name (issue #4691's "well
 * known channel" pairing — the on-wire hash is `hash(name) XOR hash(psk)`).
 * This is what traceroute needs so intermediate nodes can append to the
 * route — and why hardcoding slot 0 was wrong: slot 0 can carry a private key
 * (issue #3696).
 */
describe('resolveBroadcastChannel', () => {
  let getAllChannels: ReturnType<typeof vi.fn>;
  let db: DbFacade;

  beforeEach(() => {
    getAllChannels = vi.fn();
    db = fakeChannelDb(getAllChannels);
  });

  it('scopes the channel lookup to the manager sourceId', async () => {
    getAllChannels.mockResolvedValue([{ id: 0, psk: 'AQ==', name: 'LongFast' }]);
    await resolveBroadcastChannel(manager, db);
    expect(getAllChannels).toHaveBeenCalledWith('meshtastic-src');
  });

  it('returns the default-keyed channel when it is slot 0', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'AQ==', name: 'LongFast' },
      { id: 2, psk: 'cHJpdmF0ZWtleQ==', name: 'Secret' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('returns the default-keyed channel even when it is NOT slot 0', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZWtleQ==', name: 'LongFast' }, // private primary
      { id: 3, psk: 'AQ==', name: 'LongFast' },             // default-keyed secondary
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(3);
  });

  it('treats an unencrypted (null/empty PSK) channel as mesh-readable', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZWtleQ==', name: 'LongFast' },
      { id: 1, psk: null, name: 'LongFast' },
      { id: 2, psk: '', name: 'LongFast' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(1);
  });

  it('accepts any 1-byte shorthand PSK, not just the literal default byte (#4691)', async () => {
    // Byte 0xD4 (212) base64-encodes to "1A==" — a 1-byte shorthand outside
    // the literal "AQ==" (0x01) the old check required.
    getAllChannels.mockResolvedValue([{ id: 0, psk: '1A==', name: 'LongFast' }]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('rejects a mesh-readable PSK whose channel name is not a ModemPreset name (#4691)', async () => {
    // 1-byte PSK, but a custom name — the on-wire hash won't match any other
    // node's factory-configured channel, so it's not actually relayable.
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'AQ==', name: 'MyPrivateChannel' },
      { id: 2, psk: 'AQ==', name: 'MediumFast' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(2);
  });

  it('rejects the deprecated VeryLongSlow preset name even with a mesh-readable PSK (#4691)', async () => {
    // Firmware's getModemPresetDisplayName() has no case for index 2 and
    // always falls through to "Invalid" on-device, so no real channel name
    // can ever equal "VeryLongSlow" on the wire.
    getAllChannels.mockResolvedValue([{ id: 0, psk: 'AQ==', name: 'VeryLongSlow' }]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0); // falls back, not selected as "readable"
  });

  it('prefers the lowest-numbered mesh-readable channel', async () => {
    getAllChannels.mockResolvedValue([
      { id: 5, psk: 'AQ==', name: 'LongFast' },
      { id: 1, psk: 'AQ==', name: 'LongFast' },
      { id: 3, psk: 'AQ==', name: 'LongFast' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(1);
  });

  it('falls back to channel 0 when every channel uses a private key', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZTA=', name: 'LongFast' },
      { id: 2, psk: 'cHJpdmF0ZTI=', name: 'LongFast' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('falls back to channel 0 when there are no channels at all', async () => {
    getAllChannels.mockResolvedValue([]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('ignores channels with out-of-range indices', async () => {
    getAllChannels.mockResolvedValue([
      { id: 101, psk: 'AQ==', name: 'LongFast' }, // bogus MQTT-style index, must be skipped
      { id: 4, psk: 'AQ==', name: 'LongFast' },
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(4);
  });

  it('does NOT select a DISABLED slot even though its NULL psk looks mesh-readable (#4173)', async () => {
    // Reporter's config: PRIMARY(0) uses a private key; slots 1–7 are DISABLED
    // (role 0) with a NULL psk. A disabled slot has no key on the node, so
    // encoding a traceroute on it NAKs NO_CHANNEL (6). The disabled NULL-psk
    // slots must be skipped and we fall back to the enabled PRIMARY slot 0.
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZWtleQ==', role: 1, name: 'LongFast' }, // PRIMARY, private key
      { id: 1, psk: null, role: 0, name: 'LongFast' },               // DISABLED
      { id: 2, psk: null, role: 0, name: 'LongFast' },               // DISABLED
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(0);
  });

  it('skips a DISABLED (null-psk) slot in favor of a lower-priority enabled default-keyed one', async () => {
    getAllChannels.mockResolvedValue([
      { id: 1, psk: null, role: 0, name: 'LongFast' },   // DISABLED (null psk) — must be skipped
      { id: 2, psk: 'AQ==', role: 2, name: 'LongFast' }, // enabled SECONDARY on the default key
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(2);
  });

  it('selects an enabled default-keyed SECONDARY over a private PRIMARY', async () => {
    getAllChannels.mockResolvedValue([
      { id: 0, psk: 'cHJpdmF0ZQ==', role: 1, name: 'LongFast' }, // PRIMARY, private
      { id: 3, psk: 'AQ==', role: 2, name: 'LongFast' },         // enabled default-key SECONDARY
    ]);
    expect(await resolveBroadcastChannel(manager, db)).toBe(3);
  });
});
