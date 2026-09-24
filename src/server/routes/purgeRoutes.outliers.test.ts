/**
 * purgeRoutes — telemetry outlier purge (#5333).
 *
 * Real-middleware harness (createRouteTestApp): real session + requireAdmin +
 * the live :memory: singleton, so the rows analysed and deleted are real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import purgeRoutes from './purgeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';

const NODE_ID = '!0a0b0c0d';
const NODE_NUM = 0x0a0b0c0d;
const OTHER_NODE_ID = '!0a0b0c0e';
const OTHER_NODE_NUM = 0x0a0b0c0e;
const TYPE = 'temperature';
const BASE_TS = 1_760_000_000_000;

/** 20 normal readings (median 20, MAD 0.5) plus one 1000 °C spike. */
const NORMAL = [19.5, 20, 20.5, 20, 19.5, 20, 20.5, 20, 19.5, 20, 20.5, 20, 19.5, 20, 20.5, 20, 19.5, 20, 20.5, 20];

describe('POST /purge/telemetry/outliers (#5333)', () => {
  let harness: RouteTestHarness;

  const seed = async (sourceId: string, values: number[], nodeId = NODE_ID, nodeNum = NODE_NUM, type = TYPE) => {
    let i = 0;
    for (const value of values) {
      const ts = BASE_TS + i++ * 60_000;
      await harness.db.telemetry.insertTelemetry(
        { nodeId, nodeNum, telemetryType: type, timestamp: ts, value, unit: '°C', createdAt: ts },
        sourceId,
      );
    }
  };

  const values = async (sourceId: string, nodeId = NODE_ID, type = TYPE) => {
    const rows = await harness.db.telemetry.getTelemetrySeriesForOutlierScan(sourceId, type, nodeId, Number.MAX_SAFE_INTEGER);
    return rows.map(r => r.value);
  };

  const auditEntries = async () => {
    // auditLogAsync is fire-and-forget in the route; poll briefly for it.
    for (let i = 0; i < 40; i++) {
      const rows = await harness.db.auth.getAuditLogEntries(50, 0);
      const hits = rows.filter((r: { action: string }) => r.action === 'telemetry_outliers_purged');
      if (hits.length > 0) return hits;
      await new Promise(r => setTimeout(r, 25));
    }
    return [];
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/purge', purgeRoutes) });
  });

  afterEach(async () => {
    await harness.db.telemetry.deleteTelemetryByNode(NODE_NUM, ALL_SOURCES);
    await harness.db.telemetry.deleteTelemetryByNode(OTHER_NODE_NUM, ALL_SOURCES);
    await harness.cleanup();
  });

  it('preview reports the spike for an admin and deletes nothing', async () => {
    await seed(harness.sourceA, [...NORMAL, 1000]);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/purge/telemetry/outliers/preview')
      .send({ sourceId: harness.sourceA, telemetryType: TYPE, nodeId: NODE_ID });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.affectedCount).toBe(1);
    expect(d.removedMin).toBe(1000);
    expect(d.removedMax).toBe(1000);
    expect(d.median).toBe(20);
    expect(d.scaleKind).toBe('mad');
    expect(d.points).toHaveLength(1);
    expect(d.points[0]).toMatchObject({ nodeId: NODE_ID, value: 1000, reason: 'auto' });
    expect(typeof d.cutoffId).toBe('number');
    expect(d.fingerprint).toMatch(/^[0-9a-f]{8}$/);

    expect(await values(harness.sourceA)).toHaveLength(21);
  });

  it('purge removes exactly the previewed rows and writes an audit entry', async () => {
    await seed(harness.sourceA, [...NORMAL, 1000]);
    const agent = await harness.loginAs(harness.admin);
    const body = { sourceId: harness.sourceA, telemetryType: TYPE, nodeId: NODE_ID };
    const preview = (await agent.post('/purge/telemetry/outliers/preview').send(body)).body.data;

    const res = await agent
      .post('/purge/telemetry/outliers')
      .send({ ...body, cutoffId: preview.cutoffId, fingerprint: preview.fingerprint });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { deletedCount: 1, nodesAffected: 1 } });

    const left = await values(harness.sourceA);
    expect(left).toHaveLength(20);
    expect(left).not.toContain(1000);

    const audit = await auditEntries();
    expect(audit.length).toBeGreaterThan(0);
    const details = JSON.parse(audit[0].details);
    expect(details).toMatchObject({
      sourceId: harness.sourceA,
      telemetryType: TYPE,
      nodeId: NODE_ID,
      count: 1,
      criteria: { auto: true, k: 6, min: null, max: null },
    });
    expect(audit[0].userId).toBe(harness.admin.id);
  });

  it('rows that arrive after the preview are left alone (cutoff), even if they are outliers', async () => {
    await seed(harness.sourceA, [...NORMAL, 1000]);
    const agent = await harness.loginAs(harness.admin);
    const body = { sourceId: harness.sourceA, telemetryType: TYPE, nodeId: NODE_ID };
    const preview = (await agent.post('/purge/telemetry/outliers/preview').send(body)).body.data;

    // A second spike lands after the preview.
    await harness.db.telemetry.insertTelemetry(
      { nodeId: NODE_ID, nodeNum: NODE_NUM, telemetryType: TYPE, timestamp: BASE_TS + 99 * 60_000, value: 900, createdAt: BASE_TS },
      harness.sourceA,
    );

    const res = await agent
      .post('/purge/telemetry/outliers')
      .send({ ...body, cutoffId: preview.cutoffId, fingerprint: preview.fingerprint });
    expect(res.status).toBe(200);
    expect(res.body.data.deletedCount).toBe(1);
    expect(await values(harness.sourceA)).toContain(900);
    expect(await values(harness.sourceA)).not.toContain(1000);
  });

  it('409 PREVIEW_STALE when the flagged set changed since the preview', async () => {
    await seed(harness.sourceA, [...NORMAL, 1000]);
    const agent = await harness.loginAs(harness.admin);
    const body = { sourceId: harness.sourceA, telemetryType: TYPE, nodeId: NODE_ID };
    const preview = (await agent.post('/purge/telemetry/outliers/preview').send(body)).body.data;

    // Same cutoff, but the user tightened the criteria after previewing.
    const res = await agent
      .post('/purge/telemetry/outliers')
      .send({ ...body, max: 20.2, cutoffId: preview.cutoffId, fingerprint: preview.fingerprint });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREVIEW_STALE');
    expect(await values(harness.sourceA)).toHaveLength(21);
  });

  it('sweep (no nodeId) analyses each node on the source independently', async () => {
    await seed(harness.sourceA, [...NORMAL, 1000]);
    // Other node lives around 60, so 60s are normal there, but a 20 is an outlier.
    await seed(harness.sourceA, [...NORMAL.map(v => v + 40), 20], OTHER_NODE_ID, OTHER_NODE_NUM);
    const agent = await harness.loginAs(harness.admin);
    const body = { sourceId: harness.sourceA, telemetryType: TYPE };
    const preview = (await agent.post('/purge/telemetry/outliers/preview').send(body)).body.data;
    expect(preview.nodesScanned).toBe(2);
    expect(preview.affectedCount).toBe(2);
    expect(preview.nodesAffected).toBe(2);
    expect(preview.median).toBeNull();

    const res = await agent
      .post('/purge/telemetry/outliers')
      .send({ ...body, cutoffId: preview.cutoffId, fingerprint: preview.fingerprint });
    expect(res.body.data.deletedCount).toBe(2);
    expect(await values(harness.sourceA, OTHER_NODE_ID)).not.toContain(20);
  });

  it('purging source A never touches source B (same node + type)', async () => {
    await seed(harness.sourceA, [...NORMAL, 1000]);
    await seed(harness.sourceB, [...NORMAL, 1000]);
    const agent = await harness.loginAs(harness.admin);
    const body = { sourceId: harness.sourceA, telemetryType: TYPE, nodeId: NODE_ID };
    const preview = (await agent.post('/purge/telemetry/outliers/preview').send(body)).body.data;
    await agent.post('/purge/telemetry/outliers').send({ ...body, cutoffId: preview.cutoffId, fingerprint: preview.fingerprint });

    expect(await values(harness.sourceA)).toHaveLength(20);
    expect(await values(harness.sourceB)).toHaveLength(21);
  });

  it('403 for a non-admin, even with telemetry grants', async () => {
    await harness.grant(harness.limited.id, 'info', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const pre = await agent
      .post('/purge/telemetry/outliers/preview')
      .send({ sourceId: harness.sourceA, telemetryType: TYPE });
    expect(pre.status).toBe(403);
    const del = await agent
      .post('/purge/telemetry/outliers')
      .send({ sourceId: harness.sourceA, telemetryType: TYPE, cutoffId: 1, fingerprint: '00000000' });
    expect(del.status).toBe(403);
  });

  it.each([
    [{ telemetryType: TYPE }, 'MISSING_SOURCE_ID'],
    [{ sourceId: 'rt-source-a' }, 'MISSING_TELEMETRY_TYPE'],
    [{ sourceId: 'rt-source-a', telemetryType: TYPE, k: 1 }, 'INVALID_K'],
    [{ sourceId: 'rt-source-a', telemetryType: TYPE, k: 50 }, 'INVALID_K'],
    [{ sourceId: 'rt-source-a', telemetryType: TYPE, min: 10, max: 5 }, 'INVALID_BOUNDS'],
    [{ sourceId: 'rt-source-a', telemetryType: TYPE, max: 'hot' }, 'INVALID_BOUNDS'],
    [{ sourceId: 'rt-source-a', telemetryType: TYPE, auto: false }, 'NO_CRITERIA'],
  ])('preview 400s on %j with %s', async (body, code) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/telemetry/outliers/preview').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code });
  });

  it('404 for an unknown source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/purge/telemetry/outliers/preview')
      .send({ sourceId: 'no-such-source', telemetryType: TYPE });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SOURCE_NOT_FOUND');
  });

  it('purge 400s without the preview cutoff or fingerprint', async () => {
    const agent = await harness.loginAs(harness.admin);
    const base = { sourceId: harness.sourceA, telemetryType: TYPE };
    const noCutoff = await agent.post('/purge/telemetry/outliers').send({ ...base, fingerprint: '00000000' });
    expect(noCutoff.body.code).toBe('INVALID_CUTOFF');
    const noPrint = await agent.post('/purge/telemetry/outliers').send({ ...base, cutoffId: 5 });
    expect(noPrint.body.code).toBe('INVALID_FINGERPRINT');
  });

  it('types endpoint lists the source\'s telemetry types', async () => {
    await seed(harness.sourceA, [1, 2], NODE_ID, NODE_NUM, 'voltage');
    await seed(harness.sourceB, [1], NODE_ID, NODE_NUM, 'pressure');
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/purge/telemetry/outliers/types?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.types).toContain('voltage');
    expect(res.body.data.types).not.toContain('pressure');

    const missing = await agent.get('/purge/telemetry/outliers/types');
    expect(missing.status).toBe(400);
  });
});
