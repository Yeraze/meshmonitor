/**
 * Coverage imports are per-source (#5891 P3): an import on A is invisible
 * through B's list and through a B-only reader's `/receptions`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import coverageImportRoutes from './coverageImportRoutes.js';
import coverageRoutes from './coverageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { csvOf, mtDto, uploadTo } from '../test-helpers/coverageImportFixtures.js';

describe('coverage imports are per-source (#5891 P3)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/sources/:id/coverage/imports', coverageImportRoutes);
        app.use('/api/analysis/coverage', coverageRoutes);
      },
    });
  });

  afterEach(async () => {
    for (const id of [harness.sourceA, harness.sourceB]) {
      await databaseService.coverageImports.deleteForSource(id).catch(() => {});
      await databaseService.coverageReceptions.deleteForSource(id).catch(() => {});
    }
    await harness.cleanup();
  });

  it('B sees nothing of an import on A', async () => {
    const admin = await harness.loginAs(harness.admin);
    const made = await uploadTo(admin, harness.sourceA, 'a.csv', csvOf([mtDto(0), mtDto(1)]));
    expect(made.status).toBe(201);

    const listB = await admin.get(`/api/sources/${harness.sourceB}/coverage/imports`);
    expect(listB.body.data.imports).toEqual([]);
    const listA = await admin.get(`/api/sources/${harness.sourceA}/coverage/imports`);
    expect(listA.body.data.imports).toHaveLength(1);

    await harness.db.auth.createPermission({
      userId: harness.limited.id, resource: 'nodes', canRead: true, canWrite: false, canViewOnMap: false,
      sourceId: harness.sourceB, grantedAt: Date.now(), grantedBy: null,
    });
    const reader = await harness.loginAs(harness.limited);
    const res = await reader.get('/api/analysis/coverage/receptions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    const recv = await reader.get('/api/analysis/coverage/receivers?since=0');
    expect(recv.body.data.receivers).toEqual([]);
    expect(await databaseService.coverageReceptions.countImportedRows(harness.sourceB)).toBe(0);
  });
});
