/**
 * GeoJSON Routes — per-overlay "disable click popup" flag (issue #4344)
 *
 * Uses the real-middleware harness (createRouteTestApp) rather than the
 * monkey-patched DatabaseService pattern in geojsonRoutes.test.ts, so the
 * `settings:write` gate on PUT /layers/:id is enforced by real SQL.
 *
 * The GeoJsonService itself is real, backed by a per-test temp directory —
 * the flag's persistence is exercised end to end (HTTP → manifest.json → HTTP).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeoJsonService } from '../services/geojsonService.js';
import { createGeoJsonRouter } from './geojsonRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const VALID_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.4, 37.8] },
      properties: { name: 'Test Point' },
    },
  ],
});

describe('geojsonRoutes — disablePopup flag (#4344)', () => {
  let harness: RouteTestHarness;
  let tmpDir: string;
  let service: GeoJsonService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-popup-route-'));
    service = new GeoJsonService(tmpDir);
    harness = await createRouteTestApp({
      mount: app => app.use('/api/geojson', createGeoJsonRouter(service)),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves disablePopup=false for a freshly uploaded layer', async () => {
    service.addLayer('fresh.geojson', VALID_GEOJSON);

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/geojson/layers');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].disablePopup).toBe(false);
  });

  it('PUT sets disablePopup and the value survives a re-read', async () => {
    const layer = service.addLayer('toggle.geojson', VALID_GEOJSON);
    const agent = await harness.loginAs(harness.admin);

    const put = await agent
      .put(`/api/geojson/layers/${layer.id}`)
      .send({ disablePopup: true });
    expect(put.status).toBe(200);
    expect(put.body.disablePopup).toBe(true);

    const list = await agent.get('/api/geojson/layers');
    expect(list.body[0].disablePopup).toBe(true);

    // And it persisted to the manifest on disk, not just in memory.
    expect(
      new GeoJsonService(tmpDir).getLayers().find(l => l.id === layer.id)?.disablePopup
    ).toBe(true);
  });

  it('PUT can turn disablePopup back off', async () => {
    const layer = service.addLayer('backoff.geojson', VALID_GEOJSON);
    const agent = await harness.loginAs(harness.admin);

    await agent.put(`/api/geojson/layers/${layer.id}`).send({ disablePopup: true });
    const off = await agent
      .put(`/api/geojson/layers/${layer.id}`)
      .send({ disablePopup: false });

    expect(off.status).toBe(200);
    expect(off.body.disablePopup).toBe(false);
  });

  it('a PUT that omits disablePopup leaves it unchanged', async () => {
    const layer = service.addLayer('partial.geojson', VALID_GEOJSON);
    const agent = await harness.loginAs(harness.admin);

    await agent.put(`/api/geojson/layers/${layer.id}`).send({ disablePopup: true });
    const rename = await agent
      .put(`/api/geojson/layers/${layer.id}`)
      .send({ name: 'renamed' });

    expect(rename.status).toBe(200);
    expect(rename.body.name).toBe('renamed');
    expect(rename.body.disablePopup).toBe(true);
  });

  it('rejects the toggle for a user without settings:write', async () => {
    const layer = service.addLayer('denied.geojson', VALID_GEOJSON);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent
      .put(`/api/geojson/layers/${layer.id}`)
      .send({ disablePopup: true });

    expect(res.status).toBe(403);
    expect(service.getLayers()[0].disablePopup).toBe(false);
  });

  it('allows the toggle once settings:write is granted', async () => {
    const layer = service.addLayer('granted.geojson', VALID_GEOJSON);
    await harness.grant(harness.limited.id, 'settings', 'write');
    const agent = await harness.loginAs(harness.limited);

    const res = await agent
      .put(`/api/geojson/layers/${layer.id}`)
      .send({ disablePopup: true });

    expect(res.status).toBe(200);
    expect(res.body.disablePopup).toBe(true);
  });

  it('404s with the shared error envelope for an unknown layer', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .put('/api/geojson/layers/does-not-exist')
      .send({ disablePopup: true });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('GEOJSON_LAYER_NOT_FOUND');
  });

  it('exposes disablePopup to anonymous viewers of a public layer', async () => {
    const layer = service.addLayer('publicpopup.geojson', VALID_GEOJSON);
    const admin = await harness.loginAs(harness.admin);
    await admin
      .put(`/api/geojson/layers/${layer.id}`)
      .send({ publiclyVisible: true, disablePopup: true });

    const anon = await harness.loginAs(null);
    const res = await anon.get('/api/geojson/layers');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].disablePopup).toBe(true);
  });
});
