/**
 * POST /api/settings — likely-aircraft detection keys (#5364/#5365 Phase 1
 * WP2, spec §4.5 / §6). Covers the four POST-able keys' validation and the
 * post-write `reclassifySource` hook.
 *
 * The GET back-fill exclusion case (proving the three detection keys ride
 * along with `NODE_DISPLAY_SETTING_KEYS`) is added below by WP5 (test-only
 * edit to this WP2-owned file — spec §6/§8), now that
 * `NODE_DISPLAY_SETTING_KEYS` carries the three aircraft keys (§4.6).
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md — "New
 * or changed route tests MUST use the harness".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { reclassifySourceSpy } = vi.hoisted(() => ({ reclassifySourceSpy: vi.fn(async () => 0) }));
vi.mock('../services/aircraftClassificationService.js', () => ({
  aircraftClassificationService: {
    reclassifySource: reclassifySourceSpy,
  },
}));

import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('POST /api/settings — likely-aircraft detection (#5364/#5365 WP2)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
    reclassifySourceSpy.mockClear();
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('accepts valid detection keys → 200, stores them per source, and calls reclassifySource(sourceId)', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({
        aircraftDetectionEnabled: 'true',
        aircraftAglThresholdMeters: '600',
        aircraftMslThresholdMeters: '4000',
      });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftDetectionEnabled')).toBe('true');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAglThresholdMeters')).toBe('600');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftMslThresholdMeters')).toBe('4000');
    expect(reclassifySourceSpy).toHaveBeenCalledTimes(1);
    expect(reclassifySourceSpy).toHaveBeenCalledWith(harness.sourceA);
  });

  it('rejects an out-of-range AGL threshold (10) with 400 INVALID_AIRCRAFT_AGL_THRESHOLD and writes nothing', async () => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, { aircraftAglThresholdMeters: '500' });

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ aircraftAglThresholdMeters: '10' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AIRCRAFT_AGL_THRESHOLD');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAglThresholdMeters')).toBe('500');
    expect(reclassifySourceSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric MSL threshold ("x") with 400 INVALID_AIRCRAFT_MSL_THRESHOLD', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ aircraftMslThresholdMeters: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AIRCRAFT_MSL_THRESHOLD');
    expect(reclassifySourceSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['aircraftDetectionEnabled', 'yes'],
    ['autoFavoriteExcludeAircraft', 'yes'],
  ])('rejects %s="yes" with 400 INVALID_BOOLEAN_SETTING and writes nothing', async (key, value) => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, { [key]: 'true' });

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ [key]: value });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BOOLEAN_SETTING');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, key)).toBe('true');
    expect(reclassifySourceSpy).not.toHaveBeenCalled();
  });

  it('autoFavoriteExcludeAircraft alone does not trigger reclassifySource (the sweep reads it directly)', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ autoFavoriteExcludeAircraft: 'false' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'autoFavoriteExcludeAircraft')).toBe('false');
    expect(reclassifySourceSpy).not.toHaveBeenCalled();
  });

  it('drops autoFavoriteAircraftStrikes from the POST body (not in VALID_SETTINGS_KEYS) — stored value is unchanged', async () => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, {
      autoFavoriteAircraftStrikes: JSON.stringify({ '1': { count: 1, lastAt: 123 } }),
    });

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ autoFavoriteAircraftStrikes: '{}', aircraftAglThresholdMeters: '700' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'autoFavoriteAircraftStrikes'))
      .toBe(JSON.stringify({ '1': { count: 1, lastAt: 123 } }));
    // The rest of the payload still persists normally.
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAglThresholdMeters')).toBe('700');
  });

  it('a scoped save on source A does not change source B', async () => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceB, { aircraftAglThresholdMeters: '900' });

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ aircraftAglThresholdMeters: '1200' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'aircraftAglThresholdMeters')).toBe('1200');
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'aircraftAglThresholdMeters')).toBe('900');
    expect(reclassifySourceSpy).toHaveBeenCalledWith(harness.sourceA);
    expect(reclassifySourceSpy).not.toHaveBeenCalledWith(harness.sourceB);
  });
});

// #5364/#5365 Phase 1 WP5 (test-only addition to this WP2-owned file, spec
// §6/§8): GET back-fill exclusion, now that NODE_DISPLAY_SETTING_KEYS
// carries the three aircraft keys (§4.6).
describe('GET /api/settings — likely-aircraft keys are excluded from the global back-fill (#5364/#5365 WP5)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.cleanup();
  });

  it('a legacy global aircraftAglThresholdMeters row does not back-fill a source with no per-source row', async () => {
    const agent = await harness.loginAs(harness.admin);

    // Simulate a pre-existing un-namespaced global row (as if written before
    // this feature existed, or by hand) — the per-source row for sourceA is
    // never created.
    await harness.db.settings.setSetting('aircraftAglThresholdMeters', '900');

    const res = await agent.get(`/api/settings?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    // The NODE_DISPLAY_SETTING_KEYS exclusion (settingsRoutes.ts GET :286)
    // strips this key from the global back-fill entirely — the UI falls
    // through to parseAircraftSettings' hardcoded default (500) instead of
    // ever seeing the stale global 900.
    expect(res.body).not.toHaveProperty('aircraftAglThresholdMeters');
  });

  it('a per-source row is still returned normally alongside the exclusion', async () => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSetting('aircraftAglThresholdMeters', '900'); // stale global
    await harness.db.settings.setSourceSettings(harness.sourceA, { aircraftAglThresholdMeters: '700' });

    const res = await agent.get(`/api/settings?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    expect(res.body.aircraftAglThresholdMeters).toBe('700');
  });

  it('the same legacy global row is visible unscoped (mode="global" GET, no sourceId)', async () => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSetting('aircraftAglThresholdMeters', '900');

    const res = await agent.get('/api/settings');

    expect(res.status).toBe(200);
    // The unscoped branch (no sourceId) does not run the Node Display
    // exclusion at all — it is the same historical behaviour every other
    // global-only key gets, and it is what mode="global" SettingsTab reads.
    expect(res.body.aircraftAglThresholdMeters).toBe('900');
  });
});
