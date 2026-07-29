/**
 * Auto-Acknowledge → Automation converter route tests (#4340 Phase 4, WP3).
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md — no
 * `vi.mock('../../services/database.js')` monkey-patching. See
 * src/server/test-helpers/routeTestApp.ts and sourceRoutes.permissions.test.ts
 * (the canonical template this file follows).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import autoAckConverterRoutes from './autoAckConverterRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

/** Enables exactly one Auto-Acknowledge cell (Direct · 0 hops · reply) for `sourceId`,
 *  which is enough for buildAutoAckAutomations() to produce a single 'direct' automation
 *  without needing any channel-allowlist setup. */
async function enableOneCell(harness: RouteTestHarness, sourceId: string): Promise<void> {
  await harness.db.settings.setSourceSetting(sourceId, 'autoAckDirectZeroHopReplyEnabled', 'true');
  await harness.db.settings.setSourceSetting(sourceId, 'autoAckDirectZeroHopTapbackEnabled', 'false');
  await harness.db.settings.setSourceSetting(sourceId, 'autoAckDirectZeroHopReplyDmEnabled', 'true');
}

describe('autoAckConverterRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/automations/convert', autoAckConverterRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
    await harness.db.sources.deleteSource('rt-source-meshcore').catch(() => {});
  });

  // ── envelope + permission gates: preview ──────────────────────────────────

  describe('POST /preview permissions', () => {
    // NOTE: these 403s are emitted by requirePermission() itself (authMiddleware.ts),
    // not by this route's own handler, so they carry the middleware's own
    // { error, code: 'FORBIDDEN' } shape rather than fail()'s envelope — the
    // handler never runs. Envelope-shape assertions below target branches this
    // route's own code produces (SOURCE_NOT_FOUND, SOURCE_NOT_MESHTASTIC,
    // SETTINGS_WRITE_REQUIRED, AUTOACK_ALREADY_CONVERTED, and 200 success).
    it('403 when automations:read is missing (automation:read present)', async () => {
      await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/automations/convert/preview').send({ sourceId: harness.sourceA });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('403 when automation:read is missing (automations:read present)', async () => {
      await harness.grant(harness.limited.id, 'automations', 'read');
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/automations/convert/preview').send({ sourceId: harness.sourceA });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('403 when automation:read is granted on a DIFFERENT source', async () => {
      await harness.grant(harness.limited.id, 'automations', 'read');
      await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/automations/convert/preview').send({ sourceId: harness.sourceA });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('200 + success envelope when both grants are present on the same source', async () => {
      await harness.grant(harness.limited.id, 'automations', 'read');
      await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/automations/convert/preview').send({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sourceId).toBe(harness.sourceA);
    });

    it('admin bypasses both grants', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/api/automations/convert/preview').send({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── envelope + permission gates: create ────────────────────────────────────

  describe('POST /create permissions', () => {
    it('403 when automations:write is missing (automation:write present)', async () => {
      await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post('/api/automations/convert/create')
        .send({ sourceId: harness.sourceA, disableAutoAck: false });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('403 when automation:write is missing (automations:write present)', async () => {
      await harness.grant(harness.limited.id, 'automations', 'write');
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post('/api/automations/convert/create')
        .send({ sourceId: harness.sourceA, disableAutoAck: false });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('403 when automation:write is granted on a DIFFERENT source', async () => {
      await harness.grant(harness.limited.id, 'automations', 'write');
      await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post('/api/automations/convert/create')
        .send({ sourceId: harness.sourceA, disableAutoAck: false });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  // ── preview writes nothing ──────────────────────────────────────────────────

  it('preview writes nothing: listAutomations() and autoAckEnabled unchanged', async () => {
    await enableOneCell(harness, harness.sourceA);
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckEnabled', 'true');

    const before = await harness.db.automations.listAutomations();
    const beforeSetting = await harness.db.settings.getSettingForSource(harness.sourceA, 'autoAckEnabled');

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/automations/convert/preview').send({ sourceId: harness.sourceA });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.automations.length).toBe(1);
    expect(res.body.data.automations[0].key).toBe('direct');
    expect(res.body.data.blocking).toBeNull();

    const after = await harness.db.automations.listAutomations();
    const afterSetting = await harness.db.settings.getSettingForSource(harness.sourceA, 'autoAckEnabled');
    expect(after.length).toBe(before.length);
    expect(after.map((a) => a.id).sort()).toEqual(before.map((a) => a.id).sort());
    expect(afterSetting).toBe(beforeSetting);
  });

  // ── 400 SOURCE_NOT_MESHTASTIC ────────────────────────────────────────────────

  it('400 SOURCE_NOT_MESHTASTIC for a MeshCore source (preview)', async () => {
    await harness.db.sources.createSource({
      id: 'rt-source-meshcore',
      name: 'MC Source',
      type: 'meshcore',
      config: {},
      enabled: true,
    });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/api/automations/convert/preview')
      .send({ sourceId: 'rt-source-meshcore' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
  });

  it('400 SOURCE_NOT_MESHTASTIC for a MeshCore source (create)', async () => {
    await harness.db.sources.createSource({
      id: 'rt-source-meshcore',
      name: 'MC Source',
      type: 'meshcore',
      config: {},
      enabled: true,
    });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/api/automations/convert/create')
      .send({ sourceId: 'rt-source-meshcore', disableAutoAck: false });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
  });

  it('404 SOURCE_NOT_FOUND for an unknown source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/api/automations/convert/preview')
      .send({ sourceId: 'does-not-exist' });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('SOURCE_NOT_FOUND');
  });

  // ── disableAutoAck without settings:write ────────────────────────────────────

  it('disableAutoAck: true without settings:write → 403 and no automation row created', async () => {
    await enableOneCell(harness, harness.sourceA);
    // Grant BOTH automations:write and automation:write (so the route's normal
    // permission gate passes) but withhold settings:write.
    await harness.grant(harness.limited.id, 'automations', 'write');
    await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);

    const before = await harness.db.automations.listAutomations();

    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .post('/api/automations/convert/create')
      .send({ sourceId: harness.sourceA, disableAutoAck: true });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('SETTINGS_WRITE_REQUIRED');

    const after = await harness.db.automations.listAutomations();
    expect(after.length).toBe(before.length);
  });

  it('disableAutoAck: true WITH settings:write succeeds and disables only autoAckEnabled', async () => {
    await enableOneCell(harness, harness.sourceA);
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckEnabled', 'true');
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckRegex', 'custom-regex');

    await harness.grant(harness.limited.id, 'automations', 'write');
    await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
    await harness.grant(harness.limited.id, 'settings', 'write');

    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .post('/api/automations/convert/create')
      .send({ sourceId: harness.sourceA, disableAutoAck: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.autoAckDisabled).toBe(true);
    expect(res.body.data.created.length).toBe(1);

    const enabledAfter = await harness.db.settings.getSettingForSource(harness.sourceA, 'autoAckEnabled');
    const regexAfter = await harness.db.settings.getSettingForSource(harness.sourceA, 'autoAckRegex');
    expect(enabledAfter).toBe('false');
    // Only autoAckEnabled is touched — every other setting survives untouched.
    expect(regexAfter).toBe('custom-regex');

    // Clean up the created automation so later tests in this file start fresh.
    for (const a of res.body.data.created as Array<{ id: string }>) {
      await harness.db.automations.deleteAutomation(a.id);
    }
  });

  // ── 409 AUTOACK_ALREADY_CONVERTED + replaceExisting ─────────────────────────

  describe('re-conversion', () => {
    beforeEach(async () => {
      await enableOneCell(harness, harness.sourceA);
    });

    it('first create succeeds; second without replaceExisting → 409; replaceExisting updates in place', async () => {
      const agent = await harness.loginAs(harness.admin);

      const first = await agent
        .post('/api/automations/convert/create')
        .send({ sourceId: harness.sourceA, disableAutoAck: false });
      expect(first.status).toBe(200);
      expect(first.body.success).toBe(true);
      expect(first.body.data.created.length).toBe(1);
      const createdId = first.body.data.created[0].id;

      const second = await agent
        .post('/api/automations/convert/create')
        .send({ sourceId: harness.sourceA, disableAutoAck: false });
      expect(second.status).toBe(409);
      expect(second.body.success).toBe(false);
      expect(second.body.code).toBe('AUTOACK_ALREADY_CONVERTED');
      expect(second.body.existing.length).toBe(1);
      expect(second.body.existing[0].id).toBe(createdId);

      const third = await agent
        .post('/api/automations/convert/create')
        .send({ sourceId: harness.sourceA, disableAutoAck: false, replaceExisting: true });
      expect(third.status).toBe(200);
      expect(third.body.success).toBe(true);
      expect(third.body.data.created.length).toBe(0);
      expect(third.body.data.updated.length).toBe(1);
      expect(third.body.data.updated[0].id).toBe(createdId);
      expect(third.body.data.deleted.length).toBe(0);

      // Still exactly one automation row for this source's conversion.
      const all = await harness.db.automations.listAutomations();
      expect(all.filter((a) => a.id === createdId).length).toBe(1);

      await harness.db.automations.deleteAutomation(createdId);
    });
  });
});
