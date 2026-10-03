/**
 * Global UI preferences never live in a source namespace (#5558).
 *
 * Bug: `theme`/`appearanceMode`/`darkTheme`/`lightTheme` were not global-only,
 * so a sourced POST stored `source:{id}:appearanceMode` and the sourced GET let
 * that copy beat the global value. Per-source pages rendered dark while the
 * landing page and Global Settings (unscoped GET) rendered light.
 *
 * Real-middleware harness per CLAUDE.md; rows are read back through the same
 * singleton databaseService the route writes to.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { GLOBAL_ONLY_SETTINGS_KEYS } from '../constants/settings.js';

const APPEARANCE = ['theme', 'appearanceMode', 'darkTheme', 'lightTheme'] as const;
const OTHER_UI_PREFS = [
  'iconStyle', 'mapPinStyle', 'mapPinColorMode', 'nodeListStyle', 'defaultLandingPage',
  'temperatureUnit', 'distanceUnit', 'timeFormat', 'dateFormat',
  'preferredSortField', 'preferredSortDirection', 'preferredDashboardSortOption',
] as const;

describe('global UI preferences vs source namespaces (#5558)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    for (const k of [...APPEARANCE, ...OTHER_UI_PREFS]) {
      await harness.db.settings.deleteSetting(k).catch(() => {});
    }
    await harness.cleanup();
  });

  it('every appearance and UI-preference key is global-only', () => {
    for (const k of [...APPEARANCE, ...OTHER_UI_PREFS]) {
      expect(GLOBAL_ONLY_SETTINGS_KEYS.has(k)).toBe(true);
    }
  });

  it('a sourced POST of appearance keys writes nothing into the source namespace', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ appearanceMode: 'dark', darkTheme: 'mocha', lightTheme: 'mocha', theme: 'mocha' });

    expect(res.status).toBe(200);
    expect(res.body.data.ignoredKeys.sort()).toEqual([...APPEARANCE].sort());
    for (const k of APPEARANCE) {
      expect(await harness.db.settings.getSettingForSource(harness.sourceA, k)).toBeNull();
    }
  });

  it('the unscoped POST (what SettingsTab sends for appearance) is what the sourced GET returns', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post('/api/settings').send({ appearanceMode: 'dark', darkTheme: 'nord', theme: 'nord' }).expect(200);

    const scoped = await agent.get(`/api/settings?sourceId=${harness.sourceA}`).expect(200);
    const global = await agent.get('/api/settings').expect(200);
    for (const res of [scoped, global]) {
      expect(res.body.appearanceMode).toBe('dark');
      expect(res.body.darkTheme).toBe('nord');
      expect(res.body.theme).toBe('nord');
    }
  });

  it('a stale source copy of a global-only key never overrides the global value on the sourced GET', async () => {
    await harness.db.settings.setSettings({ appearanceMode: 'light', lightTheme: 'latte', temperatureUnit: 'C' });
    // Rows an older build (or a direct sourced POST) left behind.
    await harness.db.settings.setSourceSettings(harness.sourceA, {
      appearanceMode: 'dark',
      darkTheme: 'mocha',
      temperatureUnit: 'F',
      // Control: a genuinely per-source key still wins.
      maxNodeAgeHours: '72',
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/api/settings?sourceId=${harness.sourceA}`).expect(200);

    expect(res.body.appearanceMode).toBe('light');
    expect(res.body.lightTheme).toBe('latte');
    expect(res.body.temperatureUnit).toBe('C');
    // No global darkTheme exists, so the stale source copy must not appear either.
    expect(res.body).not.toHaveProperty('darkTheme');
    expect(res.body.maxNodeAgeHours).toBe('72');
  });
});
