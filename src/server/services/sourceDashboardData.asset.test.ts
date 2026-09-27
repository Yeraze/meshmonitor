/**
 * Asset Tracking (#5354) — buildSourceNodes sends raw rows without the
 * enhancer, so it must attach `asset` and the effective `isMobile` itself,
 * and must not touch the raw `mobile` column.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSourceNodes } from './sourceDashboardData.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { User } from '../../types/auth.js';

const ASSET = 0x0a0b0c0d;
const PLAIN = 0x0d0c0b0a;

describe('buildSourceNodes asset overlay (#5354)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: () => {} });
    for (const nodeNum of [ASSET, PLAIN]) {
      await harness.db.nodes.upsertNode(
        { nodeNum, nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`, longName: 'N', lastHeard: Math.floor(Date.now() / 1000) },
        harness.sourceA,
      );
    }
    await harness.db.assetNodes.setAsync(ASSET, 45);
  });

  afterEach(async () => {
    await harness.db.assetNodes.clearAsync(ASSET);
    await harness.cleanup();
  });

  it('marks the asset mobile and leaves the other node on the heuristic', async () => {
    const rows = (await buildSourceNodes(
      { id: harness.sourceA, name: 'A', type: 'meshtastic_tcp' },
      harness.admin as unknown as User,
    )) as Array<{ nodeNum: number; asset?: unknown; isMobile: boolean; mobile: number | null }>;

    const asset = rows.find((r) => Number(r.nodeNum) === ASSET)!;
    const plain = rows.find((r) => Number(r.nodeNum) === PLAIN)!;
    expect(asset.asset).toEqual({ retentionDays: 45 });
    expect(asset.isMobile).toBe(true);
    expect(asset.mobile ?? 0).toBe(0);
    expect(plain.asset).toBeUndefined();
    expect(plain.isMobile).toBe(false);
  });
});
