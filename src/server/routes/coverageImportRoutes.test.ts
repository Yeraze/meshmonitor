/**
 * Coverage import routes (#5891 Phase 3 WP3): permission matrix, error codes,
 * caps, protocol rules, dedupe and delete. Real-middleware harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import coverageImportRoutes, { coverageImportLimits } from './coverageImportRoutes.js';
import coverageRoutes from './coverageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { COVERAGE_IMPORT_MAX_BYTES, COVERAGE_IMPORT_MAX_PER_SOURCE } from '../../utils/coverageImport.js';
import { csvOf, geoOf, mcDto, mtDto, uploadTo } from '../test-helpers/coverageImportFixtures.js';

const MC_SRC = 'rt-source-mc';
const RET_SRC = 'rt-source-ret';

describe('coverage import routes (#5891 P3)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/sources/:id/coverage/imports', coverageImportRoutes);
        app.use('/api/analysis/coverage', coverageRoutes);
      },
    });
    for (const [id, type] of [[MC_SRC, 'meshcore'], [RET_SRC, 'reticulum']] as const) {
      await harness.db.sources.deleteSource(id).catch(() => {});
      await harness.db.sources.createSource({ id, name: id, type, config: {}, enabled: true });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    coverageImportLimits.maxBytes = COVERAGE_IMPORT_MAX_BYTES;
    for (const id of [harness.sourceA, harness.sourceB, MC_SRC, RET_SRC]) {
      await databaseService.coverageImports.deleteForSource(id).catch(() => {});
      await databaseService.coverageReceptions.deleteForSource(id).catch(() => {});
    }
    await harness.db.sources.deleteSource(MC_SRC).catch(() => {});
    await harness.db.sources.deleteSource(RET_SRC).catch(() => {});
    await harness.cleanup();
  });

  /** One permission row per (user, resource, source): flags share it. */
  const perm = (
    sourceId: string,
    flags: { read?: boolean; write?: boolean },
    resource = 'nodes',
  ) =>
    harness.db.auth.createPermission({
      userId: harness.limited.id, resource, canRead: !!flags.read, canWrite: !!flags.write,
      canViewOnMap: false, sourceId, grantedAt: Date.now(), grantedBy: null,
    });
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => mtDto(from + i));
  const importsUrl = (id: string) => `/api/sources/${id}/coverage/imports`;
  const countRows = (id: string) => databaseService.coverageReceptions.countImportedRows(id);

  describe('permissions', () => {
    it('rejects anonymous callers', async () => {
      const agent = await harness.loginAs(null);
      expect((await agent.get(importsUrl(harness.sourceA))).status).toBe(401);
      expect((await uploadTo(agent, harness.sourceA, 'a.csv', csvOf(rows(1)))).status).toBe(401);
      expect((await agent.delete(`${importsUrl(harness.sourceA)}/x`)).status).toBe(401);
    });

    it('nodes:read lists but cannot import or delete', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const list = await agent.get(importsUrl(harness.sourceA));
      expect(list.status).toBe(200);
      expect(list.body.data.imports).toEqual([]);
      expect((await uploadTo(agent, harness.sourceA, 'a.csv', csvOf(rows(1)))).status).toBe(403);
      expect((await agent.delete(`${importsUrl(harness.sourceA)}/x`)).status).toBe(403);
    });

    it('a grant on source B does not open source A', async () => {
      await perm(harness.sourceB, { read: true, write: true });
      const admin = await harness.loginAs(harness.admin);
      const made = await uploadTo(admin, harness.sourceA, 'a.csv', csvOf(rows(2)));
      expect(made.status).toBe(201);

      const agent = await harness.loginAs(harness.limited);
      expect((await uploadTo(agent, harness.sourceA, 'b.csv', csvOf(rows(2, 10)))).status).toBe(403);
      expect((await agent.get(importsUrl(harness.sourceA))).status).toBe(403);
      // Deleting A's import through B's URL is a 404, and the import survives.
      const del = await agent.delete(`${importsUrl(harness.sourceB)}/${made.body.data.import.id}`);
      expect(del.status).toBe(404);
      expect(del.body.code).toBe('IMPORT_NOT_FOUND');
      expect(await databaseService.coverageImports.getImport(harness.sourceA, made.body.data.import.id)).not.toBeNull();
    });

    it('nodes:write imports, lists, and deletes (any import on the source)', async () => {
      await perm(harness.sourceA, { read: true, write: true });
      const admin = await harness.loginAs(harness.admin);
      const made = await uploadTo(admin, harness.sourceA, 'a.csv', csvOf(rows(2)));
      const agent = await harness.loginAs(harness.limited);
      const list = await agent.get(importsUrl(harness.sourceA));
      expect(list.body.data.imports[0]).toMatchObject({ id: made.body.data.import.id, importedByMe: false });
      expect((await agent.delete(`${importsUrl(harness.sourceA)}/${made.body.data.import.id}`)).status).toBe(200);
    });
  });

  describe('upload', () => {
    it('imports a CSV and reports counts (envelope + DTO shape)', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'walk.csv', csvOf(rows(3)));
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.import).toMatchObject({
        sourceId: harness.sourceA, kind: 'coverage_report', format: 'csv', filename: 'walk.csv',
        status: 'complete', rowCount: 3, insertedCount: 3, duplicateCount: 0, skippedCount: 0,
        importedByMe: true, sourceTruncated: false,
      });
      expect(res.body.data.import).not.toHaveProperty('importedBy');
      expect(res.body.data.import).not.toHaveProperty('fileSha256');
      expect(res.body.data.skipped).toMatchObject({ protocolMismatch: 0, gapFeatures: 0 });
      expect(await countRows(harness.sourceA)).toBe(3);
    });

    it('lists newest first', async () => {
      const admin = await harness.loginAs(harness.admin);
      await uploadTo(admin, harness.sourceA, 'first.csv', csvOf(rows(1)));
      await new Promise((r) => setTimeout(r, 5));
      await uploadTo(admin, harness.sourceA, 'second.csv', csvOf(rows(1, 5)));
      const list = await admin.get(importsUrl(harness.sourceA));
      expect(list.body.data.imports.map((i: any) => i.filename)).toEqual(['second.csv', 'first.csv']);
    });

    it('accepts a body over the harness JSON limit (raw parser, not express.json)', async () => {
      const text = csvOf(rows(700));
      expect(text.length).toBeGreaterThan(100 * 1024);
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'big.csv', text);
      expect(res.status).toBe(201);
      expect(res.body.data.import.insertedCount).toBe(700);
    });

    it('rejects a non octet-stream content type with 415', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin
        .post(importsUrl(harness.sourceA))
        .set('Content-Type', 'application/json')
        .set('X-Filename', 'a.csv')
        .send({ a: 1 });
      expect(res.status).toBe(415);
      expect(res.body.code).toBe('IMPORT_BAD_CONTENT_TYPE');
    });

    it('rejects a body over the byte cap with a 413 envelope', async () => {
      coverageImportLimits.maxBytes = 1000;
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'a.csv', csvOf(rows(20)));
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ success: false, code: 'IMPORT_TOO_LARGE' });
    });

    it('rejects a missing or unusable filename', async () => {
      const admin = await harness.loginAs(harness.admin);
      const none = await admin
        .post(importsUrl(harness.sourceA))
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(csvOf(rows(1))));
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('IMPORT_BAD_FILENAME');
      expect((await uploadTo(admin, harness.sourceA, 'notes.txt', csvOf(rows(1)))).body.code).toBe('IMPORT_BAD_FILENAME');
      const badEnc = await admin
        .post(importsUrl(harness.sourceA))
        .set('Content-Type', 'application/octet-stream')
        .set('X-Filename', '%E0%A4%A')
        .send(Buffer.from('x'));
      expect(badEnc.body.code).toBe('IMPORT_BAD_FILENAME');
    });

    it('404 for an unknown source', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, 'no-such-source', 'a.csv', csvOf(rows(1)));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SOURCE_NOT_FOUND');
    });

    it('rejects a reticulum target', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, RET_SRC, 'a.csv', csvOf(rows(1)));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_SOURCE_UNSUPPORTED');
    });
  });

  describe('validation', () => {
    it('a bad row writes nothing and names the row and field', async () => {
      const items = [mtDto(0), mtDto(1, { latitude: 123 }), mtDto(2)];
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'bad.csv', csvOf(items));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'IMPORT_INVALID_ROWS' });
      expect(res.body.errors[0]).toMatchObject({ field: 'latitude' });
      expect(typeof res.body.errors[0].row).toBe('number');
      expect(res.body.errorCount).toBeGreaterThan(0);
      expect(await databaseService.coverageImports.countImports(harness.sourceA)).toBe(0);
      expect(await countRows(harness.sourceA)).toBe(0);
    });

    it('a wrong CSV header is a schema mismatch', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'x.csv', 'a,b,c\r\n1,2,3');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_SCHEMA_MISMATCH');
    });

    it('GeoJSON without the meshmonitor marker is rejected', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'x.geojson', JSON.stringify({ type: 'FeatureCollection', features: [] }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_NOT_MESHMONITOR');
    });

    it('non UTF-8 bytes are an unsupported file', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'x.csv', Buffer.from([0xff, 0xfe, 0xfd, 0x80]));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_UNSUPPORTED_FILE');
    });
  });

  describe('protocol rules', () => {
    it('skips rows of the other protocol and counts them', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceB, 'mixed.csv', csvOf([mtDto(0), mtDto(1), mtDto(2), mcDto(3), mcDto(4)]));
      expect(res.status).toBe(201);
      expect(res.body.data.import).toMatchObject({ insertedCount: 3, skippedCount: 2 });
      expect(res.body.data.skipped.protocolMismatch).toBe(2);
      const mc = await uploadTo(admin, MC_SRC, 'mixed.csv', csvOf([mtDto(0), mtDto(1), mcDto(3)]));
      expect(mc.body.data.import.insertedCount).toBe(1);
    });

    it('a file with no rows for the target protocol is rejected', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'mc.csv', csvOf([mcDto(0), mcDto(1)]));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IMPORT_NO_MATCHING_ROWS');
      expect(await databaseService.coverageImports.countImports(harness.sourceA)).toBe(0);
    });
  });

  describe('dedupe', () => {
    it('the same file twice is a 409 naming the first import', async () => {
      const admin = await harness.loginAs(harness.admin);
      const text = csvOf(rows(2));
      const first = await uploadTo(admin, harness.sourceA, 'a.csv', text);
      const again = await uploadTo(admin, harness.sourceA, 'renamed.csv', text);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        code: 'IMPORT_DUPLICATE_FILE', importId: first.body.data.import.id, filename: 'a.csv',
      });
      // The same bytes on another source are a fresh import.
      expect((await uploadTo(admin, harness.sourceB, 'a.csv', text)).status).toBe(201);
    });

    it('overlapping files insert only new rows', async () => {
      const admin = await harness.loginAs(harness.admin);
      const items = rows(4);
      await uploadTo(admin, harness.sourceA, 'a.csv', csvOf(items));
      const res = await uploadTo(admin, harness.sourceA, 'a.geojson', geoOf(items));
      expect(res.status).toBe(201);
      expect(res.body.data.import).toMatchObject({ insertedCount: 0, duplicateCount: 4 });
      expect(await countRows(harness.sourceA)).toBe(4);
    });
  });

  describe('caps', () => {
    const fillBatches = async (sourceId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await databaseService.coverageImports.createImport({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          sourceId, kind: 'coverage_report', format: 'csv', filename: `f${i}.csv`,
          fileSha256: `${i}`.padStart(64, '0'), importedBy: null, importedAt: Date.now(), rowCount: 0,
        });
      }
    };

    it('refuses the 51st import on a source', async () => {
      await fillBatches(harness.sourceA, COVERAGE_IMPORT_MAX_PER_SOURCE);
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'a.csv', csvOf(rows(1)));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IMPORT_LIMIT_REACHED');
    });

    it('refuses an import that would pass the row cap', async () => {
      vi.spyOn(databaseService.coverageReceptions, 'countImportedRows').mockResolvedValue(199_999);
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'a.csv', csvOf(rows(2)));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IMPORT_LIMIT_REACHED');
      expect(await databaseService.coverageImports.countImports(harness.sourceA)).toBe(0);
    });

    it('two concurrent uploads cannot both take the last batch slot', async () => {
      await fillBatches(harness.sourceA, COVERAGE_IMPORT_MAX_PER_SOURCE - 1);
      const admin = await harness.loginAs(harness.admin);
      const [a, b] = await Promise.all([
        uploadTo(admin, harness.sourceA, 'a.csv', csvOf(rows(2))),
        uploadTo(admin, harness.sourceA, 'b.csv', csvOf(rows(2, 10))),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await databaseService.coverageImports.countImports(harness.sourceA)).toBe(COVERAGE_IMPORT_MAX_PER_SOURCE);
    });
  });

  describe('failure cleanup', () => {
    it('deletes the partial batch when the insert fails', async () => {
      vi.spyOn(databaseService.coverageReceptions, 'insertImportedRows').mockRejectedValue(new Error('boom'));
      const admin = await harness.loginAs(harness.admin);
      const res = await uploadTo(admin, harness.sourceA, 'a.csv', csvOf(rows(2)));
      expect(res.status).toBe(500);
      expect(await databaseService.coverageImports.countImports(harness.sourceA)).toBe(0);
    });
  });

  describe('delete', () => {
    it('removes the import and its rows, never live rows', async () => {
      await databaseService.coverageReceptions.recordReception({
        sourceId: harness.sourceA, protocol: 'meshtastic', receiverKind: 'local', receiverId: '!00000001',
        senderId: '!00000002', packetKey: '77', pathKey: 'r0:h0', latitude: 1, longitude: 2, receivedAt: Date.now(),
      });
      const admin = await harness.loginAs(harness.admin);
      const made = await uploadTo(admin, harness.sourceA, 'a.csv', csvOf(rows(3)));
      expect(await countRows(harness.sourceA)).toBe(3);
      const del = await admin.delete(`${importsUrl(harness.sourceA)}/${made.body.data.import.id}`);
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ success: true });
      expect(await countRows(harness.sourceA)).toBe(0);
      expect(await databaseService.coverageImports.countImports(harness.sourceA)).toBe(0);
      const live = await databaseService.coverageReceptions.getReceptions({
        sourceIds: [harness.sourceA], sinceMs: 0, untilMs: Date.now() + 1000, pageSize: 50,
      });
      expect(live.items).toHaveLength(1);
    });

    it('404 for an unknown import', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.delete(`${importsUrl(harness.sourceA)}/nope`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('IMPORT_NOT_FOUND');
    });
  });
});
