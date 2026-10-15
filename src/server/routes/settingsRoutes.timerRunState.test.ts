/**
 * Saving timer triggers keeps the scheduler's run state (#5827). The page
 * posts back the whole trigger list it loaded, so without this a save rolled
 * `lastRun` / `lastResult` / `lastError` back to the page's stale copy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const timer = {
  id: 'tt-1',
  name: 'Morning',
  cronExpression: '0 8 * * *',
  responseType: 'text',
  response: 'hello',
  channel: 0,
  enabled: true,
};

describe('timer trigger run state on save', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/settings', settingsRoutes) });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSetting('timerTriggers').catch(() => {});
    await harness.cleanup();
  });

  async function save(triggers: unknown[], sourceId?: string) {
    const agent = await harness.loginAs(harness.admin);
    const url = sourceId ? `/api/settings?sourceId=${encodeURIComponent(sourceId)}` : '/api/settings';
    return agent.post(url).send({ timerTriggers: JSON.stringify(triggers), ...(sourceId ? { sourceId } : {}) });
  }

  it('keeps the stored lastRun when a per-source save sends an older one', async () => {
    await harness.db.settings.setSourceSetting(harness.sourceA, 'timerTriggers', JSON.stringify([
      { ...timer, lastRun: 2000, lastResult: 'success' },
    ]));
    const res = await save([{ ...timer, name: 'Renamed', lastRun: 1000, lastResult: 'error', lastError: 'old' }], harness.sourceA);
    expect(res.status).toBe(200);
    const stored = JSON.parse((await harness.db.settings.getSettingForSource(harness.sourceA, 'timerTriggers'))!);
    expect(stored).toEqual([{ ...timer, name: 'Renamed', lastRun: 2000, lastResult: 'success' }]);
  });

  it('a new timer starts with no run state', async () => {
    const res = await save([{ ...timer, lastRun: 5, lastResult: 'success' }]);
    expect(res.status).toBe(200);
    const stored = JSON.parse((await harness.db.settings.getSetting('timerTriggers'))!);
    expect(stored[0].lastRun).toBeUndefined();
    expect(stored[0].lastResult).toBeUndefined();
  });
});
