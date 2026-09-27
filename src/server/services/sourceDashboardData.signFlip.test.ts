/**
 * Sign-flipped position correction on the dashboard feed (#5363).
 *
 * Service-level test on the real singleton DB (createRouteTestApp seeding, no
 * router mounted), so the real settings/nodes repositories and the per-source
 * setting lookup are exercised end to end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSourceNodes, buildSourceNeighborInfo } from './sourceDashboardData.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { localNodeNumSettingKey } from '../../db/repositories/settings.js';
import type { User } from '../../types/auth.js';

describe('buildSourceNodes / buildSourceNeighborInfo sign-flip correction (#5363)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: () => {} });
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.neighbors.deleteAllNeighborInfo(sourceId).catch(() => {});
      await harness.db.settings.deleteSourceSettings(sourceId).catch(() => {});
      await harness.db.settings.deleteSetting(localNodeNumSettingKey(sourceId)).catch(() => {});
    }
    await harness.cleanup();
  });

  const adminUser = () => harness.admin as unknown as User;

  async function seed(sourceId: string) {
    const now = Math.floor(Date.now() / 1000);
    // Own node in Tampa; node 111 typed its longitude without the minus sign.
    await harness.db.nodes.upsertNode(
      { nodeNum: 100, nodeId: '!00000064', longName: 'Home', latitude: 27.95, longitude: -82.46, lastHeard: now },
      sourceId,
    );
    await harness.db.nodes.upsertNode(
      { nodeNum: 111, nodeId: '!0000006f', longName: 'Flipped', latitude: 27.9, longitude: 82.5, lastHeard: now },
      sourceId,
    );
    await harness.db.settings.setSetting(localNodeNumSettingKey(sourceId), '100');
    await harness.db.neighbors.insertNeighborInfo(
      { nodeNum: 100, neighborNodeNum: 111, timestamp: Date.now(), createdAt: now },
      sourceId,
    );
  }

  it('corrects only on the source that has it enabled, and leaves the DB row alone', async () => {
    await seed(harness.sourceA);
    await seed(harness.sourceB);
    await harness.db.settings.setSourceSettings(harness.sourceA, { signFlipCorrectionEnabled: 'true' });

    const rowA = { id: harness.sourceA, name: 'A', type: 'meshtastic_tcp' };
    const rowB = { id: harness.sourceB, name: 'B', type: 'meshtastic_tcp' };

    const nodesA = (await buildSourceNodes(rowA, adminUser())) as any[];
    const flippedA = nodesA.find(n => Number(n.nodeNum) === 111);
    expect(flippedA.longitude).toBeCloseTo(-82.5);
    expect(flippedA.positionSignFlipCorrected).toBe(true);
    expect(flippedA.reportedLongitude).toBeCloseTo(82.5);
    // The own node is inside the range and untouched.
    expect(nodesA.find(n => Number(n.nodeNum) === 100).positionSignFlipCorrected).toBeUndefined();

    const nodesB = (await buildSourceNodes(rowB, adminUser())) as any[];
    const flippedB = nodesB.find(n => Number(n.nodeNum) === 111);
    expect(flippedB.longitude).toBeCloseTo(82.5);
    expect(flippedB.positionSignFlipCorrected).toBeUndefined();

    // Display only: the stored fix is unchanged.
    const stored = await harness.db.nodes.getNode(111, harness.sourceA);
    expect(stored?.longitude).toBeCloseTo(82.5);

    // Neighbor links point at the corrected marker.
    const linksA = (await buildSourceNeighborInfo(rowA, adminUser(), 168)) as any[];
    expect(linksA).toHaveLength(1);
    const endLon = Number(linksA[0].nodeNum) === 111 ? linksA[0].nodeLongitude : linksA[0].neighborLongitude;
    expect(endLon).toBeCloseTo(-82.5);
  });

  it('does nothing when enabled but no reference is known', async () => {
    const now = Math.floor(Date.now() / 1000);
    await harness.db.nodes.upsertNode(
      { nodeNum: 111, nodeId: '!0000006f', longName: 'Flipped', latitude: 27.9, longitude: 82.5, lastHeard: now },
      harness.sourceA,
    );
    await harness.db.settings.setSourceSettings(harness.sourceA, { signFlipCorrectionEnabled: 'true' });
    const nodes = (await buildSourceNodes({ id: harness.sourceA, name: 'A', type: 'meshtastic_tcp' }, adminUser())) as any[];
    expect(nodes.find(n => Number(n.nodeNum) === 111).longitude).toBeCloseTo(82.5);
  });

  it('uses a manual reference point when set', async () => {
    const now = Math.floor(Date.now() / 1000);
    await harness.db.nodes.upsertNode(
      { nodeNum: 111, nodeId: '!0000006f', longName: 'Flipped', latitude: 27.9, longitude: 82.5, lastHeard: now },
      harness.sourceA,
    );
    await harness.db.settings.setSourceSettings(harness.sourceA, {
      signFlipCorrectionEnabled: 'true',
      signFlipReferenceLatitude: '27.95',
      signFlipReferenceLongitude: '-82.46',
    });
    const nodes = (await buildSourceNodes({ id: harness.sourceA, name: 'A', type: 'meshtastic_tcp' }, adminUser())) as any[];
    expect(nodes.find(n => Number(n.nodeNum) === 111).longitude).toBeCloseTo(-82.5);
  });
});
