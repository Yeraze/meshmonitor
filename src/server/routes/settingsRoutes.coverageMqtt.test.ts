/**
 * POST /api/settings — `coverage_mqtt_enabled` per-source save +
 * cache invalidation (#5277 P2, §2.1 / §3).
 *
 * Uses the real-middleware harness (`createRouteTestApp`) per CLAUDE.md —
 * "New or changed route tests MUST use the harness" — rather than mocking
 * `services/database.js`. `isCoverageMqttEnabled` is imported directly
 * (real module, real 30s TTL cache) and exercised against the SAME
 * singleton `databaseService` the harness uses (see routeTestApp.ts header),
 * so this proves the actual invalidation wiring in `settingsRoutes.ts`
 * rather than re-implementing it in a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  isCoverageMqttEnabled,
  __resetCoverageMqttCacheForTest,
} from '../services/coverageMqttSettings.js';
import { COVERAGE_MQTT_ENABLED_SETTING } from '../../utils/coverage.js';

describe('POST /api/settings — coverage_mqtt_enabled (#5277 P2)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
    __resetCoverageMqttCacheForTest();
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    __resetCoverageMqttCacheForTest();
    await harness.cleanup();
  });

  it("persists source:<id>:coverage_mqtt_enabled and takes effect immediately (no 30s wait)", async () => {
    const agent = await harness.loginAs(harness.admin);

    // Warm the cache with the pre-save (off) value.
    expect(await isCoverageMqttEnabled(harness.sourceA)).toBe(false);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ [COVERAGE_MQTT_ENABLED_SETTING]: '1' });

    expect(res.status).toBe(200);
    const stored = await harness.db.settings.getSettingForSource(harness.sourceA, COVERAGE_MQTT_ENABLED_SETTING);
    expect(stored).toBe('1');

    // Without the invalidation call in settingsRoutes.ts, this would still
    // read the 30s-stale cached `false` from the warm-up read above.
    expect(await isCoverageMqttEnabled(harness.sourceA)).toBe(true);
  });

  it('turning it back off also invalidates immediately', async () => {
    const agent = await harness.loginAs(harness.admin);

    await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ [COVERAGE_MQTT_ENABLED_SETTING]: '1' });
    expect(await isCoverageMqttEnabled(harness.sourceA)).toBe(true);

    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ [COVERAGE_MQTT_ENABLED_SETTING]: '0' });
    expect(res.status).toBe(200);
    expect(await isCoverageMqttEnabled(harness.sourceA)).toBe(false);
  });

  it('a save that does not touch the key never invalidates a warm cache for that source', async () => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, { [COVERAGE_MQTT_ENABLED_SETTING]: '1' });
    __resetCoverageMqttCacheForTest();
    expect(await isCoverageMqttEnabled(harness.sourceA)).toBe(true); // warms cache to true

    // Flip the underlying row directly (bypassing the route, so no
    // invalidation fires), then save an unrelated key through the route.
    await harness.db.settings.setSourceSettings(harness.sourceA, { [COVERAGE_MQTT_ENABLED_SETTING]: '0' });
    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ maxNodeAgeHours: '48' });
    expect(res.status).toBe(200);

    // Cache is still warm from before — the direct DB flip is invisible until
    // the TTL naturally expires or something invalidates it explicitly.
    expect(await isCoverageMqttEnabled(harness.sourceA)).toBe(true);
  });

  it('a global (no sourceId) bare-key write has zero effect on any source (#5080)', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/api/settings').send({ [COVERAGE_MQTT_ENABLED_SETTING]: '1' });
    expect(res.status).toBe(200);

    expect(await isCoverageMqttEnabled(harness.sourceA)).toBe(false);
  });

  it('a valid coverage_mqtt_enabled save alongside other per-source keys persists both', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ [COVERAGE_MQTT_ENABLED_SETTING]: '1', maxNodeAgeHours: '48' });

    expect(res.status).toBe(200);
    const flag = await harness.db.settings.getSettingForSource(harness.sourceA, COVERAGE_MQTT_ENABLED_SETTING);
    const maxAge = await harness.db.settings.getSettingForSource(harness.sourceA, 'maxNodeAgeHours');
    expect(flag).toBe('1');
    expect(maxAge).toBe('48');
  });
});
