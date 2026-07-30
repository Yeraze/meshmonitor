/**
 * userRoutes — settings-is-sourcey coverage (#4416)
 *
 * PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §7 WP3. The pre-existing
 * `userRoutes.test.ts` cannot see this behavior at all (its DatabaseService
 * mock hardcodes `getUserPermissionSetsBySourceAsync` to always return
 * `bySource: {}` — see the audit note at the top of that file). This suite
 * uses the real harness (`createRouteTestApp()`) so it exercises the actual
 * `isSourceyResource()` split in `userRoutes.ts` and the real
 * `getUserPermissionSetsBySourceAsync` query against a live :memory: DB.
 *
 * See src/server/test-helpers/routeTestApp.ts for the harness design.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import userRoutes from './userRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('userRoutes — /:id/permissions (settings is sourcey, #4416)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', userRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('PUT with a settings grant and no sourceId → 400 MISSING_SOURCE_ID', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .put(`/${harness.limited.id}/permissions`)
      .send({ permissions: { settings: { read: true, write: true } } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'MISSING_SOURCE_ID' });
  });

  it('PUT with a settings grant AND sourceId → 200, row lands under bySource[sourceId]', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .put(`/${harness.limited.id}/permissions`)
      .send({
        permissions: { settings: { read: true, write: true } },
        sourceId: harness.sourceA,
      });

    expect(res.status).toBe(200);

    const { global, bySource } = await harness.db.getUserPermissionSetsBySourceAsync(harness.limited.id);
    expect(bySource[harness.sourceA]?.settings).toEqual({ viewOnMap: false, read: true, write: true });
    // Never lands as a global (sourceId IS NULL) row.
    expect(global.settings).toBeUndefined();
  });

  it('PUT of a purely global payload (themes) with no sourceId → still 200, unchanged', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .put(`/${harness.limited.id}/permissions`)
      .send({ permissions: { themes: { read: true, write: false } } });

    expect(res.status).toBe(200);

    const { global } = await harness.db.getUserPermissionSetsBySourceAsync(harness.limited.id);
    expect(global.themes).toEqual({ viewOnMap: false, read: true, write: false });
  });

  it('GET ?sourceId=A returns settings from bySource[A]; unscoped GET omits settings', async () => {
    const adminAgent = await harness.loginAs(harness.admin);
    await adminAgent
      .put(`/${harness.limited.id}/permissions`)
      .send({
        permissions: { settings: { read: true, write: false } },
        sourceId: harness.sourceA,
      })
      .expect(200);

    const scoped = await adminAgent
      .get(`/${harness.limited.id}/permissions`)
      .query({ sourceId: harness.sourceA });
    expect(scoped.status).toBe(200);
    expect(scoped.body.permissions.settings).toEqual({ viewOnMap: false, read: true, write: false });

    const unscoped = await adminAgent.get(`/${harness.limited.id}/permissions`);
    expect(unscoped.status).toBe(200);
    // This is the assertion that proves the §4.2 no-400 reasoning: UsersTab's
    // unscoped GET (used to seed the global-section form state) no longer
    // carries `settings`, so its save path never includes it in a payload
    // that lacks a sourceId — which is what would otherwise 400.
    expect(unscoped.body.permissions.settings).toBeUndefined();
  });

  it('regression pin (§4.3): PUT with sourceId=A omitting settings removes the sourceA settings row', async () => {
    // This is a known, pre-existing destructive-replace behavior (already
    // true for nodes/messages/channels before #4416) — not a bug being
    // introduced by the settings flip. Pinned here so it stays documented
    // rather than rediscovered as a surprise.
    const agent = await harness.loginAs(harness.admin);

    await agent
      .put(`/${harness.limited.id}/permissions`)
      .send({
        permissions: { settings: { read: true, write: true } },
        sourceId: harness.sourceA,
      })
      .expect(200);

    let { bySource } = await harness.db.getUserPermissionSetsBySourceAsync(harness.limited.id);
    expect(bySource[harness.sourceA]?.settings).toBeDefined();

    // Second PUT on the same source, payload no longer mentions `settings`.
    await agent
      .put(`/${harness.limited.id}/permissions`)
      .send({
        permissions: { nodes: { read: true, write: false } },
        sourceId: harness.sourceA,
      })
      .expect(200);

    ({ bySource } = await harness.db.getUserPermissionSetsBySourceAsync(harness.limited.id));
    expect(bySource[harness.sourceA]?.settings).toBeUndefined();
    expect(bySource[harness.sourceA]?.nodes).toEqual({ viewOnMap: false, read: true, write: false });
  });
});
