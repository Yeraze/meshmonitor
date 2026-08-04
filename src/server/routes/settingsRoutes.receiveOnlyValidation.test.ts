/**
 * POST /api/settings — meshcoreReceiveOnly strict-boolean validation
 * (#4547 Phase 2 WP2 §4).
 *
 * `filteredSettings[key] = String(settings[key])` (settingsRoutes.ts) has no
 * value validation, and MeshCoreManager.refreshReceiveOnly() reads the stored
 * value with `raw === 'true'`. So posting `'1'`, `'yes'`, `'TRUE'`, `'on'`,
 * `1`, `null` or `{}` would previously persist a value that reads back as
 * `false` — receive-only silently OFF while the user believes transmission
 * is blocked. This is a fail-open on a safety flag.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md — "New
 * or changed route tests MUST use the harness" — rather than mocking
 * services/database.js. See settingsRoutes.perSource.test.ts (sibling file)
 * for the same pattern applied to a different key.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import settingsRoutes, { setSettingsCallbacks } from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('POST /api/settings — meshcoreReceiveOnly strict-boolean validation (#4547 Phase 2 WP2)', () => {
  let harness: RouteTestHarness;
  const refreshSpy = vi.fn();

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
    setSettingsCallbacks({ refreshMeshcoreReceiveOnly: refreshSpy });
    refreshSpy.mockClear();
  });

  afterEach(async () => {
    setSettingsCallbacks({});
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSetting('maxNodeAgeHours').catch(() => {});
    await harness.cleanup();
  });

  it('accepts { meshcoreReceiveOnly: true } → 200, stores the string "true", and fires the refresh callback', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ meshcoreReceiveOnly: true });

    expect(res.status).toBe(200);
    const stored = await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreReceiveOnly');
    expect(stored).toBe('true');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith(harness.sourceA);
  });

  it('accepts { meshcoreReceiveOnly: false } → 200 and stores the string "false"', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ meshcoreReceiveOnly: false });

    expect(res.status).toBe(200);
    const stored = await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreReceiveOnly');
    expect(stored).toBe('false');
  });

  it.each([
    ['1', '1'],
    ['yes', 'yes'],
    ['TRUE', 'TRUE'],
    ['on', 'on'],
    [1, 1],
    [null, null],
    [{}, {}],
  ])('rejects meshcoreReceiveOnly=%p with 400 INVALID_BOOLEAN_SETTING, writes nothing, and never fires the refresh callback', async (value, _sameValue) => {
    const agent = await harness.loginAs(harness.admin);

    // Prove "nothing written" against a real prior value, not just absence.
    await harness.db.settings.setSourceSettings(harness.sourceA, { meshcoreReceiveOnly: 'true' });

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ meshcoreReceiveOnly: value });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BOOLEAN_SETTING');

    const stored = await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreReceiveOnly');
    expect(stored).toBe('true'); // unchanged from the pre-seeded value
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('a valid meshcoreReceiveOnly alongside other keys still persists the other keys', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ meshcoreReceiveOnly: true, maxNodeAgeHours: '48' });

    expect(res.status).toBe(200);
    const receiveOnly = await harness.db.settings.getSettingForSource(harness.sourceA, 'meshcoreReceiveOnly');
    const maxAge = await harness.db.settings.getSettingForSource(harness.sourceA, 'maxNodeAgeHours');
    expect(receiveOnly).toBe('true');
    expect(maxAge).toBe('48');
  });

  it('an invalid meshcoreReceiveOnly rejects the whole request — sibling keys in the same payload are not persisted either', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ meshcoreReceiveOnly: '1', maxNodeAgeHours: '48' });

    expect(res.status).toBe(400);
    const maxAge = await harness.db.settings.getSettingForSource(harness.sourceA, 'maxNodeAgeHours');
    expect(maxAge).toBeNull();
  });

  it('a global (no sourceId) POST carrying unrelated keys is unaffected by this validation', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/api/settings').send({ maxNodeAgeHours: '48' });

    expect(res.status).toBe(200);
    const stored = await harness.db.settings.getSetting('maxNodeAgeHours');
    expect(stored).toBe('48');
  });
});
