/**
 * MeshCore Auto-Acknowledge "split long messages" setting (#5564) — real
 * session + real permission checks via the route harness, and per-source
 * isolation of the stored value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import automationRoutes from './meshcoreAutomationRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

const KEY = 'meshcoreAutoAckSplitLongMessages';
const url = (sourceId: string) => `/api/sources/${sourceId}/meshcore/automation/autoack`;

describe('meshcoreAutomationRoutes — auto-ack splitLongMessages (#5564)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources/:id/meshcore', automationRoutes),
    });
  });

  afterEach(async () => {
    // The in-memory DB outlives each test and the harness reuses its source
    // ids, so drop the per-source settings this test wrote.
    await databaseService.settings.deleteSourceSettings(harness.sourceA);
    await databaseService.settings.deleteSourceSettings(harness.sourceB);
    await harness.cleanup();
  });

  /**
   * Read AND write on one source. `harness.grant` writes one row per action,
   * and the table holds one row per (user, resource, source), so a combined
   * grant goes in as a single row.
   */
  const grantReadWrite = (sourceId: string) =>
    databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource: 'automation',
      canRead: true,
      canWrite: true,
      canViewOnMap: false,
      sourceId,
      grantedAt: Date.now(),
      grantedBy: null,
    });

  it('defaults to off when the key was never saved', async () => {
    await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.splitLongMessages).toBe(false);
  });

  it('saves and reads back the toggle, on the granted source only', async () => {
    await grantReadWrite(harness.sourceA);
    await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    const saved = await agent.post(url(harness.sourceA)).send({ splitLongMessages: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ success: true });

    expect((await agent.get(url(harness.sourceA))).body.data.splitLongMessages).toBe(true);
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, KEY)).toBe('true');

    // Per-source: the other source stays off.
    expect((await agent.get(url(harness.sourceB))).body.data.splitLongMessages).toBe(false);

    const off = await agent.post(url(harness.sourceA)).send({ splitLongMessages: false });
    expect(off.status).toBe(200);
    expect((await agent.get(url(harness.sourceA))).body.data.splitLongMessages).toBe(false);
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, KEY)).toBe('false');
  });

  it('only a real boolean true turns splitting on', async () => {
    await grantReadWrite(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    for (const value of ['true', 'false', 1, 'yes', null]) {
      const res = await agent.post(url(harness.sourceA)).send({ splitLongMessages: value });
      expect(res.status).toBe(200);
      expect((await agent.get(url(harness.sourceA))).body.data.splitLongMessages).toBe(false);
    }
  });

  it('leaves the toggle alone when a save omits it', async () => {
    await grantReadWrite(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    await agent.post(url(harness.sourceA)).send({ splitLongMessages: true });
    await agent.post(url(harness.sourceA)).send({ cooldownSeconds: 30 });
    const body = (await agent.get(url(harness.sourceA))).body.data;
    expect(body.splitLongMessages).toBe(true);
    expect(body.cooldownSeconds).toBe(30);
  });

  it('automation:read alone cannot change it', async () => {
    await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const denied = await agent.post(url(harness.sourceA)).send({ splitLongMessages: true });
    expect(denied.status).toBe(403);
    expect((await agent.get(url(harness.sourceA))).body.data.splitLongMessages).toBe(false);
  });

  it('automation:write on one source cannot change another', async () => {
    await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(url(harness.sourceB)).send({ splitLongMessages: true })).status).toBe(403);
    expect(await databaseService.settings.getSettingForSource(harness.sourceB, KEY)).toBeNull();
  });

  it('rejects an anonymous save', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.post(url(harness.sourceA)).send({ splitLongMessages: true });
    expect([401, 403]).toContain(res.status);
  });

  it('answers an unsafe regex with the fail() envelope', async () => {
    await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ regex: '(' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_REGEX' });
    expect(res.body.error).toMatch(/Invalid regex pattern/);
  });
});
