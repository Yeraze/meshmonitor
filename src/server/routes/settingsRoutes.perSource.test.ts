/**
 * POST /api/settings — per-source permission scoping and isolation (#4412
 * Phase 1 WP2, spec §6.3; classification fixed by Phase 6 #4416).
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md
 * ("New or changed route tests MUST use the harness"). Exercises the real
 * `checkPermissionAsync` against real permission rows, rather than a
 * hand-rolled mock lambda that could pass while the real per-source scoping
 * (requirePermission('settings', 'write', { sourceIdFrom: 'query' })) is
 * broken — see src/server/test-helpers/routeTestApp.ts and
 * src/server/routes/sourceRoutes.permissions.test.ts (the canonical template).
 *
 * 'settings' is a sourcey resource (`src/types/permission.ts`'s
 * `SOURCEY_RESOURCES`, PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §2): a
 * settings:write grant scoped to one source authorizes writes on that source
 * only, never on a different source. See the test below for the exact-match
 * vs. union-branch behavior this produces.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import settingsRoutes, { setSettingsCallbacks } from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

describe('POST /api/settings — per-source permission scoping (#4412 WP2 §6.3)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.db.settings.deleteSetting('maxNodeAgeHours').catch(() => {});
    await harness.cleanup();
  });

  // 'settings' is a sourcey resource (src/types/permission.ts's
  // SOURCEY_RESOURCES, PHASE6 spec §2), so checkPermissionAsync takes the
  // exact-match branch when a sourceId is given: a grant scoped to sourceA
  // authorizes sourceA only, and is rejected on sourceB (403).
  //
  // The unscoped global write is different. settingsRoutes.ts:291 declares
  // `sourceIdFrom: 'query'`, so an unscoped POST has no scopedSourceId and
  // checkPermissionAsync takes the sourcey UNION branch instead — "holds
  // settings:write on at least one source" authorizes it, same as the other
  // 34 unscoped settings:write gates in the app (map styles, geojson layers,
  // scripts, system restart, ...), none of which have a single source to
  // name. This is the settled ruling in PHASE6 spec §11: 200 here is
  // deliberate, not a residual leak. §11's decisive point is that 403 would
  // create a state no admin can grant their way out of — migration 132
  // deletes the sourceId=NULL settings rows, so after this phase a "global
  // settings grant" no longer exists as a concept for any control in the
  // product to create; refusing the unscoped write would leave a user
  // holding settings:write on a source with no way to save global settings
  // at all.
  it('a sourceA-scoped settings:write grant is rejected on sourceB and honored on the unscoped global write (#4416, PHASE6 spec §11)', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const resA = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ maxNodeAgeHours: '48' });
    expect(resA.status).toBe(200);

    // The actual fix: a sourceA grant no longer authorizes sourceB.
    const resB = await agent
      .post(`/api/settings?sourceId=${harness.sourceB}`)
      .send({ maxNodeAgeHours: '48' });
    expect(resB.status).toBe(403);

    // Settled per §11 — see the comment above the test. Not a leak: the
    // unscoped endpoint takes the union branch by design.
    const resGlobal = await agent.post('/api/settings').send({ maxNodeAgeHours: '48' });
    expect(resGlobal.status).toBe(200);
  });

  // A user with NO grant at all on 'settings' (any source) is still denied —
  // the non-sourcey branch's first loop only matches a canonical
  // sourceId=NULL row, and its second loop requires at least one row for the
  // resource with a sourceId. With zero rows, both loops find nothing.
  it('a user with no settings grant at all is denied on every path', async () => {
    const agent = await harness.loginAs(harness.limited);

    const resScoped = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ maxNodeAgeHours: '48' });
    expect(resScoped.status).toBe(403);

    const resGlobal = await agent.post('/api/settings').send({ maxNodeAgeHours: '48' });
    expect(resGlobal.status).toBe(403);
  });

  // 4. Admin bypasses both, scoped and unscoped.
  it('admin bypasses permission checks on both a specific source and the global write', async () => {
    const agent = await harness.loginAs(harness.admin);

    const resScoped = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ maxNodeAgeHours: '48' });
    expect(resScoped.status).toBe(200);

    const resGlobal = await agent.post('/api/settings').send({ maxNodeAgeHours: '48' });
    expect(resGlobal.status).toBe(200);
  });

  // 5. Namespace isolation — the per-source isolation test the epic
  // requires: each source reads back its own value, and the global row is
  // untouched.
  it('writes to sourceA and sourceB stay isolated from each other and from the global row', async () => {
    const agent = await harness.loginAs(harness.admin);

    await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ maxNodeAgeHours: '48' }).expect(200);
    await agent.post(`/api/settings?sourceId=${harness.sourceB}`).send({ maxNodeAgeHours: '12' }).expect(200);

    const a = await harness.db.settings.getSettingForSource(harness.sourceA, 'maxNodeAgeHours');
    const b = await harness.db.settings.getSettingForSource(harness.sourceB, 'maxNodeAgeHours');
    expect(a).toBe('48');
    expect(b).toBe('12');

    const globalRow = await harness.db.settings.getSetting('maxNodeAgeHours');
    expect(globalRow).not.toBe('48');
    expect(globalRow).not.toBe('12');
  });

  // 6. ?sourceId=a&sourceId=b (array) → 400 BAD_REQUEST (documents the §3.3
  // array case — the middleware's own typeof check, not the route handler).
  it('a duplicated sourceId query param is rejected with 400 BAD_REQUEST', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}&sourceId=${harness.sourceB}`)
      .send({ maxNodeAgeHours: '48' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  // 7. #4412 Phase 2 WP4: inactiveNodeNotificationService now resolves its
  // config per source on each tick, so a scoped save must invalidate ONLY
  // that source's cached next-run — never sourceB's, and never a global
  // (null) reschedule.
  describe('rescheduleInactiveNodeService side-effect (#4412 Phase 2 WP4)', () => {
    const rescheduleSpy = vi.fn();

    beforeEach(() => {
      setSettingsCallbacks({ rescheduleInactiveNodeService: rescheduleSpy });
      rescheduleSpy.mockClear();
    });

    afterEach(() => {
      setSettingsCallbacks({});
    });

    it('a scoped save of an inactive-node key reschedules sourceA only', async () => {
      const agent = await harness.loginAs(harness.admin);

      const res = await agent
        .post(`/api/settings?sourceId=${harness.sourceA}`)
        .send({ inactiveNodeThresholdHours: '48' });

      expect(res.status).toBe(200);
      expect(rescheduleSpy).toHaveBeenCalledTimes(1);
      expect(rescheduleSpy).toHaveBeenCalledWith(harness.sourceA);
      expect(rescheduleSpy).not.toHaveBeenCalledWith(harness.sourceB);
      expect(rescheduleSpy).not.toHaveBeenCalledWith(null);
    });
  });

  // 8. #4412 Phase 3 WP1 (D5): GET /api/settings?sourceId= must NOT back-fill
  // the ten Node Display keys from the global row. `harness.sourceA` /
  // `sourceB` are freshly created per-test (deleteSource + createSource, see
  // routeTestApp.ts) — they never go through migration 131's seed, so they
  // are exactly the "source created after migration 131" case D5 protects.
  describe('GET /api/settings — Node Display global back-fill exclusion (#4412 Phase 3 WP1 D5)', () => {
    afterEach(async () => {
      await harness.db.settings.deleteSetting('distanceUnit').catch(() => {});
    });

    it('a source with no seeded Node Display rows omits those keys instead of inheriting the global value', async () => {
      await harness.db.settings.setSetting('maxNodeAgeHours', '99');
      await harness.db.settings.setSetting('distanceUnit', 'imperial');
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.get(`/api/settings?sourceId=${harness.sourceA}`);

      expect(res.status).toBe(200);
      // Node Display key: absent, not back-filled from the global '99'.
      expect(Object.prototype.hasOwnProperty.call(res.body, 'maxNodeAgeHours')).toBe(false);
      // Non-Node-Display global key: still back-filled as before.
      expect(res.body.distanceUnit).toBe('imperial');
    });

    it('once a per-source Node Display row exists, it wins over the global row', async () => {
      await harness.db.settings.setSetting('maxNodeAgeHours', '99');
      const agent = await harness.loginAs(harness.admin);

      await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ maxNodeAgeHours: '48' }).expect(200);

      const res = await agent.get(`/api/settings?sourceId=${harness.sourceA}`);
      expect(res.status).toBe(200);
      expect(res.body.maxNodeAgeHours).toBe('48');
    });

    it('the unscoped GET is unaffected and still returns the global Node Display value', async () => {
      await harness.db.settings.setSetting('maxNodeAgeHours', '99');
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.get('/api/settings');
      expect(res.status).toBe(200);
      expect(res.body.maxNodeAgeHours).toBe('99');
    });
  });
});

// #4419(a): POST /api/settings compared the auto-ack change-detection guard against
// `currentSettings.<bareKey>` (the GLOBAL row) even on a scoped (?sourceId=) write.
// getAllSettings() returns both namespaces in one snapshot, so the correct comparison
// costs no extra query — it just has to read `source:{id}:<key>` instead of `<key>`.
// See src/server/routes/settingsRoutes.ts's `scopedSettingKey()` helper and
// PER_SOURCE_NODE_DISPLAY_PHASE5_SPEC.md §2.
describe('POST /api/settings — autoAck change-detection is scope-correct (#4419a)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.db.settings.deleteSetting('autoAckRegex').catch(() => {});
    await harness.db.settings.deleteSetting('autoAckEnabled').catch(() => {});
    await harness.db.settings.deleteSetting('autoAckMessage').catch(() => {});
    await harness.cleanup();
  });

  it('a scoped re-save of the source\'s own bad regex is allowed while auto-ack is off (the #3806 unstick, per source)', async () => {
    // Source A already has a lookaround pattern on file (persisted before RE2
    // validation existed) and auto-ack disabled. The GLOBAL row holds a
    // DIFFERENT pattern — this is the case the defect gets wrong: reading the
    // global row makes an unchanged per-source save look changed.
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckRegex', 'foo(?=bar)');
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckEnabled', 'false');
    await harness.db.settings.setSetting('autoAckRegex', 'plain');

    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ autoAckRegex: 'foo(?=bar)', autoAckEnabled: 'false' });

    // Fails with the defect present: currentSettings.autoAckRegex resolves to the
    // global 'plain', which differs from the posted pattern, so regexChanged is
    // (wrongly) true and RE2 rejects the lookaround pattern with a 400 — the
    // exact #3806 failure the guard exists to prevent, reintroduced per-source.
    expect(res.status).toBe(200);
  });

  it('a scoped change to a NEW bad regex is rejected even when it equals the global row', async () => {
    // Global row already holds the lookaround pattern; source A's own stored
    // pattern is different ('plain'). The defect compares against the GLOBAL
    // row, sees no change, and skips validation — saving a new bad pattern
    // unvalidated.
    await harness.db.settings.setSetting('autoAckRegex', 'foo(?=bar)');
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckRegex', 'plain');
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckEnabled', 'false');

    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ autoAckRegex: 'foo(?=bar)', autoAckEnabled: 'false' });

    // Fails with the defect present: currentSettings.autoAckRegex (global) already
    // equals the posted pattern, so regexChanged is (wrongly) false and the new
    // bad pattern is saved unvalidated (200) instead of rejected (400).
    expect(res.status).toBe(400);
  });

  it('willBeEnabled reads this source\'s own flag, not the global one', async () => {
    // Both the global row and source A's row already hold the SAME (invalid)
    // pattern as the one being posted, so regexChanged is false either way —
    // this isolates the test to the willBeEnabled half of the guard. Auto-ack
    // is globally enabled but OFF for source A; only the per-source flag
    // should be consulted, since the posted body doesn't include
    // autoAckEnabled at all.
    await harness.db.settings.setSetting('autoAckEnabled', 'true');
    await harness.db.settings.setSetting('autoAckRegex', 'foo(?=bar)');
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckEnabled', 'false');
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckRegex', 'foo(?=bar)');

    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ autoAckRegex: 'foo(?=bar)' });

    // Fails with the defect present: currentSettings.autoAckEnabled (global) is
    // 'true', so willBeEnabled is (wrongly) true, forcing validation of the
    // (unchanged, but invalid) pattern -> 400.
    expect(res.status).toBe(200);
  });

  it("sourceA's regex state does not affect a sourceB save", async () => {
    // Seed a bad pattern on source A only. Posting the SAME pattern to source B
    // (which has no stored override at all) must still be rejected — B has no
    // prior value to "unstick" against, so this pins that the new per-source
    // lookup does not leak A's state into B's comparison.
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckRegex', 'foo(?=bar)');
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckEnabled', 'false');

    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceB}`)
      .send({ autoAckRegex: 'foo(?=bar)', autoAckEnabled: 'false' });

    expect(res.status).toBe(400);
  });

  it('the unscoped POST still compares against the global row (no regression)', async () => {
    // Pins the identity-function property of scopedSettingKey: with sourceId
    // null it must behave exactly as before. A DIFFERENT per-source override on
    // source A must have zero influence on the global comparison.
    await harness.db.settings.setSetting('autoAckRegex', 'foo(?=bar)');
    await harness.db.settings.setSetting('autoAckEnabled', 'false');
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckRegex', 'a-totally-different-pattern');

    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/api/settings')
      .send({ autoAckRegex: 'foo(?=bar)', autoAckEnabled: 'false' });

    expect(res.status).toBe(200);
  });

  it('the audit row records the per-source before-value', async () => {
    // Guards the auditSettingsWrite refactor (prefix -> scopedSettingKey): the
    // emitted audit event must still carry the SOURCE's prior value as
    // `before`, not the global row's. auditLogAsync currently discards
    // valueBefore/valueAfter before they reach the DB (see the "Note" in
    // DatabaseService.auditLogAsync), so this asserts on the call arguments
    // via a spy rather than reading a persisted row back.
    await harness.db.settings.setSourceSetting(harness.sourceA, 'autoAckMessage', 'old source message');
    await harness.db.settings.setSetting('autoAckMessage', 'old global message');

    const spy = vi.spyOn(databaseService, 'auditLogAsync');
    try {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/settings?sourceId=${harness.sourceA}`)
        .send({ autoAckMessage: 'new source message' });
      expect(res.status).toBe(200);

      const call = spy.mock.calls.find((args) => args[2] === 'settings');
      expect(call).toBeDefined();
      const [, , , details, , valueBefore, valueAfter] = call!;
      expect(JSON.parse(details as string).sourceId).toBe(harness.sourceA);
      expect(JSON.parse(valueBefore as string).autoAckMessage).toBe('old source message');
      expect(JSON.parse(valueAfter as string).autoAckMessage).toBe('new source message');
    } finally {
      spy.mockRestore();
    }
  });
});
