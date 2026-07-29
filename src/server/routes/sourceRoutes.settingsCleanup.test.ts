/**
 * DELETE /api/sources/:id — settings namespace cleanup (#4412 Phase 1 WP3).
 *
 * Background: deleteSourceSettings(sourceId) existed at
 * src/db/repositories/settings.ts but was never called anywhere in
 * production code, so every `source:{id}:*` settings row outlived its
 * source forever. The route now best-effort purges that namespace via
 * databaseService.deleteSourceSettingsAsync immediately after the node
 * purge (#4137), following the same "cleanup failure must not fail the
 * delete" contract.
 *
 * Uses the real-middleware harness (createRouteTestApp) against the live
 * :memory: singleton DB — see src/server/test-helpers/routeTestApp.ts and
 * sourceRoutes.deleteCleanup.test.ts (the #4137 precedent this file mirrors).
 * deleteSourceSettingsAsync is NOT mocked for the happy-path test: it runs
 * for real so the assertion proves the actual purge, not a mocked call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

describe('DELETE /api/sources/:id — settings cleanup (#4412)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    // DELETE /:id uses requirePermission('sources', 'write') with no
    // sourceIdFrom option — a GLOBAL permission check.
    await harness.grant(harness.limited.id, 'sources', 'write');

    await databaseService.settings.setSourceSetting(harness.sourceA, 'maxNodeAgeHours', '48');
    await databaseService.settings.setSourceSetting(harness.sourceA, 'hideIncompleteNodes', '1');
    await databaseService.settings.setSourceSetting(harness.sourceB, 'maxNodeAgeHours', '12');
    await databaseService.settings.setSetting('maxNodeAgeHours', '24');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await databaseService.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await databaseService.settings.deleteSetting('maxNodeAgeHours').catch(() => {});
    await harness.cleanup();
  });

  it('purges the deleted source settings namespace, leaving a sibling source and the global row untouched', async () => {
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.delete(`/${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // sourceA's namespace is gone.
    expect(await databaseService.settings.getSourceSettings(harness.sourceA)).toEqual({});

    // sourceB's namespace survives — the purge must be scoped to the deleted source only.
    expect(await databaseService.settings.getSourceSettings(harness.sourceB)).toEqual({
      maxNodeAgeHours: '12',
    });

    // The un-namespaced global row survives.
    expect(await databaseService.settings.getSetting('maxNodeAgeHours')).toBe('24');
  });

  it('a 404 delete (unknown source) purges nothing', async () => {
    const spy = vi.spyOn(databaseService, 'deleteSourceSettingsAsync');
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.delete('/does-not-exist');
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();

    // sourceA's settings are unaffected by the failed delete attempt on a
    // different (nonexistent) id.
    expect(await databaseService.settings.getSourceSettings(harness.sourceA)).toEqual({
      maxNodeAgeHours: '48',
      hideIncompleteNodes: '1',
    });
  });

  it('a throwing settings purge does not fail the delete request', async () => {
    vi.spyOn(databaseService, 'deleteSourceSettingsAsync').mockRejectedValueOnce(new Error('boom'));
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.delete(`/${harness.sourceB}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
