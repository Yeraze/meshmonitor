/**
 * Coverage import exit test (#5891 P3): seed receptions on one source, export
 * with the real CSV / GeoJSON builders, import the file into a source that
 * holds no nodes, and read the same points back from `/receptions`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import coverageImportRoutes from './coverageImportRoutes.js';
import coverageRoutes from './coverageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { groupReceptionsIntoFixes } from '../../utils/coverage.js';
import { csvOf, geoOf, nodeIdFor, uploadTo } from '../test-helpers/coverageImportFixtures.js';
import type { CoverageReceptionDto } from '../../types/coverage.js';

const MC_FROM = 'rt-mc-from';
const MC_TO = 'rt-mc-to';
const SENDER_1 = 0x81000001;
const SENDER_2 = 0x81000002;
const RECV_1 = 0x82000001;
const RECV_2 = 0x82000002;
const mcKey = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const nowSec = (): number => Math.floor(Date.now() / 1000);

type Seed = Parameters<typeof databaseService.coverageReceptions.recordReception>[0];

function fixSummary(items: CoverageReceptionDto[]) {
  return groupReceptionsIntoFixes(items)
    .map((f) => ({
      key: `${f.senderId}|${f.packetKey}`,
      lat: f.latitude,
      lon: f.longitude,
      bestSnr: f.bestSnr,
      receivers: f.receptions.map((r) => r.receiverId).sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('coverage export -> import round trip (#5891 P3)', () => {
  let harness: RouteTestHarness;

  const perm = (sourceId: string, resource: string, flags: { read?: boolean; viewOnMap?: boolean }) =>
    harness.db.auth.createPermission({
      userId: harness.limited.id, resource, canRead: !!flags.read, canWrite: false,
      canViewOnMap: !!flags.viewOnMap, sourceId, grantedAt: Date.now(), grantedBy: null,
    });

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/sources/:id/coverage/imports', coverageImportRoutes);
        app.use('/api/analysis/coverage', coverageRoutes);
      },
    });
    for (const id of [MC_FROM, MC_TO]) {
      await harness.db.sources.deleteSource(id).catch(() => {});
      await harness.db.sources.createSource({ id, name: id, type: 'meshcore', config: {}, enabled: true });
    }
  });

  afterEach(async () => {
    for (const id of [harness.sourceA, harness.sourceB, MC_FROM, MC_TO]) {
      await databaseService.coverageImports.deleteForSource(id).catch(() => {});
      await databaseService.coverageReceptions.deleteForSource(id).catch(() => {});
    }
    await harness.db.nodes.deleteAllNodes(harness.sourceA).catch(() => {});
    for (const id of [MC_FROM, MC_TO]) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.cleanup();
  });

  const read = async (agent: any, sourceId: string): Promise<CoverageReceptionDto[]> => {
    const res = await agent.get(`/api/analysis/coverage/receptions?since=0&pageSize=2000&sources=${sourceId}`);
    expect(res.status).toBe(200);
    return res.body.data.items;
  };

  async function seedMeshtastic(): Promise<void> {
    for (const n of [SENDER_1, SENDER_2, RECV_1, RECV_2]) {
      await harness.db.nodes.upsertNode({
        nodeNum: n, nodeId: nodeIdFor(n), longName: `n${n}`, shortName: 'N', channel: 0, lastHeard: nowSec(),
      } as any, harness.sourceA);
    }
    const base = (o: Partial<Seed>): Seed => ({
      sourceId: harness.sourceA, protocol: 'meshtastic', receiverKind: 'local',
      receiverId: nodeIdFor(RECV_1), receiverNodeNum: RECV_1, receiverLatitude: 40.1, receiverLongitude: -100.1,
      senderId: nodeIdFor(SENDER_1), senderNodeNum: SENDER_1, packetKey: '1001', packetId: 1001,
      pathKey: 'r0:h0', latitude: 41.25, longitude: -101.5, altitude: 120, snr: -7.25, rssi: 0,
      hopStart: 3, hopLimit: 3, hopsAway: 0, channel: 0, receivedAt: Date.now() - 120_000, ...o,
    });
    const t = Date.now();
    for (const row of [
      base({}),
      base({ receiverId: nodeIdFor(RECV_2), receiverNodeNum: RECV_2, snr: 3.5, rssi: -80, receivedAt: t - 119_000 }),
      base({ packetKey: '1002', packetId: 1002, latitude: 41.5, altitude: null, snr: 9.75, receivedAt: t - 60_000 }),
      base({ senderId: nodeIdFor(SENDER_2), senderNodeNum: SENDER_2, packetKey: '2001', packetId: 2001,
        latitude: 39.5, longitude: -99.5, snr: null, rssi: null, receiverLatitude: null, receiverLongitude: null,
        receivedAt: t - 30_000 }),
    ]) await databaseService.coverageReceptions.recordReception(row);
  }

  async function seedMeshCore(): Promise<void> {
    const base = (o: Partial<Seed>): Seed => ({
      sourceId: MC_FROM, protocol: 'meshcore', receiverKind: 'local',
      receiverId: mcKey(0xc1), receiverNodeNum: null, receiverLatitude: 40.1, receiverLongitude: -100.1,
      senderId: mcKey(0xd1), senderNodeNum: null, packetKey: 'ABCDEF0123456789', pathKey: 'h2:ab',
      latitude: 41.25, longitude: -101.5, snr: -3.5, rssi: -105, hopsAway: 2, receivedAt: Date.now() - 90_000, ...o,
    });
    for (const row of [
      base({}),
      base({ receiverId: mcKey(0xc2), snr: 6, receivedAt: Date.now() - 89_000 }),
      base({ packetKey: '0000000000000042', latitude: 42, pathKey: 'h-:-', hopsAway: null }),
    ]) await databaseService.coverageReceptions.recordReception(row);
  }

  const kinds = [['csv', csvOf], ['geojson', geoOf]] as const;

  describe.each(kinds)('Meshtastic via %s', (kind, build) => {
    it('shows the same points on a clean source', async () => {
      await seedMeshtastic();
      const admin = await harness.loginAs(harness.admin);
      const before = await read(admin, harness.sourceA);
      expect(before).toHaveLength(4);

      // Wipe the origin so the target stands alone (no nodes on the target source).
      await databaseService.coverageReceptions.deleteForSource(harness.sourceA);
      await harness.db.nodes.deleteAllNodes(harness.sourceA);

      const file = build(before); // GeoJSON carries generatedAt, so build once and reuse the bytes
      const up = await uploadTo(admin, harness.sourceB, `export.${kind === 'csv' ? 'csv' : 'geojson'}`, file);
      expect(up.status).toBe(201);
      expect(up.body.data.import).toMatchObject({ rowCount: 4, insertedCount: 4, duplicateCount: 0, format: kind });

      await perm(harness.sourceB, 'nodes', { read: true });
      await perm(harness.sourceB, 'channel_0', { viewOnMap: true });
      const reader = await harness.loginAs(harness.limited);
      const after = await read(reader, harness.sourceB);

      expect(after).toHaveLength(4);
      expect(after.every((r) => r.importId === up.body.data.import.id)).toBe(true);
      const a = fixSummary(before);
      const b = fixSummary(after);
      expect(b.map((f) => f.key)).toEqual(a.map((f) => f.key));
      b.forEach((f, i) => {
        expect(f.lat).toBeCloseTo(a[i].lat, 3);
        expect(f.lon).toBeCloseTo(a[i].lon, 3);
        expect(f.receivers).toEqual(a[i].receivers);
        if (a[i].bestSnr === null) expect(f.bestSnr).toBeNull();
        else expect(f.bestSnr).toBeCloseTo(a[i].bestSnr as number, 3);
      });
      // Per-reception fields survive too.
      const rssi0 = after.find((r) => r.packetKey === '1001' && r.receiverId === nodeIdFor(RECV_1));
      expect(rssi0).toMatchObject({ rssi: 0, altitude: 120, receiverLatitude: 40.1, senderNodeNum: SENDER_1 });

      // The same file again is a duplicate; the other format inserts nothing new.
      const again = await uploadTo(admin, harness.sourceB, 'again.' + (kind === 'csv' ? 'csv' : 'geojson'), file);
      expect(again.status).toBe(409);
      const [otherKind, otherBuild] = kinds.find(([k]) => k !== kind)!;
      const other = await uploadTo(admin, harness.sourceB, `other.${otherKind === 'csv' ? 'csv' : 'geojson'}`, otherBuild(before));
      expect(other.status).toBe(201);
      expect(other.body.data.import).toMatchObject({ insertedCount: 0, duplicateCount: 4 });
    });
  });

  describe.each(kinds)('MeshCore via %s', (kind, build) => {
    it('shows the same points on a clean source', async () => {
      await seedMeshCore();
      const admin = await harness.loginAs(harness.admin);
      await harness.db.meshcore.upsertNode(
        { publicKey: mcKey(0xd1), name: 'Sender', advType: 1, latitude: 41, longitude: -101, lastHeard: Date.now() },
        MC_FROM,
      );
      await harness.db.meshcore.upsertNode(
        { publicKey: mcKey(0xc1), name: 'Recv1', advType: 2, latitude: 40, longitude: -100, lastHeard: Date.now() },
        MC_FROM,
      );
      await harness.db.meshcore.upsertNode(
        { publicKey: mcKey(0xc2), name: 'Recv2', advType: 2, latitude: 40, longitude: -100, lastHeard: Date.now() },
        MC_FROM,
      );
      const before = await read(admin, MC_FROM);
      expect(before).toHaveLength(3);
      await databaseService.coverageReceptions.deleteForSource(MC_FROM);

      const up = await uploadTo(admin, MC_TO, `export.${kind === 'csv' ? 'csv' : 'geojson'}`, build(before));
      expect(up.status).toBe(201);
      expect(up.body.data.import.insertedCount).toBe(3);

      await perm(MC_TO, 'nodes', { read: true, viewOnMap: true });
      const reader = await harness.loginAs(harness.limited);
      const after = await read(reader, MC_TO);
      expect(after).toHaveLength(3);
      const a = fixSummary(before);
      const b = fixSummary(after);
      expect(b.map((f) => f.key)).toEqual(a.map((f) => f.key));
      b.forEach((f, i) => {
        expect(f.lat).toBeCloseTo(a[i].lat, 3);
        expect(f.receivers).toEqual(a[i].receivers);
        expect(f.bestSnr).toBeCloseTo(a[i].bestSnr as number, 3);
      });
    });
  });
});
