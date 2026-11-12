/**
 * A Meshtastic timer that splits long messages must fire at most every 5
 * minutes (#6330, the same floor as MeshCore #6316). The settings route
 * refuses a faster cron, and the split announce flag saves per source.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const timer = {
  id: 'tt-1',
  name: 'Weather',
  cronExpression: '*/10 * * * *',
  responseType: 'text',
  response: 'hello',
  channels: [0],
  enabled: true,
};

describe('Meshtastic split timer floor and announce split setting (#6330)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/settings', settingsRoutes) });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSetting('timerTriggers').catch(() => {});
    await harness.cleanup();
  });

  async function post(body: Record<string, unknown>) {
    const agent = await harness.loginAs(harness.admin);
    return agent.post(`/api/settings?sourceId=${encodeURIComponent(harness.sourceA)}`).send({ ...body, sourceId: harness.sourceA });
  }

  it('refuses a split timer whose cron fires faster than every 5 minutes', async () => {
    const res = await post({ timerTriggers: JSON.stringify([{ ...timer, cronExpression: '*/2 * * * *', multiline: true }]) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SPLIT_TIMER_INTERVAL_TOO_SHORT');
  });

  it('saves a split timer at 5 minutes or slower, and a fast timer with split off', async () => {
    const ok = await post({ timerTriggers: JSON.stringify([
      { ...timer, multiline: true },
      { ...timer, id: 'tt-2', cronExpression: '* * * * *' },
    ]) });
    expect(ok.status).toBe(200);
    const stored = JSON.parse((await harness.db.settings.getSettingForSource(harness.sourceA, 'timerTriggers'))!);
    expect(stored[0].multiline).toBe(true);
  });

  it('saves autoAnnounceSplitLongMessages per source', async () => {
    const res = await post({ autoAnnounceSplitLongMessages: 'true' });
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'autoAnnounceSplitLongMessages')).toBe('true');
  });

  it('refuses meshcoreTimerTriggers with a timer over 4 channels (4.17.3 review M5)', async () => {
    const res = await post({ meshcoreTimerTriggers: JSON.stringify([
      { id: 'mc', name: 'x', enabled: true, scheduleType: 'interval', intervalMinutes: 60, responseType: 'text', response: 'hi', destination: 'channel', channelIndexes: [0, 1, 2, 3, 4] },
    ]) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TIMER_TOO_MANY_CHANNELS');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreTimerTriggers')).toBeNull();
  });
});
