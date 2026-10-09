/**
 * POST /api/settings — `autoAckMaxResponses` (Auto-Acknowledge "Maximum
 * number of responses"): whole numbers 0-10 only, stored per source.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('POST /api/settings — autoAckMaxResponses', () => {
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

  it.each(['0', '2', '10'])('accepts %s and stores it on that source only', async (value) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ autoAckMaxResponses: value });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'autoAckMaxResponses')).toBe(value);
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'autoAckMaxResponses')).toBeNull();
  });

  it('keeps a different value per source', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ autoAckMaxResponses: '1' });
    await agent.post(`/api/settings?sourceId=${harness.sourceB}`).send({ autoAckMaxResponses: '7' });

    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'autoAckMaxResponses')).toBe('1');
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'autoAckMaxResponses')).toBe('7');
  });

  it.each(['-1', '11', '2.5', 'abc', '', '1e1', ' '])(
    'rejects %j with 400 INVALID_AUTO_ACK_MAX_RESPONSES and writes nothing',
    async (value) => {
      const agent = await harness.loginAs(harness.admin);
      await harness.db.settings.setSourceSettings(harness.sourceA, { autoAckMaxResponses: '2' });

      const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ autoAckMaxResponses: value });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AUTO_ACK_MAX_RESPONSES');
      expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'autoAckMaxResponses')).toBe('2');
    },
  );
});
