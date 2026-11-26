/**
 * Walkabout export + import (#6573): auth matrix, export shape, privacy
 * filtering (hidden nodes dropped and counted over the whole session), the
 * JSON round trip through the Coverage import route, imported-row visibility,
 * delete rules and caps. Real harness + real repositories (in-memory SQLite).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import walkaboutRoutes from './walkaboutRoutes.js';
import coverageImportRoutes from './coverageImportRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { uploadTo } from '../test-helpers/coverageImportFixtures.js';
import databaseService from '../../services/database.js';
import { COVERAGE_IMPORT_MAX_PER_SOURCE, COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE } from '../../utils/coverageImport.js';
import type { WalkaboutExportDoc } from '../../types/walkabout.js';

const LAT = 40.1;
const LON = -105.1;
const OK_NUM = 0xaabbccdd;
const HIDDEN_NUM = 0xaabb0002;
const GONE_NUM = 0xaabb0003;
const MC_SRC = 'wk-x-mc';
const MQTT_SRC = 'wk-x-mqtt';
const idOf = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

describe('walkabout export and import (#6573)', () => {
  let h: RouteTestHarness;
  let start: number;
  let seq = 0;
  let smpA = 0;
  const wk = (src: string, p: string) => `/api/sources/${src}/walkabout${p}`;
  const impUrl = (src: string) => `/api/sources/${src}/coverage/imports`;

  const rx = (sourceId: string, sessionId: string, o: Record<string, unknown> = {}) =>
    h.db.coverageWalkabout.recordReception({
      sessionId, sourceId, protocol: 'meshtastic', creditedKey: idOf(OK_NUM), creditedNodeNum: OK_NUM,
      creditKind: 'direct', hopsAway: 0, packetKey: `0000abcd:${seq++}`, snr: 3, rssi: -90, heardAt: start + 1000,
      sampleId: smpA, latitude: LAT, longitude: LON, accuracyM: 5, sampleAgeMs: 500, ...o,
    } as never);

  beforeEach(async () => {
    start = Date.now() - 3_600_000;
    h = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/sources/:id/walkabout', walkaboutRoutes);
        app.use('/api/sources/:id/coverage/imports', coverageImportRoutes);
      },
    });
    for (const [id, type] of [[MC_SRC, 'meshcore'], [MQTT_SRC, 'mqtt_broker']] as const) {
      await h.db.sources.deleteSource(id).catch(() => {});
      await h.db.sources.createSource({ id, name: id, type, config: {}, enabled: true });
    }
    const repo = h.db.coverageWalkabout;
    for (const [src, id] of [[h.sourceA, 'sa'], [h.sourceB, 'sb']] as const) {
      await repo.createSession({ id, sourceId: src, name: `walk ${id}`, startedAt: start, startedBy: null });
      await repo.endSession(src, id, start + 600_000, 'user');
    }
    const node = (nodeNum: number, o: Record<string, unknown>) =>
      h.db.nodes.upsertNode({ nodeNum, nodeId: idOf(nodeNum), channel: 0, lastHeard: Math.floor(Date.now() / 1000), ...o } as never, h.sourceA);
    await node(OK_NUM, { longName: 'Alpha', shortName: 'AL' });
    await node(HIDDEN_NUM, { longName: 'Hidden', shortName: 'HD', hideFromMap: true });
    smpA = (await repo.insertSample({
      sessionId: 'sa', sourceId: h.sourceA, latitude: LAT, longitude: LON, accuracyM: 5,
      deviceFixAt: start, fixAt: start + 500, receivedAt: start + 600,
    })).id;
    await repo.insertSample({
      sessionId: 'sa', sourceId: h.sourceA, latitude: 40.2, longitude: -105.2, accuracyM: 7.5,
      deviceFixAt: start + 5000, fixAt: start + 5500, receivedAt: start + 5600,
    });
    await rx(h.sourceA, 'sa');
    await rx(h.sourceA, 'sa', { snr: -4.25, heardAt: start + 2000, creditKind: 'relay', hopsAway: 2 });
    await rx(h.sourceA, 'sa', { creditedKey: idOf(HIDDEN_NUM), creditedNodeNum: HIDDEN_NUM, snr: 9 });
    await rx(h.sourceA, 'sa', { creditedKey: idOf(GONE_NUM), creditedNodeNum: GONE_NUM, snr: 8 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of [h.sourceA, h.sourceB, MC_SRC, MQTT_SRC]) {
      await databaseService.coverageImports.deleteForSource(s).catch(() => {});
      await h.db.coverageWalkabout.deleteForSource(s).catch(() => {});
    }
    await h.db.sources.deleteSource(MC_SRC).catch(() => {});
    await h.db.sources.deleteSource(MQTT_SRC).catch(() => {});
    await h.cleanup();
  });

  const exportAs = async (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>, src = h.sourceA, id = 'sa') =>
    agent.get(wk(src, `/sessions/${id}/export`));

  describe('export', () => {
    it('anonymous gets 401', async () => {
      const agent = await h.loginAs(null);
      expect((await exportAs(agent)).status).toBe(401);
    });

    it('nodes:read on A exports A, is 403 on B, and 404s a B session under A', async () => {
      await h.grant(h.limited.id, 'nodes', 'read', h.sourceA);
      const agent = await h.loginAs(h.limited);
      expect((await exportAs(agent)).status).toBe(200);
      expect((await exportAs(agent, h.sourceB, 'sb')).status).toBe(403);
      const cross = await exportAs(agent, h.sourceA, 'sb');
      expect(cross.status).toBe(404);
      expect(cross.body).toMatchObject({ success: false, code: 'WALKABOUT_NOT_FOUND' });
    });

    it('admin: lossless shape; hidden and pruned nodes dropped and counted; no source or user ids', async () => {
      const admin = await h.loginAs(h.admin);
      const res = await exportAs(admin);
      expect(res.status).toBe(200);
      const doc = res.body.data as WalkaboutExportDoc;
      expect(doc.meshmonitor).toMatchObject({ format: 'meshmonitor-walkabout', version: 1, hiddenReceptionCount: 2, truncated: false });
      expect(Object.keys(res.body.data)[0]).toBe('meshmonitor');
      expect(doc.sessions).toHaveLength(1);
      const s = doc.sessions[0];
      expect(s).toMatchObject({ name: 'walk sa', startedAt: start, endedAt: start + 600_000, endReason: 'user' });
      expect(s.samples).toHaveLength(2);
      expect(s.samples[0]).toEqual({
        id: smpA, latitude: LAT, longitude: LON, accuracyM: 5, deviceFixAt: start, fixAt: start + 500, receivedAt: start + 600,
      });
      expect(s.receptions).toHaveLength(2);
      expect(s.receptions.map((r) => r.creditedKey)).toEqual([idOf(OK_NUM), idOf(OK_NUM)]);
      expect(s.receptions[1]).toMatchObject({ creditKind: 'relay', hopsAway: 2, snr: -4.25, rssi: -90, sampleId: smpA, longName: 'Alpha' });
      const text = JSON.stringify(doc);
      expect(text).not.toContain(h.sourceA);
      expect(text).not.toContain('startedBy');
      expect(text).not.toContain(idOf(HIDDEN_NUM));
      expect(text).not.toContain(idOf(GONE_NUM));
    });

    it('reader without the map grant gets the track but no receptions; the grant opens them', async () => {
      await h.grant(h.limited.id, 'nodes', 'read', h.sourceA);
      let agent = await h.loginAs(h.limited);
      let doc = (await exportAs(agent)).body.data as WalkaboutExportDoc;
      expect(doc.sessions[0].samples).toHaveLength(2);
      expect(doc.sessions[0].receptions).toHaveLength(0);
      expect(doc.meshmonitor.hiddenReceptionCount).toBe(4);
      await h.grant(h.limited.id, 'channel_0', 'viewOnMap', h.sourceA);
      agent = await h.loginAs(h.limited);
      doc = (await exportAs(agent)).body.data as WalkaboutExportDoc;
      expect(doc.sessions[0].receptions).toHaveLength(2);
      expect(doc.meshmonitor.hiddenReceptionCount).toBe(2);
    });
  });

  describe('import', () => {
    const exportedDoc = async (): Promise<WalkaboutExportDoc> =>
      (await exportAs(await h.loginAs(h.admin))).body.data as WalkaboutExportDoc;
    const upload = async (src: string, doc: unknown, name = 'walk.json') =>
      uploadTo(await h.loginAs(h.admin), src, name, JSON.stringify(doc, null, 2));

    it('round trip: export from A, import into B, export again gives the same rows', async () => {
      const doc = await exportedDoc();
      const res = await upload(h.sourceB, doc);
      expect(res.status).toBe(201);
      expect(res.body.data.import).toMatchObject({
        kind: 'walkabout', format: 'json', status: 'complete', rowCount: 4, insertedCount: 4, duplicateCount: 0, skippedCount: 0,
        firstReceivedAt: start, lastReceivedAt: start + 600_000,
      });
      const [newId] = res.body.data.sessionIds as string[];
      expect(newId).toBeTruthy();

      const admin = await h.loginAs(h.admin);
      const list = await admin.get(wk(h.sourceB, '/sessions'));
      const imported = list.body.data.sessions.find((x: { id: string }) => x.id === newId);
      expect(imported).toMatchObject({
        importId: res.body.data.import.id, isLive: false, endedAt: start + 600_000, sampleCount: 2, receptionCount: 2,
      });
      expect(list.body.data.sessions.find((x: { id: string }) => x.id === 'sb').importId).toBeNull();

      const again = (await exportAs(admin, h.sourceB, newId)).body.data as WalkaboutExportDoc;
      const strip = (d: WalkaboutExportDoc) => {
        const s = d.sessions[0];
        const order = new Map(s.samples.map((x, i) => [x.id, i]));
        return {
          head: { name: s.name, startedAt: s.startedAt, endedAt: s.endedAt, endReason: s.endReason },
          samples: s.samples.map(({ id: _id, ...rest }) => rest),
          // Names come from the target's node table; the unknown node has none there.
          receptions: s.receptions.map(({ sampleId, longName: _l, shortName: _s, ...rest }) => ({
            ...rest, sample: sampleId == null ? null : order.get(sampleId),
          })),
        };
      };
      expect(strip(again)).toEqual(strip(doc));
      expect(again.meshmonitor.hiddenReceptionCount).toBe(0);

      const dup = await upload(h.sourceB, doc);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('IMPORT_DUPLICATE_FILE');
    });

    it('imported rows of nodes unknown on the target need the base map grant', async () => {
      const res = await upload(h.sourceB, await exportedDoc());
      const [newId] = res.body.data.sessionIds as string[];
      await h.grant(h.limited.id, 'nodes', 'read', h.sourceB);
      let agent = await h.loginAs(h.limited);
      let doc = (await exportAs(agent, h.sourceB, newId)).body.data as WalkaboutExportDoc;
      expect(doc.sessions[0].receptions).toHaveLength(0);
      expect(doc.meshmonitor.hiddenReceptionCount).toBe(2);
      await h.grant(h.limited.id, 'channel_0', 'viewOnMap', h.sourceB);
      agent = await h.loginAs(h.limited);
      doc = (await exportAs(agent, h.sourceB, newId)).body.data as WalkaboutExportDoc;
      expect(doc.sessions[0].receptions).toHaveLength(2);
      const cells = await agent.get(wk(h.sourceB, `/cells?sessionId=${newId}`));
      expect(cells.body.data.hiddenReceptionCount).toBe(0);
      expect(cells.body.data.cells.some((c: { receptionCount: number }) => c.receptionCount > 0)).toBe(true);
    });

    it('an imported row of a node hidden on the target stays hidden, even for admin', async () => {
      const doc = await exportedDoc();
      doc.sessions[0].receptions = doc.sessions[0].receptions.map((r) => ({
        ...r, creditedKey: idOf(HIDDEN_NUM), creditedNodeNum: HIDDEN_NUM,
      }));
      const res = await upload(h.sourceA, doc, 'hidden.json');
      expect(res.status).toBe(201);
      const [newId] = res.body.data.sessionIds as string[];
      const again = (await exportAs(await h.loginAs(h.admin), h.sourceA, newId)).body.data as WalkaboutExportDoc;
      expect(again.sessions[0].receptions).toHaveLength(0);
      expect(again.meshmonitor.hiddenReceptionCount).toBe(2);
    });

    it('an imported session is deleted with its import, never on its own', async () => {
      const res = await upload(h.sourceB, await exportedDoc());
      const importId = res.body.data.import.id as string;
      const [newId] = res.body.data.sessionIds as string[];
      const admin = await h.loginAs(h.admin);
      const del = await admin.delete(wk(h.sourceB, `/sessions/${newId}`));
      expect(del.status).toBe(409);
      expect(del.body).toMatchObject({ code: 'WALKABOUT_IMPORTED', importId });
      expect((await admin.delete(`${impUrl(h.sourceB)}/${importId}`)).status).toBe(200);
      expect(await h.db.coverageWalkabout.getSession(h.sourceB, newId)).toBeNull();
      expect(await h.db.coverageWalkabout.listSamples(h.sourceB, newId, 10)).toHaveLength(0);
      expect(await h.db.coverageWalkabout.listReceptions(h.sourceB, newId, 10)).toHaveLength(0);
      // The live session on B is untouched.
      expect(await h.db.coverageWalkabout.getSession(h.sourceB, 'sb')).not.toBeNull();
    });

    it('nodes:read cannot import; a write grant on A does not open B', async () => {
      const doc = await exportedDoc();
      await h.grant(h.limited.id, 'nodes', 'read', h.sourceB);
      await h.grant(h.limited.id, 'nodes', 'write', h.sourceA);
      const agent = await h.loginAs(h.limited);
      const res = await uploadTo(agent, h.sourceB, 'w.json', JSON.stringify(doc));
      expect(res.status).toBe(403);
    });

    it('invalid fields reject the whole file and write nothing', async () => {
      const doc = await exportedDoc();
      (doc.sessions[0].samples[0] as unknown as Record<string, unknown>).latitude = 91;
      (doc.sessions[0].receptions[0] as unknown as Record<string, unknown>).creditKind = 'maybe';
      const res = await upload(h.sourceB, doc);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_INVALID_ROWS');
      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
        expect.arrayContaining(['samples[0].latitude', 'receptions[0].creditKind']),
      );
      expect(await databaseService.coverageImports.countImports(h.sourceB)).toBe(0);
    });

    it('a file over the row cap is refused before any write', async () => {
      const doc = await exportedDoc();
      const s = doc.sessions[0].samples[0];
      doc.sessions[0].samples = Array.from({ length: 10_001 }, (_, i) => ({ ...s, id: i + 1000 }));
      doc.sessions[0].receptions = [];
      const res = await upload(h.sourceB, doc);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_TOO_MANY_ROWS');
      expect(await databaseService.coverageImports.countImports(h.sourceB)).toBe(0);
    });

    it('per-source caps: batches and rows (walkabout rows count with coverage rows)', async () => {
      const doc = await exportedDoc();
      vi.spyOn(databaseService.coverageImports, 'countImports').mockResolvedValueOnce(COVERAGE_IMPORT_MAX_PER_SOURCE);
      let res = await upload(h.sourceB, doc);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IMPORT_LIMIT_REACHED');
      vi.spyOn(databaseService.coverageWalkabout, 'countImportedRows').mockResolvedValueOnce(COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE - 3);
      res = await upload(h.sourceB, doc);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IMPORT_LIMIT_REACHED');
      expect(await databaseService.coverageImports.countImports(h.sourceB)).toBe(0);
    });

    it('refuses a source walkabout cannot run on, and a file with only the other protocol', async () => {
      const doc = await exportedDoc();
      let res = await upload(MQTT_SRC, doc);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_SOURCE_UNSUPPORTED');
      res = await upload(MC_SRC, doc);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_NO_MATCHING_ROWS');
    });

    it('a deleted source takes its imported sessions with it', async () => {
      const res = await upload(h.sourceB, await exportedDoc());
      const [newId] = res.body.data.sessionIds as string[];
      await databaseService.coverageImports.deleteForSource(h.sourceB);
      expect(await h.db.coverageWalkabout.getSession(h.sourceB, newId)).toBeNull();
      expect(await h.db.coverageWalkabout.getSession(h.sourceB, 'sb')).not.toBeNull();
    });
  });
});
