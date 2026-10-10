/**
 * Local map marker routes (#5686) on the real route harness: per-source
 * `waypoints` grants gate every call, another source's grant does not help,
 * anonymous follows the anonymous account's grants, and nothing here can
 * reach a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// Every way a route could reach a radio, spied: none may be touched.
const registryCalls = vi.hoisted(() => ({ getManager: vi.fn(), getAllManagers: vi.fn(() => []) }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: registryCalls }));

import mapMarkerRoutes from './mapMarkerRoutes.js';
import { MAP_MARKERS_PER_SOURCE_MAX } from '../../types/mapMarker.js';

const BODY = { label: 'Ridge', latitude: 28.1, longitude: -81.6, icon: 'antenna', color: 'success' };

describe('map marker routes (#5686)', () => {
  let harness: RouteTestHarness;
  const url = (sourceId: string, suffix = '') => `/api/sources/${sourceId}/markers${suffix}`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app: express.Express) => app.use('/api/sources/:id/markers', mapMarkerRoutes),
    });
    registryCalls.getManager.mockClear();
    registryCalls.getAllManagers.mockClear();
  });

  afterEach(async () => {
    await harness.db.mapMarkers.deleteBySourceId(harness.sourceA);
    await harness.db.mapMarkers.deleteBySourceId(harness.sourceB);
    await harness.cleanup();
  });

  it('read needs waypoints:read on THIS source', async () => {
    await harness.db.mapMarkers.create(harness.sourceA, { ...BODY, description: null, altitude: null } as never, null);
    await harness.grant(harness.limited.id, 'waypoints', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);

    await harness.grant(harness.limited.id, 'waypoints', 'read', harness.sourceA);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ label: 'Ridge', sourceId: harness.sourceA });
  });

  it('write needs waypoints:write on THIS source; read alone cannot create', async () => {
    await harness.grant(harness.limited.id, 'waypoints', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'waypoints', 'write', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(url(harness.sourceA)).send(BODY)).status).toBe(403);

    // One permission row per (user, resource, source): replace read with write.
    await harness.revokeAll(harness.limited.id);
    await harness.grant(harness.limited.id, 'waypoints', 'write', harness.sourceA);
    const created = await agent.post(url(harness.sourceA)).send(BODY);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ label: 'Ridge', createdByUserId: harness.limited.id });

    const id = created.body.data.id;
    const put = await agent.put(url(harness.sourceA, `/${id}`)).send({ ...BODY, label: 'Moved' });
    expect(put.status).toBe(200);
    expect(put.body.data.label).toBe('Moved');
    expect((await agent.delete(url(harness.sourceA, `/${id}`))).status).toBe(200);
    expect((await agent.delete(url(harness.sourceA, `/${id}`))).status).toBe(404);
  });

  it('an id from another source is not found there', async () => {
    const m = await harness.db.mapMarkers.create(harness.sourceA, { ...BODY, description: null, altitude: null } as never, null);
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.put(url(harness.sourceB, `/${m.id}`)).send(BODY)).status).toBe(404);
    expect((await admin.delete(url(harness.sourceB, `/${m.id}`))).status).toBe(404);
    expect((await harness.db.mapMarkers.getById(harness.sourceA, m.id))?.label).toBe('Ridge');
  });

  it('anonymous follows the anonymous account grants', async () => {
    await harness.db.mapMarkers.create(harness.sourceA, { ...BODY, description: null, altitude: null } as never, null);
    await harness.revokeAll(harness.anonymous.id);
    const anon = await harness.loginAs(null);
    expect((await anon.get(url(harness.sourceA))).status).toBe(403);
    await harness.grant(harness.anonymous.id, 'waypoints', 'read', harness.sourceA);
    expect((await anon.get(url(harness.sourceA))).status).toBe(200);
    expect((await anon.post(url(harness.sourceA)).send(BODY)).status).toBe(403);
  });

  it('validates input with codes', async () => {
    const admin = await harness.loginAs(harness.admin);
    const bad = async (body: object) => (await admin.post(url(harness.sourceA)).send(body)).body.code;
    expect(await bad({ ...BODY, label: '' })).toBe('INVALID_LABEL');
    expect(await bad({ ...BODY, label: 'x'.repeat(65) })).toBe('INVALID_LABEL');
    expect(await bad({ ...BODY, latitude: 91 })).toBe('INVALID_POSITION');
    expect(await bad({ ...BODY, longitude: '' })).toBe('INVALID_POSITION');
    expect(await bad({ ...BODY, icon: '<img>' })).toBe('INVALID_ICON');
    expect(await bad({ ...BODY, color: '#ff0000' })).toBe('INVALID_COLOR');
    expect((await admin.get(url('no-such-source'))).status).toBe(404);
  });

  it(`refuses the ${MAP_MARKERS_PER_SOURCE_MAX + 1}th marker on a source`, async () => {
    const count = vi.spyOn(harness.db.mapMarkers, 'countBySource').mockResolvedValue(MAP_MARKERS_PER_SOURCE_MAX);
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post(url(harness.sourceA)).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MARKER_LIMIT_REACHED');
    count.mockRestore();
  });

  it('never touches a source manager: markers are not transmitted', async () => {
    const admin = await harness.loginAs(harness.admin);
    const created = await admin.post(url(harness.sourceA)).send(BODY);
    await admin.get(url(harness.sourceA));
    await admin.put(url(harness.sourceA, `/${created.body.data.id}`)).send(BODY);
    await admin.delete(url(harness.sourceA, `/${created.body.data.id}`));
    expect(registryCalls.getManager).not.toHaveBeenCalled();
    expect(registryCalls.getAllManagers).not.toHaveBeenCalled();

    // Structural: the route module imports nothing that can send.
    const src = readFileSync(fileURLToPath(new URL('./mapMarkerRoutes.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from '\.\.\/sourceManagerRegistry|meshtasticManager|meshcoreManager|waypointService|messageQueue/);
  });
});
