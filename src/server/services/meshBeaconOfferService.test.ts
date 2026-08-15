/**
 * MeshBeacon offer ingestion (#4723).
 *
 * The service sits on the shared data-event fan-out, so the properties worth
 * pinning are mostly about what it must NOT do: never throw into the bus, never
 * coerce a valid zero enum away, never invent a source for an unattributable
 * beacon.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordBeacon = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: { get meshBeaconOffers() { return { recordBeacon }; } },
}));

import { recordMeshBeaconOffer } from './meshBeaconOfferService.js';

const beacon = (o: Record<string, unknown> = {}) => ({
  nodeNum: 0xaabbccdd,
  message: 'join us',
  offerChannelName: 'RegionMesh',
  offerChannelPsk: 'AQ==',
  offerRegion: 1,
  offerPreset: 2,
  ...o,
}) as never;

beforeEach(() => recordBeacon.mockReset());

describe('recordMeshBeaconOffer', () => {
  it('persists a beacon against its source', async () => {
    await recordMeshBeaconOffer(beacon(), 'src-a', 1_000);

    expect(recordBeacon).toHaveBeenCalledWith(
      'src-a',
      0xaabbccdd,
      {
        message: 'join us',
        offerChannelName: 'RegionMesh',
        offerChannelPsk: 'AQ==',
        offerRegion: 1,
        offerPreset: 2,
      },
      1_000,
    );
  });

  it('preserves preset 0 — LONG_FAST is a real offer, not "absent"', async () => {
    // `offer_preset` is declared `optional` in the protobuf, so 0 has explicit
    // presence. `|| null` here would turn a real offer into "no offer".
    await recordMeshBeaconOffer(beacon({ offerPreset: 0 }), 'src-a', 1_000);

    expect(recordBeacon.mock.calls[0][2]).toMatchObject({ offerPreset: 0 });
  });

  it('carries the offered channel key through to storage', async () => {
    // Without the PSK an accepted offer would join with the right name and no
    // usable key — a channel that silently decrypts nothing.
    await recordMeshBeaconOffer(beacon({ offerChannelPsk: 'c2VjcmV0' }), 'src-a', 1_000);

    expect(recordBeacon.mock.calls[0][2]).toMatchObject({ offerChannelPsk: 'c2VjcmV0' });
  });

  it('maps absent offer fields to null rather than undefined', async () => {
    await recordMeshBeaconOffer(
      beacon({
        offerChannelName: undefined, offerChannelPsk: undefined,
        offerRegion: undefined, offerPreset: undefined,
      }),
      'src-a', 1_000,
    );

    expect(recordBeacon.mock.calls[0][2]).toEqual({
      message: 'join us', offerChannelName: null, offerChannelPsk: null,
      offerRegion: null, offerPreset: null,
    });
  });

  it('drops a beacon with no source — the table is per-source and unattributable offers are unactionable', async () => {
    await recordMeshBeaconOffer(beacon(), undefined, 1_000);
    expect(recordBeacon).not.toHaveBeenCalled();
  });

  it('drops a beacon with no usable node number', async () => {
    await recordMeshBeaconOffer(beacon({ nodeNum: undefined }), 'src-a', 1_000);
    expect(recordBeacon).not.toHaveBeenCalled();
  });

  it('swallows a write failure instead of throwing into the shared event bus', async () => {
    // Beacons rebroadcast, so losing one row is harmless — but throwing here
    // would propagate through the data-event fan-out to every other subscriber.
    recordBeacon.mockRejectedValueOnce(new Error('db down'));
    await expect(recordMeshBeaconOffer(beacon(), 'src-a', 1_000)).resolves.toBeUndefined();
  });
});
