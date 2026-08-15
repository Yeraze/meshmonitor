/**
 * Beacon offer routes (#4723).
 *
 * `accept` writes a channel to a radio, so most of what is worth pinning here
 * is what the endpoint REFUSES to do. Uses the real route harness (real
 * express-session, real auth middleware, real SQL) so the permission
 * assertions exercise the actual gate rather than a re-implementation of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const setChannelConfig = vi.fn();

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: () => ({ setChannelConfig }),
}));

import beaconOfferRoutes from './beaconOfferRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const NODE = 0xaabbccdd;
const PSK = 'AQIDBAUGBwgJCgsMDQ4PEA==';

let harness: RouteTestHarness;

/** Seed one offer on sourceA. */
async function seedOffer(over: Record<string, unknown> = {}, sourceId = harness.sourceA) {
  await harness.db.meshBeaconOffers.recordBeacon(sourceId, NODE, {
    message: 'join us',
    offerChannelName: 'RegionMesh',
    offerChannelPsk: PSK,
    offerRegion: 1,
    offerPreset: 0,
    ...over,
  }, 1_000);
}

beforeEach(async () => {
  setChannelConfig.mockReset().mockResolvedValue(undefined);
  harness = await createRouteTestApp({
    mount: (app) => app.use('/api/sources/:id/beacon-offers', beaconOfferRoutes),
  });
});

afterEach(async () => {
  await harness.db.meshBeaconOffers.deleteForSource(harness.sourceA).catch(() => {});
  await harness.db.meshBeaconOffers.deleteForSource(harness.sourceB).catch(() => {});
  // The harness DB is a file-scoped singleton and deleting a source does not
  // cascade to its channels, so a slot written by one test is still occupied in
  // the next — which shows up as a spurious 409 rather than as a clear leak.
  for (const slot of [3, 4, 5]) {
    await harness.db.channels.deleteChannel(slot, harness.sourceA).catch(() => {});
  }
  await harness.cleanup();
});

const url = (path = '') => `/api/sources/${harness.sourceA}/beacon-offers${path}`;

describe('GET /api/sources/:id/beacon-offers', () => {
  it('never serializes the offered channel key', async () => {
    // The whole reason accept is server-side. A leak here would defeat it.
    await seedOffer();
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url());

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(PSK);
    expect(res.body.data[0].offerChannelPsk).toBeUndefined();
    expect(res.body.data[0].hasChannelKey).toBe(true);
  });

  it('reports hasChannelKey false for a name-only offer', async () => {
    await seedOffer({ offerChannelPsk: null });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url());
    expect(res.body.data[0].hasChannelKey).toBe(false);
  });

  it('hides dismissed offers unless asked for them', async () => {
    await seedOffer();
    await harness.db.meshBeaconOffers.dismiss(harness.sourceA, NODE, 2_000);
    const agent = await harness.loginAs(harness.admin);

    expect((await agent.get(url())).body.data).toHaveLength(0);
    expect((await agent.get(url('?includeDismissed=true'))).body.data).toHaveLength(1);
  });

  it('refuses a user without nodes:read on this source', async () => {
    await seedOffer();
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url())).status).toBe(403);
  });
});

describe('dismiss / restore', () => {
  it('round-trips a dismissal', async () => {
    await seedOffer();
    const agent = await harness.loginAs(harness.admin);

    expect((await agent.post(url(`/${NODE}/dismiss`))).status).toBe(200);
    expect((await harness.db.meshBeaconOffers.listPending(harness.sourceA))).toHaveLength(0);

    expect((await agent.post(url(`/${NODE}/restore`))).status).toBe(200);
    expect((await harness.db.meshBeaconOffers.listPending(harness.sourceA))).toHaveLength(1);
  });

  it('404s for a node that never beaconed here', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url('/12345/dismiss'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('BEACON_OFFER_NOT_FOUND');
  });

  it('refuses a user without nodes:write', async () => {
    await seedOffer();
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(url(`/${NODE}/dismiss`))).status).toBe(403);
  });
});

describe('POST accept', () => {
  const accept = (body: Record<string, unknown>) =>
    harness.loginAs(harness.admin).then((a) => a.post(url(`/${NODE}/accept`)).send(body));

  it('writes the offered channel — with its key — and dismisses the offer', async () => {
    await seedOffer();
    const res = await accept({ slot: 3, confirm: true });

    expect(res.status).toBe(200);
    expect(setChannelConfig).toHaveBeenCalledWith(3, expect.objectContaining({
      name: 'RegionMesh',
      psk: PSK,
      role: 2, // secondary — never becomes this node's primary network
    }));

    const stored = await harness.db.channels.getChannelById(3, harness.sourceA);
    expect(stored?.name).toBe('RegionMesh');

    // Acted on, so it must stop re-inviting the user to a channel they're on.
    expect(await harness.db.meshBeaconOffers.listPending(harness.sourceA)).toHaveLength(0);
  });

  it('requires explicit confirmation and touches nothing without it', async () => {
    // Server-side, not just a dialog: an API token or a replayed request must
    // not be able to write a channel as a bare one-click.
    await seedOffer();
    const res = await accept({ slot: 3 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(setChannelConfig).not.toHaveBeenCalled();
  });

  it('refuses a truthy-but-not-true confirmation', async () => {
    await seedOffer();
    const res = await accept({ slot: 3, confirm: 'yes' });
    expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(setChannelConfig).not.toHaveBeenCalled();
  });

  it('refuses slot 0 — accepting an invitation must not move the node off its primary', async () => {
    await seedOffer();
    const res = await accept({ slot: 0, confirm: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRIMARY_SLOT_PROTECTED');
    expect(setChannelConfig).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range slot', async () => {
    await seedOffer();
    expect((await accept({ slot: 8, confirm: true })).body.code).toBe('INVALID_CHANNEL_SLOT');
    expect((await accept({ slot: 2.5, confirm: true })).body.code).toBe('INVALID_CHANNEL_SLOT');
    expect(setChannelConfig).not.toHaveBeenCalled();
  });

  it('refuses a name-only offer rather than joining a channel that decrypts nothing', async () => {
    await seedOffer({ offerChannelPsk: null });
    const res = await accept({ slot: 3, confirm: true });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('OFFER_HAS_NO_KEY');
    expect(setChannelConfig).not.toHaveBeenCalled();
  });

  it('refuses an offer that advertises no channel at all', async () => {
    await seedOffer({ offerChannelName: null, offerChannelPsk: null });
    const res = await accept({ slot: 3, confirm: true });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('OFFER_HAS_NO_CHANNEL');
  });

  it('will not clobber a configured slot without a separate overwrite', async () => {
    // "I meant to accept" and "I meant to destroy channel 3" are two statements.
    await seedOffer();
    await harness.db.channels.upsertChannel(
      { id: 3, name: 'Existing', psk: 'AQ==', role: 2, uplinkEnabled: false, downlinkEnabled: false },
      harness.sourceA, { allowBlankName: true },
    );

    const blocked = await accept({ slot: 3, confirm: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CHANNEL_SLOT_IN_USE');
    expect(blocked.body.occupiedBy).toBe('Existing');
    expect(setChannelConfig).not.toHaveBeenCalled();

    const allowed = await accept({ slot: 3, confirm: true, overwrite: true });
    expect(allowed.status).toBe(200);
    expect(setChannelConfig).toHaveBeenCalled();
  });

  it('leaves the database untouched when the radio rejects the write', async () => {
    // Device first, DB second: the opposite order would leave the UI showing a
    // channel the node does not actually have.
    await seedOffer();
    setChannelConfig.mockRejectedValueOnce(new Error('radio offline'));

    const res = await accept({ slot: 4, confirm: true });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('CHANNEL_WRITE_FAILED');
    expect(await harness.db.channels.getChannelById(4, harness.sourceA)).toBeFalsy();
    // Still pending — the user can retry.
    expect(await harness.db.meshBeaconOffers.listPending(harness.sourceA)).toHaveLength(1);
  });

  it('requires write permission on the DESTINATION slot specifically', async () => {
    await seedOffer();
    await harness.grant(harness.limited.id, 'channel_3', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const wrongSlot = await agent.post(url(`/${NODE}/accept`)).send({ slot: 5, confirm: true });
    expect(wrongSlot.status).toBe(403);
    expect(setChannelConfig).not.toHaveBeenCalled();

    const rightSlot = await agent.post(url(`/${NODE}/accept`)).send({ slot: 3, confirm: true });
    expect(rightSlot.status).toBe(200);
  });

  it('404s for an offer that does not exist on this source', async () => {
    await seedOffer({}, harness.sourceB);
    const res = await accept({ slot: 3, confirm: true });
    expect(res.status).toBe(404);
    expect(setChannelConfig).not.toHaveBeenCalled();
  });
});
