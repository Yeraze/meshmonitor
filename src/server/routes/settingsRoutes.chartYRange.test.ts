/**
 * POST /api/settings — `dashboardChartYRange` (#6348): per-widget fixed Y-axis
 * bounds, stored per source, normalized on save.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('POST /api/settings — dashboard chart Y-axis range', () => {
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

  it('stores the ranges on that source only and reads them back', async () => {
    const agent = await harness.loginAs(harness.admin);
    const ranges = { '!abcd1234-voltage': { min: 3, max: 4.2 }, '!abcd1234-temperature': { max: 40 } };
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ dashboardChartYRange: JSON.stringify(ranges) });

    expect(res.status).toBe(200);
    const stored = await harness.db.settings.getSettingForSource(harness.sourceA, 'dashboardChartYRange');
    expect(JSON.parse(stored!)).toEqual(ranges);
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'dashboardChartYRange')).toBeNull();

    const get = await agent.get(`/api/settings?sourceId=${harness.sourceA}`);
    expect(JSON.parse(get.body.dashboardChartYRange)).toEqual(ranges);
  });

  it('drops inverted pairs and non-numeric bounds', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({
      dashboardChartYRange: JSON.stringify({
        good: { min: 1 },
        inverted: { min: 5, max: 5 },
        junk: { min: 'x', max: null },
        mixed: { min: 'nope', max: 9 },
      }),
    });

    expect(res.status).toBe(200);
    const stored = await harness.db.settings.getSettingForSource(harness.sourceA, 'dashboardChartYRange');
    expect(JSON.parse(stored!)).toEqual({ good: { min: 1 }, mixed: { max: 9 } });
  });

  it.each(['not json', '[1,2]', '42'])('rejects %j and writes nothing', async (value) => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, { dashboardChartYRange: '{"a":{"min":1}}' });

    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ dashboardChartYRange: value });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CHART_Y_RANGE');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'dashboardChartYRange')).toBe('{"a":{"min":1}}');
  });
});
