/**
 * MeshCore location override (#5842) — precedence and privacy rules.
 *
 *  - `applyMeshCorePositionOverride`: the read-side rule every MeshCore
 *    position surface goes through.
 *  - `buildMeshCorePositionFilter`: the coverage / cross-source gate drops a
 *    private-override node for a caller without `nodes_private:read`, as
 *    `buildPositionFilter` does for Meshtastic.
 *  - `buildMeshCoreNodeEvent`: the unauthenticated CoT feed uses a public
 *    override and never emits a private one.
 *  - `stripPositions`: the viewOnMap mask removes the override fields too.
 */
import { describe, it, expect } from 'vitest';
import {
  applyMeshCorePositionOverride,
  applyMeshCorePositionOverrides,
  type MeshCorePositionOverride,
} from './meshcorePositionOverride.js';
import { buildMeshCorePositionFilter } from './positionVisibility.js';
import { stripPositions } from './meshcorePositions.js';
import { buildMeshCoreNodeEvent } from '../services/cotFeedService.js';
import type { SourcePermissions } from './sourcePermissions.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import { isHiddenByPositionlessAdvert } from '../../utils/meshcoreAdvertPosition.js';

const KEY = 'ab'.repeat(32);
const ROW = { publicKey: KEY, name: 'Base', latitude: 40, longitude: -105, altitude: 1600 };
const PUBLIC_OV: MeshCorePositionOverride = { publicKey: KEY, enabled: true, latitude: 28.5, longitude: -81.4, altitude: 30, isPrivate: false };
const PRIVATE_OV: MeshCorePositionOverride = { ...PUBLIC_OV, isPrivate: true };

describe('applyMeshCorePositionOverride', () => {
  it('an enabled override wins over the advert position', () => {
    expect(applyMeshCorePositionOverride(ROW, PUBLIC_OV, false)).toEqual({
      ...ROW,
      latitude: 28.5,
      longitude: -81.4,
      altitude: 30,
      positionIsOverride: true,
      positionOverrideEnabled: true,
      latitudeOverride: 28.5,
      longitudeOverride: -81.4,
      altitudeOverride: 30,
      positionOverrideIsPrivate: false,
    });
  });

  it('keeps the advert altitude when the override has none', () => {
    const out = applyMeshCorePositionOverride(ROW, { ...PUBLIC_OV, altitude: undefined }, false);
    expect(out.altitude).toBe(1600);
    expect(out).not.toHaveProperty('altitudeOverride');
  });

  it('a private override is applied only with nodes_private:read', () => {
    expect(applyMeshCorePositionOverride(ROW, PRIVATE_OV, false)).toEqual(ROW);
    expect(applyMeshCorePositionOverride(ROW, PRIVATE_OV, true)).toMatchObject({ latitude: 28.5, positionOverrideIsPrivate: true });
  });

  it('no override, a disabled one, or one without coordinates leaves the row alone', () => {
    expect(applyMeshCorePositionOverride(ROW, undefined, true)).toBe(ROW);
    expect(applyMeshCorePositionOverride(ROW, { ...PUBLIC_OV, enabled: false }, true)).toBe(ROW);
    expect(applyMeshCorePositionOverride(ROW, { ...PUBLIC_OV, latitude: undefined }, true)).toBe(ROW);
  });

  it('removes raw override columns a DB row carried in', () => {
    const raw = { ...ROW, positionOverrideEnabled: true, latitudeOverride: 1, longitudeOverride: 2, positionOverrideIsPrivate: true };
    expect(applyMeshCorePositionOverride(raw, undefined, false)).toEqual(ROW);
  });

  it('drops the sign-flip annotation, which described the advert fix', () => {
    const flipped = { ...ROW, positionSignFlipCorrected: true, reportedLatitude: -40, reportedLongitude: 105 };
    const out = applyMeshCorePositionOverride(flipped, PUBLIC_OV, false) as Record<string, unknown>;
    expect(out.positionSignFlipCorrected).toBeUndefined();
    expect(out.reportedLatitude).toBeUndefined();
  });

  it('the batch form keys by lowercased public key', () => {
    const rows = [{ ...ROW, publicKey: KEY.toUpperCase() }, { ...ROW, publicKey: 'cd'.repeat(32) }];
    const out = applyMeshCorePositionOverrides(rows, new Map([[KEY, PUBLIC_OV]]), false);
    expect(out[0].latitude).toBe(28.5);
    expect(out[1].latitude).toBe(40);
  });

  it('an override position is never hidden by the positionless-advert filter', () => {
    const out = applyMeshCorePositionOverride({ ...ROW, lastAdvertHadPosition: false }, PUBLIC_OV, false);
    expect(isHiddenByPositionlessAdvert(out, true)).toBe(false);
    expect(isHiddenByPositionlessAdvert({ ...ROW, lastAdvertHadPosition: false }, true)).toBe(true);
  });
});

describe('stripPositions removes the override fields', () => {
  it('a caller without viewOnMap gets no override data', () => {
    const applied = applyMeshCorePositionOverride(ROW, PUBLIC_OV, true);
    const [masked] = stripPositions([applied]);
    for (const k of ['latitude', 'longitude', 'positionIsOverride', 'positionOverrideEnabled', 'latitudeOverride', 'longitudeOverride', 'altitudeOverride', 'positionOverrideIsPrivate']) {
      expect(masked).not.toHaveProperty(k);
    }
  });
});

describe('buildMeshCorePositionFilter — private override (#5842)', () => {
  const grants = (privateOn: string[]): SourcePermissions => ({
    can: (resource: string, action: string, sourceId?: string) => {
      if (resource === 'nodes' && action === 'viewOnMap') return true;
      if (resource === 'nodes_private' && action === 'read') return !!sourceId && privateOn.includes(sourceId);
      return false;
    },
  }) as unknown as SourcePermissions;

  const nodes = new Map<string, DbMeshCoreNode[]>([
    ['src-a', [
      { publicKey: KEY, positionOverrideEnabled: true, positionOverrideIsPrivate: true, createdAt: 0, updatedAt: 0 },
      { publicKey: 'cd'.repeat(32), createdAt: 0, updatedAt: 0 },
    ]],
  ]);
  const user = { id: 7, isAdmin: false };

  it('drops a private-override node without nodes_private:read on its source', async () => {
    const f = await buildMeshCorePositionFilter(user, ['src-a'], nodes, grants(['src-b']));
    expect(f({ sourceId: 'src-a', publicKey: KEY })).toBe(false);
    expect(f({ sourceId: 'src-a', publicKey: 'cd'.repeat(32) })).toBe(true);
  });

  it('passes it with nodes_private:read on its source', async () => {
    const f = await buildMeshCorePositionFilter(user, ['src-a'], nodes, grants(['src-a']));
    expect(f({ sourceId: 'src-a', publicKey: KEY.toUpperCase() })).toBe(true);
  });
});

describe('buildMeshCoreNodeEvent — CoT feed (#5842)', () => {
  const NOW = 1_700_000_000_000;
  const node = (extra: Partial<DbMeshCoreNode>): DbMeshCoreNode => ({
    publicKey: KEY, name: 'Base', latitude: 40, longitude: -105, altitude: 1600,
    lastHeard: NOW - 60_000, sourceId: 's', createdAt: NOW, updatedAt: NOW, ...extra,
  });

  it('uses a public override', () => {
    const xml = buildMeshCoreNodeEvent(node({ positionOverrideEnabled: true, latitudeOverride: 28.5, longitudeOverride: -81.4, altitudeOverride: 30 }), 'S', NOW)!;
    expect(xml).toContain('lat="28.5"');
    expect(xml).toContain('lon="-81.4"');
    expect(xml).toContain('hae="30"');
  });

  it('never emits a node with a private override', () => {
    expect(buildMeshCoreNodeEvent(node({ positionOverrideEnabled: true, positionOverrideIsPrivate: true, latitudeOverride: 28.5, longitudeOverride: -81.4 }), 'S', NOW)).toBeNull();
  });

  it('uses the advert position with no override', () => {
    expect(buildMeshCoreNodeEvent(node({}), 'S', NOW)).toContain('lat="40"');
  });
});
