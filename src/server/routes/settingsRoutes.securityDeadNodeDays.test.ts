/** P7a (#6254): `securityDeadNodeDays` is saved per source and validated 1-365. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('securityDeadNodeDays on save', () => {
  let harness: RouteTestHarness;
  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/settings', settingsRoutes) });
  });
  afterEach(() => harness.cleanup());

  async function save(value: unknown) {
    const agent = await harness.loginAs(harness.admin);
    return agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ securityDeadNodeDays: value });
  }

  it('saves an in-range value for the source only', async () => {
    const res = await save('30');
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'securityDeadNodeDays')).toBe('30');
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'securityDeadNodeDays')).toBeNull();
  });

  it('accepts the bounds 1 and 365', async () => {
    expect((await save('1')).status).toBe(200);
    expect((await save('365')).status).toBe(200);
  });

  it.each(['0', '366', '-3', '1.5', 'abc', ''])('rejects %j', async (v) => {
    const res = await save(v);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SECURITY_DEAD_NODE_DAYS');
  });
});
