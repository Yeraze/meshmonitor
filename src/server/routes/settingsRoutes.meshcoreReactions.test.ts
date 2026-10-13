/**
 * POST /api/settings — MeshCore reaction settings (#5759 / #5764).
 *
 * `meshcoreReactionsInboundEnabled` is per source. `meshcoreReactionsAckOnReceive`
 * is global-only: sent with a `sourceId` it is dropped, never stored per source.
 * Real-middleware harness per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('POST /api/settings — MeshCore reaction settings (#5759)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.db.settings.deleteSetting('meshcoreReactionsAckOnReceive').catch(() => {});
    await harness.db.settings.deleteSetting('meshcoreReactionsInboundEnabled').catch(() => {});
    await harness.db.settings.deleteSetting('meshcoreReactionsOutboundEnabled').catch(() => {});
    await harness.cleanup();
  });

  it('stores the inbound key for source A only', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ meshcoreReactionsInboundEnabled: 'false' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreReactionsInboundEnabled')).toBe('false');
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'meshcoreReactionsInboundEnabled')).toBeNull();
    expect(await harness.db.settings.getSetting('meshcoreReactionsInboundEnabled')).toBeNull();
  });

  it('stores the outbound key for source A only', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ meshcoreReactionsOutboundEnabled: 'false' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreReactionsOutboundEnabled')).toBe('false');
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'meshcoreReactionsOutboundEnabled')).toBeNull();
    expect(await harness.db.settings.getSetting('meshcoreReactionsOutboundEnabled')).toBeNull();
  });

  it('drops the global-only ack key when it is sent with a sourceId', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ meshcoreReactionsAckOnReceive: 'true', meshcoreReactionsInboundEnabled: 'true' })
      .expect(200);

    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreReactionsAckOnReceive')).toBeNull();
    expect(await harness.db.settings.getSetting('meshcoreReactionsAckOnReceive')).toBeNull();
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreReactionsInboundEnabled')).toBe('true');
  });

  it('stores the ack key globally on POST /api/settings', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({ meshcoreReactionsAckOnReceive: 'true' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('meshcoreReactionsAckOnReceive')).toBe('true');
    expect(await harness.db.settings.getSettingAsBoolean('meshcoreReactionsAckOnReceive', false)).toBe(true);
  });
});
