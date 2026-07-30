/**
 * POST /api/sources — 'settings' grant reconciliation for newly created
 * sources (WP7, #4416 / EPIC_FOLLOWUP_FIXES_SPEC.md §5).
 *
 * Background: migration 132 fanned out every user's effective `settings`
 * grant onto every source that existed AT MIGRATION TIME, then deleted the
 * now-inert `sourceId IS NULL` rows — except when zero sources existed at
 * migration time, in which case it deliberately left the NULL rows in place
 * (see `132_fan_out_settings_permissions.ts`). Either way, a source created
 * *afterwards* got no `settings` row, so a non-admin who held one silently
 * lost settings access on it until an admin re-granted it manually.
 *
 * `sourceRoutes.ts`'s `POST /` handler now calls
 * `databaseService.auth.fanOutGlobalGrantsToSource('settings', source.id)`
 * immediately after `createSource` and before the manager-start block, to
 * close that gap the moment a new source appears. That method (in
 * `src/db/repositories/auth.ts`) does zero new computation — it reuses
 * `computeEffectiveGrants` / `computeFanOutInserts` / `pairKey` from
 * `src/server/services/settingsGrantFanout.ts` verbatim, the same pure
 * module migration 132 uses, scoped to the single new source.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md — see
 * routeTestApp.ts and sourceRoutes.permissions.test.ts (the canonical
 * template this file follows).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

// Non-DB mocks: sourceRoutes.ts starts a real manager for an
// enabled meshtastic_tcp source unless autoConnect:false is set in config
// (which every test below sets). These mocks are belt-and-suspenders so a
// future change to that gate can't make this file open real TCP sockets.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    addManager: vi.fn().mockResolvedValue(undefined),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

describe('POST /api/sources — settings grant reconciliation (WP7, #4416)', () => {
  let harness: RouteTestHarness;
  const createdSourceIds: string[] = [];

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });
    // POST / uses requirePermission('sources', 'write') with no
    // sourceIdFrom option — a global permission check.
    await harness.grant(harness.limited.id, 'sources', 'write');
    createdSourceIds.length = 0;
  });

  afterEach(async () => {
    for (const id of createdSourceIds) {
      await databaseService.sources.deleteSource(id).catch(() => {});
    }
    await databaseService.auth.deletePermissionsForUser(harness.limited.id).catch(() => {});
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  it('fans out a surviving NULL settings grant onto a newly created source and removes the NULL row', async () => {
    // Simulate migration 132's "zero sources at migration time" leftover: a
    // NULL-scoped settings grant that predates every source in this test DB.
    await databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource: 'settings',
      canRead: true,
      canWrite: true,
      canViewOnMap: false,
      sourceId: null,
      grantedAt: Date.now(),
      grantedBy: null,
    });

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/').send({
      name: 'WP7 Fan-out Source',
      type: 'meshtastic_tcp',
      config: { host: '10.99.0.1', port: 4403, autoConnect: false },
    });
    expect(res.status).toBe(201);
    createdSourceIds.push(res.body.id);

    // The user now has settings:write on the newly created source...
    expect(
      await databaseService.checkPermissionAsync(harness.limited.id, 'settings', 'write', res.body.id)
    ).toBe(true);

    // ...and the NULL-scoped row is gone (reconciled away, not merely widened).
    const rows = await databaseService.auth.getPermissionsForUser(harness.limited.id);
    const nullSettingsRows = rows.filter((r) => r.resource === 'settings' && r.sourceId == null);
    expect(nullSettingsRows).toHaveLength(0);
  });

  it('creates zero permission rows when no NULL settings rows exist (the overwhelmingly common path)', async () => {
    const before = (await databaseService.auth.getPermissionsForUser(harness.limited.id)).filter(
      (r) => r.resource === 'settings'
    );
    expect(before).toHaveLength(0);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/').send({
      name: 'WP7 No-op Source',
      type: 'meshtastic_tcp',
      config: { host: '10.99.0.2', port: 4403, autoConnect: false },
    });
    expect(res.status).toBe(201);
    createdSourceIds.push(res.body.id);

    const after = (await databaseService.auth.getPermissionsForUser(harness.limited.id)).filter(
      (r) => r.resource === 'settings'
    );
    expect(after).toHaveLength(0);
  });

  it('a throwing fan-out does not fail source creation', async () => {
    const spy = vi
      .spyOn(databaseService.auth, 'fanOutGlobalGrantsToSource')
      .mockRejectedValueOnce(new Error('boom'));

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/').send({
      name: 'WP7 Throwing Source',
      type: 'meshtastic_tcp',
      config: { host: '10.99.0.3', port: 4403, autoConnect: false },
    });
    expect(res.status).toBe(201);
    createdSourceIds.push(res.body.id);
    expect(spy).toHaveBeenCalledWith('settings', res.body.id);
  });

  it('reconciling the same source twice inserts nothing the second time (simulated concurrent-create race)', async () => {
    // §5.2 point 5: two sources created concurrently could both read the same
    // NULL row before either deletes it. This simulates the narrower, exact
    // race — two reconciliation calls for the SAME target source — which is
    // where a duplicate-row bug would actually show up.
    // computeFanOutInserts's existingPairs skip (settingsGrantFanout.ts) must
    // make the second call a genuine no-op, not a duplicate row or a
    // duplicate-key error.
    await databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource: 'settings',
      canRead: true,
      canWrite: true,
      canViewOnMap: false,
      sourceId: null,
      grantedAt: Date.now(),
      grantedBy: null,
    });

    const count1 = await databaseService.auth.fanOutGlobalGrantsToSource('settings', harness.sourceA);
    expect(count1).toBe(1);

    const count2 = await databaseService.auth.fanOutGlobalGrantsToSource('settings', harness.sourceA);
    expect(count2).toBe(0);

    const rows = (await databaseService.auth.getPermissionsForUser(harness.limited.id)).filter(
      (r) => r.resource === 'settings'
    );
    expect(rows).toHaveLength(1);
  });

  it('double-create idempotency: the second of two sequential source creations finds no leftover NULL row to reconcile', async () => {
    await databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource: 'settings',
      canRead: true,
      canWrite: true,
      canViewOnMap: false,
      sourceId: null,
      grantedAt: Date.now(),
      grantedBy: null,
    });

    const agent = await harness.loginAs(harness.limited);

    const res1 = await agent.post('/').send({
      name: 'WP7 Idempotency Source 1',
      type: 'meshtastic_tcp',
      config: { host: '10.99.0.4', port: 4403, autoConnect: false },
    });
    expect(res1.status).toBe(201);
    createdSourceIds.push(res1.body.id);

    // First creation consumed and deleted the leftover NULL row.
    expect(
      await databaseService.checkPermissionAsync(harness.limited.id, 'settings', 'write', res1.body.id)
    ).toBe(true);
    const nullRowsAfterFirst = (
      await databaseService.auth.getPermissionsForUser(harness.limited.id)
    ).filter((r) => r.resource === 'settings' && r.sourceId == null);
    expect(nullRowsAfterFirst).toHaveLength(0);

    const res2 = await agent.post('/').send({
      name: 'WP7 Idempotency Source 2',
      type: 'meshtastic_tcp',
      config: { host: '10.99.0.5', port: 4403, autoConnect: false },
    });
    expect(res2.status).toBe(201);
    createdSourceIds.push(res2.body.id);

    // Source 2's reconciliation has no leftover NULL row left to consume — it
    // was already deleted by source 1's creation, so this call is a no-op on
    // the very gap WP7 exists to close. NOTE (by design, not a bug — see
    // computeEffectiveGrants's OR-across-scopes contract in
    // settingsGrantFanout.ts and migration 132's docstring, which this method
    // deliberately reuses verbatim): the grant fanned onto source 1 is itself
    // one of "the user's settings rows for this resource" the next call reads,
    // so it is OR'd in and extended onto source 2 too — the same effective
    // grant a single migration-132-style pass would have produced had both
    // sources existed together from the start. No stray NULL row survives
    // either way.
    expect(
      await databaseService.checkPermissionAsync(harness.limited.id, 'settings', 'write', res2.body.id)
    ).toBe(true);

    const rows = (await databaseService.auth.getPermissionsForUser(harness.limited.id)).filter(
      (r) => r.resource === 'settings'
    );
    expect(rows).toHaveLength(2); // one row per source, no NULL row left behind
  });
});
