/**
 * POST /api/settings — `walkaboutSnrBands` (#6571): per-source SNR band edges
 * for the walkabout hex map, "strong,medium,weak" dB, validated on save.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const KEY = 'walkaboutSnrBands';

describe('POST /api/settings — walkabout SNR bands', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('stores normalized edges on that source only and reads them back', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ [KEY]: ' -10 , -15.5, -20 ' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, KEY)).toBe('-10,-15.5,-20');
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, KEY)).toBeNull();

    const get = await agent.get(`/api/settings?sourceId=${harness.sourceA}`);
    expect(get.body[KEY]).toBe('-10,-15.5,-20');
  });

  it('a blank value resets to defaults', async () => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, { [KEY]: '-10,-15,-20' });

    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ [KEY]: '' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, KEY)).toBe('');
  });

  it.each([
    ['0,0,-10', 'not_descending'],
    ['-10,-5,-20', 'not_descending'],
    ['21,0,-5', 'out_of_range'],
    ['0,-5,-31', 'out_of_range'],
    ['0,-5', 'not_number'],
    ['a,b,c', 'not_number'],
    ['0,-5,-10,-15', 'not_number'],
  ])('rejects %j (%s) and writes nothing', async (value, reason) => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, { [KEY]: '-1,-2,-3' });

    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ [KEY]: value });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WALKABOUT_SNR_BANDS');
    expect(res.body.reason).toBe(reason);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, KEY)).toBe('-1,-2,-3');
  });

  it('needs settings:write on the source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ [KEY]: '-10,-15,-20' });

    expect(res.status).toBe(403);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, KEY)).toBeNull();
  });
});
