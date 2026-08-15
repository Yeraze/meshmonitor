/**
 * MeshBeaconOffersRepository (#4723).
 *
 * The table exists so a dismissal outlives the next rebroadcast — beacons are
 * periodic by nature, so a card that reappeared every cycle would be worse than
 * no card. Most of what is worth testing here is therefore about what a
 * rebroadcast must and must NOT disturb, plus the per-source isolation that
 * keeps one source's offers out of another's card.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MeshBeaconOffersRepository,
  offerContentChanged,
  computeHasOffer,
  toPublicOffer,
  type BeaconOfferInput,
} from './meshBeaconOffers.js';
import { ALL_SOURCES } from './base.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';
const NODE = 0xaabbccdd;

const offer = (o: Partial<BeaconOfferInput> = {}): BeaconOfferInput => ({
  message: 'join us',
  offerChannelName: 'RegionMesh',
  offerChannelPsk: 'AQ==',
  offerRegion: 1,
  offerPreset: 2,
  ...o,
});

describe('offerContentChanged', () => {
  it('ignores a re-worded message — same invitation, dismissal must stick', () => {
    expect(offerContentChanged(offer(), offer({ message: 'come join us!' }))).toBe(false);
  });

  it('treats a different channel, region or preset as a new invitation', () => {
    expect(offerContentChanged(offer(), offer({ offerChannelName: 'OtherMesh' }))).toBe(true);
    expect(offerContentChanged(offer(), offer({ offerRegion: 7 }))).toBe(true);
    expect(offerContentChanged(offer(), offer({ offerPreset: 5 }))).toBe(true);
  });

  it('treats the same channel name re-keyed as a new invitation', () => {
    // Same name, different PSK is a different network — someone who declined
    // the old one has not been asked about this one.
    expect(offerContentChanged(offer(), offer({ offerChannelPsk: 'Zm9v' }))).toBe(true);
  });
});

describe('computeHasOffer', () => {
  // RegionCode.UNSET === 0 and `offer_region` is a plain proto3 enum field, so
  // a zero region means "none offered". `offer_preset` is declared `optional`,
  // so preset 0 (LONG_FAST) is real. Getting these the same way round is the
  // easy mistake, so both directions are pinned.
  const bare = { message: '', offerChannelName: null, offerChannelPsk: null, offerRegion: null, offerPreset: null };

  it('reads region 0 as UNSET, not as an offer', () => {
    expect(computeHasOffer({ ...bare, offerRegion: 0 })).toBe(false);
  });

  it('reads preset 0 as LONG_FAST — a genuine offer', () => {
    expect(computeHasOffer({ ...bare, offerPreset: 0 })).toBe(true);
  });

  it('reads a named channel as an offer', () => {
    expect(computeHasOffer({ ...bare, offerChannelName: 'Mesh' })).toBe(true);
  });

  it('reads a bare text beacon as no offer', () => {
    expect(computeHasOffer(bare)).toBe(false);
  });
});

describe('toPublicOffer', () => {
  it('strips the channel key', () => {
    // The PSK is why accept is server-side; leaking it here would defeat that.
    const pub = toPublicOffer({
      sourceId: SRC_A, nodeNum: NODE, message: 'hi',
      offerChannelName: 'Mesh', offerChannelPsk: 'c2VjcmV0',
      offerRegion: 1, offerPreset: 2, hasOffer: true,
      firstSeenAt: 1, lastSeenAt: 2, dismissedAt: null,
    });

    expect(JSON.stringify(pub)).not.toContain('c2VjcmV0');
    expect('offerChannelPsk' in pub).toBe(false);
    expect(pub.hasChannelKey).toBe(true);
  });

  it('reports hasChannelKey false when the offer came without one', () => {
    const pub = toPublicOffer({
      sourceId: SRC_A, nodeNum: NODE, message: 'hi',
      offerChannelName: 'Mesh', offerChannelPsk: null,
      offerRegion: null, offerPreset: null, hasOffer: true,
      firstSeenAt: 1, lastSeenAt: 2, dismissedAt: null,
    });
    expect(pub.hasChannelKey).toBe(false);
  });
});

describe('MeshBeaconOffersRepository', () => {
  let testDb: TestDb;
  let repo: MeshBeaconOffersRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new MeshBeaconOffersRepository(testDb.db, 'sqlite');
  });
  afterEach(() => testDb.close());

  it('records a beacon and lists it as pending', async () => {
    await repo.recordBeacon(SRC_A, NODE, offer(), 1_000);
    const pending = await repo.listPending(SRC_A);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      sourceId: SRC_A, nodeNum: NODE, offerChannelName: 'RegionMesh', hasOffer: true, dismissedAt: null,
    });
  });

  it('preserves firstSeenAt and advances lastSeenAt across a rebroadcast', async () => {
    await repo.recordBeacon(SRC_A, NODE, offer(), 1_000);
    await repo.recordBeacon(SRC_A, NODE, offer(), 5_000);

    const row = await repo.getOffer(SRC_A, NODE);
    expect(row?.firstSeenAt).toBe(1_000);
    expect(row?.lastSeenAt).toBe(5_000);
    // Upsert, not append — one row per beaconing node.
    expect(await repo.listAll(SRC_A)).toHaveLength(1);
  });

  it('keeps a dismissal through a rebroadcast — the anti-nag guarantee', async () => {
    await repo.recordBeacon(SRC_A, NODE, offer(), 1_000);
    await repo.dismiss(SRC_A, NODE, 2_000);
    expect(await repo.listPending(SRC_A)).toHaveLength(0);

    // The same offer comes round again, as beacons do.
    await repo.recordBeacon(SRC_A, NODE, offer({ message: 'join us (again)' }), 3_000);

    expect(await repo.listPending(SRC_A)).toHaveLength(0);
    const row = await repo.getOffer(SRC_A, NODE);
    expect(row?.dismissedAt).toBe(2_000);
    expect(row?.lastSeenAt).toBe(3_000); // still tracked, just not shown
  });

  it('resurfaces a dismissed offer when the advertised network changes', async () => {
    await repo.recordBeacon(SRC_A, NODE, offer(), 1_000);
    await repo.dismiss(SRC_A, NODE, 2_000);

    await repo.recordBeacon(SRC_A, NODE, offer({ offerChannelName: 'DifferentMesh' }), 3_000);

    const pending = await repo.listPending(SRC_A);
    expect(pending).toHaveLength(1);
    expect(pending[0].offerChannelName).toBe('DifferentMesh');
    expect(pending[0].dismissedAt).toBeNull();
  });

  it('marks a text-only beacon as having no offer', async () => {
    await repo.recordBeacon(
      SRC_A, NODE,
      { message: 'hello', offerChannelName: null, offerChannelPsk: null, offerRegion: null, offerPreset: null },
      1_000,
    );
    const row = await repo.getOffer(SRC_A, NODE);
    expect(row?.hasOffer).toBe(false);
  });

  it('round-trips the channel key so an accept has something to join with', async () => {
    await repo.recordBeacon(SRC_A, NODE, offer({ offerChannelPsk: 'c2VjcmV0' }), 1_000);
    expect((await repo.getOffer(SRC_A, NODE))?.offerChannelPsk).toBe('c2VjcmV0');
  });

  it('isolates offers between sources', async () => {
    // Same physical node heard by two sources → two independent rows, because
    // accepting is a per-source device action.
    await repo.recordBeacon(SRC_A, NODE, offer({ offerChannelName: 'MeshA' }), 1_000);
    await repo.recordBeacon(SRC_B, NODE, offer({ offerChannelName: 'MeshB' }), 1_000);

    expect(await repo.listPending(SRC_A)).toHaveLength(1);
    expect((await repo.listPending(SRC_A))[0].offerChannelName).toBe('MeshA');
    expect((await repo.listPending(SRC_B))[0].offerChannelName).toBe('MeshB');
    expect(await repo.listPending(ALL_SOURCES)).toHaveLength(2);
  });

  it('does not let a dismissal on one source hide the other', async () => {
    await repo.recordBeacon(SRC_A, NODE, offer(), 1_000);
    await repo.recordBeacon(SRC_B, NODE, offer(), 1_000);

    await repo.dismiss(SRC_A, NODE, 2_000);

    expect(await repo.listPending(SRC_A)).toHaveLength(0);
    expect(await repo.listPending(SRC_B)).toHaveLength(1);
  });

  it('restores a dismissed offer on request', async () => {
    await repo.recordBeacon(SRC_A, NODE, offer(), 1_000);
    await repo.dismiss(SRC_A, NODE, 2_000);
    expect(await repo.restore(SRC_A, NODE)).toBe(1);
    expect(await repo.listPending(SRC_A)).toHaveLength(1);
  });

  it('drops only the named source when a source is deleted', async () => {
    await repo.recordBeacon(SRC_A, NODE, offer(), 1_000);
    await repo.recordBeacon(SRC_B, NODE, offer(), 1_000);

    expect(await repo.deleteForSource(SRC_A)).toBe(1);
    expect(await repo.listAll(SRC_A)).toHaveLength(0);
    expect(await repo.listAll(SRC_B)).toHaveLength(1);
  });
});
