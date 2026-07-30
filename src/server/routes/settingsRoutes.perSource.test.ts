/**
 * POST /api/settings — per-source permission scoping and isolation (#4412
 * Phase 1 WP2, spec §6.3).
 *
 * Converted to the real-middleware harness (createRouteTestApp) per CLAUDE.md
 * ("New or changed route tests MUST use the harness"). Exercises the real
 * `checkPermissionAsync` against real permission rows, rather than a
 * hand-rolled mock lambda that could pass while the real per-source scoping
 * (requirePermission('settings', 'write', { sourceIdFrom: 'query' })) is
 * broken — see src/server/test-helpers/routeTestApp.ts and
 * src/server/routes/sourceRoutes.permissions.test.ts (the canonical template).
 *
 * IMPORTANT — this harness surfaced a pre-existing DB-layer gap (very likely
 * the epic's "bug #4"): `checkPermissionAsync` classifies 'settings' as a
 * NON-sourcey resource (it reads `src/types/permission.ts`'s
 * `SOURCEY_RESOURCES`, which omits 'settings', rather than the newer/complete
 * list at `src/server/constants/permissions.ts`). The practical effect: a
 * settings:write grant scoped to one source currently authorizes writes to
 * every source and to the global (unscoped) endpoint too. See the detailed
 * comment on the "KNOWN GAP" test below. WP2's own route change (§3.3,
 * passing `scopedSourceId` into `checkPermissionAsync`) is correct; the gap
 * is downstream and out of WP2's file ownership to fix.
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

  // ── DEVIATION FROM THE SPEC'S NAIVE EXPECTATION — recorded per §6.3 item 3's
  // own instruction ("if source-scoped grants are designed to imply the
  // global scope, assert the actual designed behavior and record it ...
  // rather than forcing this expectation").
  //
  // ROOT CAUSE (verified empirically, not assumed): `checkPermissionAsync`
  // (src/services/database.ts:4372) classifies "sourcey" resources via
  // `isSourceyResource()` imported from **src/types/permission.ts**, whose
  // own `SOURCEY_RESOURCES` list does NOT include 'settings' (it only has
  // channel_0-7, messages, nodes, nodes_private, traceroute, packetmonitor,
  // configuration, connection, automation, waypoints, remote_admin). A
  // DIFFERENT, newer `SOURCEY_RESOURCES` set exists at
  // src/server/constants/permissions.ts and DOES include 'settings' (added
  // in commit eabca8a5) — but its accompanying `isResourceSourcey()` export
  // is dead code, never imported anywhere. The two lists drifted apart and
  // nothing reconciles them.
  //
  // CONSEQUENCE: `requirePermission('settings', 'write', { sourceIdFrom:
  // 'query' })` correctly resolves `scopedSourceId` and passes it into
  // `checkPermissionAsync(user.id, 'settings', 'write', scopedSourceId)` —
  // WP2's route-level change (§3.3) is correct and does exactly what the
  // spec asked. But because `checkPermissionAsync` treats 'settings' as a
  // NON-sourcey resource, it takes the bottom branch of the function, which
  // authorizes on ANY row for that resource regardless of the row's own
  // `sourceId` AND regardless of the `sourceId` being checked — so a grant
  // scoped to sourceA also authorizes writes to sourceB, and to the
  // unscoped global endpoint. This is a pre-existing DB-layer gap (the
  // exact-match/union branches for genuinely-sourcey resources, a few lines
  // above in the same function, are never reached for 'settings') — it is
  // NOT introduced by WP2 and cannot be fixed from files in WP2's ownership
  // (src/server/routes/settingsRoutes.ts + its tests + 4 lines of
  // server.ts). The fix belongs in src/types/permission.ts's
  // `SOURCEY_RESOURCES` (add 'settings', and ideally 'dashboard', 'info',
  // 'audit', 'security' to match constants/permissions.ts, or delete the
  // duplicate list entirely and import the constants/permissions.ts one).
  // Flagged prominently in the WP2 report as a blocking follow-up — this is
  // very likely "epic bug #4" itself, still open after WP2.
  it('KNOWN GAP: a sourceA-scoped grant currently also authorizes sourceB and the global write (checkPermissionAsync classifies "settings" as non-sourcey — see comment above)', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const resA = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ maxNodeAgeHours: '48' });
    expect(resA.status).toBe(200);

    // Intended (epic) behavior would be 403 here. Actual current behavior is
    // 200 — see the root-cause comment above the test.
    const resB = await agent
      .post(`/api/settings?sourceId=${harness.sourceB}`)
      .send({ maxNodeAgeHours: '48' });
    expect(resB.status).toBe(200);

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
