/**
 * #5363: the scheduled distance auto-delete and the MQTT geo sweep judge the
 * sign-flip corrected point when correction is on for the source, and the
 * reported point when it is off. Real singleton DB via createRouteTestApp
 * seeding (no router mounted).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { autoDeleteByDistanceService } from './autoDeleteByDistanceService.js';
import { mqttGeoSweepService } from './mqttGeoSweepService.js';
import { invalidateSignFlipContext } from './signFlipCorrection.js';

const FLORIDA_BBOX = { minLat: 24, maxLat: 31, minLng: -88, maxLng: -79 };

describe('sign-flip correction in distance delete and geo sweep (#5363)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: () => {} });
    invalidateSignFlipContext();
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.settings.deleteSourceSettings(sourceId).catch(() => {});
      await harness.db.ignoredNodes.getIgnoredNodesAsync(sourceId)
        .then(rows => Promise.all(rows.map(r => harness.db.ignoredNodes.removeIgnoredNodeAsync(Number(r.nodeNum), sourceId))))
        .catch(() => {});
    }
    invalidateSignFlipContext();
    await harness.cleanup();
  });

  async function seedFlipped(sourceId: string, nodeNum: number) {
    await harness.db.nodes.upsertNode(
      {
        nodeNum,
        nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
        longName: 'Flipped',
        latitude: 27.9,
        longitude: 82.5,
        lastHeard: Math.floor(Date.now() / 1000),
      },
      sourceId,
    );
  }

  const signFlip = (enabled: boolean) => ({
    signFlipCorrectionEnabled: enabled ? 'true' : 'false',
    signFlipReferenceLatitude: '27.95',
    signFlipReferenceLongitude: '-82.46',
  });

  const distanceDelete = {
    autoDeleteByDistanceLat: '27.95',
    autoDeleteByDistanceLon: '-82.46',
    autoDeleteByDistanceThresholdKm: '100',
    autoDeleteByDistanceAction: 'delete',
  };

  it('scheduled distance delete keeps a flipped node when correction is on, deletes it when off', async () => {
    await seedFlipped(harness.sourceA, 501);
    await seedFlipped(harness.sourceB, 502);
    await harness.db.settings.setSourceSettings(harness.sourceA, { ...distanceDelete, ...signFlip(true) });
    await harness.db.settings.setSourceSettings(harness.sourceB, { ...distanceDelete, ...signFlip(false) });

    await autoDeleteByDistanceService.runDeleteCycle(harness.sourceA);
    await autoDeleteByDistanceService.runDeleteCycle(harness.sourceB);

    expect(await harness.db.nodes.getNode(501, harness.sourceA)).not.toBeNull();
    expect(await harness.db.nodes.getNode(502, harness.sourceB)).toBeNull();
  });

  it('geo sweep leaves a flipped node alone when correction is on, geo-ignores it when off', async () => {
    await seedFlipped(harness.sourceA, 601);
    await seedFlipped(harness.sourceB, 602);
    await harness.db.settings.setSourceSettings(harness.sourceA, signFlip(true));
    await harness.db.settings.setSourceSettings(harness.sourceB, signFlip(false));

    const statsA = await mqttGeoSweepService.runSweep(harness.sourceA, FLORIDA_BBOX, { lift: false });
    const statsB = await mqttGeoSweepService.runSweep(harness.sourceB, FLORIDA_BBOX, { lift: false });

    expect(statsA.ignored).toBe(0);
    expect(harness.db.ignoredNodes.isIgnoredCached(601, harness.sourceA)).toBe(false);
    expect(statsB.ignored).toBe(1);
    expect(harness.db.ignoredNodes.isIgnoredCached(602, harness.sourceB)).toBe(true);
  });
});
