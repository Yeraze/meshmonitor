/**
 * Saving geofence triggers clamps `whileInsideIntervalMinutes` to 1–1440
 * instead of rejecting it. Above ~35,791 minutes the scheduler's setInterval
 * delay overflows to 1 ms; the manager clamps again when it arms the timer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

function trigger(whileInsideIntervalMinutes: unknown) {
  return {
    id: 'geo-1',
    name: 'Zone',
    enabled: true,
    shape: { type: 'circle', center: { lat: 26, lng: -80 }, radiusKm: 1 },
    event: 'while_inside',
    whileInsideIntervalMinutes,
    nodeFilter: { type: 'all' },
    responseType: 'text',
    response: 'inside',
    channel: 'none',
  };
}

describe('geofence whileInsideIntervalMinutes on save', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/settings', settingsRoutes) });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSetting('geofenceTriggers').catch(() => {});
    await harness.cleanup();
  });

  async function save(value: unknown) {
    const agent = await harness.loginAs(harness.admin);
    return agent.post('/api/settings').send({ geofenceTriggers: JSON.stringify([trigger(value)]) });
  }

  async function stored(): Promise<number> {
    const raw = await harness.db.settings.getSetting('geofenceTriggers');
    return JSON.parse(raw as string)[0].whileInsideIntervalMinutes;
  }

  it('clamps 999999 to 1440 and saves', async () => {
    const res = await save(999999);
    expect(res.status).toBe(200);
    expect(await stored()).toBe(1440);
  });

  it('clamps 0 up to 1 instead of rejecting', async () => {
    const res = await save(0);
    expect(res.status).toBe(200);
    expect(await stored()).toBe(1);
  });

  it('keeps an in-range value', async () => {
    const res = await save(15);
    expect(res.status).toBe(200);
    expect(await stored()).toBe(15);
  });

  it('still rejects a non-number', async () => {
    const res = await save('lots');
    expect(res.status).toBe(400);
  });
});
