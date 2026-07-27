/**
 * ATAK Contacts Routes — per-source permission isolation tests (Phase 2, #3691).
 *
 * Uses the real-middleware harness (`createRouteTestApp`) rather than mocking
 * the DatabaseService singleton, so `requirePermission`/`checkPermissionAsync`
 * exercise real SQL. The route reuses the existing per-source `nodes:read`
 * permission (no new resource) — see ATAK_COT_PHASE2_SPEC.md §1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import atakRoutes from './atakRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { ATAK_CONTACT_STALE_MS } from '../services/atakContactService.js';
import type { AtakContactRow } from '../../db/repositories/atakContacts.js';

function makeContact(sourceId: string, overrides: Partial<AtakContactRow> = {}): AtakContactRow {
  const now = Date.now();
  return {
    uid: 'EUD-001',
    sourceId,
    nodeNum: 0x1111,
    callsign: 'ALPHA-1',
    deviceCallsign: 'EUD-001',
    team: 9,
    role: 1,
    battery: 80,
    latitude: 37.1,
    longitude: -122.5,
    altitude: 10,
    speed: 1,
    course: 90,
    lastSeen: now,
    createdAt: now,
    ...overrides,
  };
}

describe('atakRoutes — per-source permission isolation', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/atak', atakRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.atakContacts.deleteContactsForSource(harness.sourceA).catch(() => {});
    await harness.db.atakContacts.deleteContactsForSource(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('anonymous with no nodes:read grant → denied on GET /contacts', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get(`/sources/${harness.sourceA}/atak/contacts`);
    expect([401, 403]).toContain(res.status);
  });

  it('limited user without any grant → 403 on GET /contacts', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/sources/${harness.sourceA}/atak/contacts`);
    expect(res.status).toBe(403);
  });

  describe('with nodes:read granted on sourceA only', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await harness.db.atakContacts.upsertContact(makeContact(harness.sourceA, { uid: 'EUD-A', nodeNum: 1 }));
      await harness.db.atakContacts.upsertContact(makeContact(harness.sourceB, { uid: 'EUD-B', nodeNum: 2 }));
    });

    it('GET /contacts on sourceA → 200 with success envelope, sees only sourceA rows', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/atak/contacts`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].uid).toBe('EUD-A');
      expect(res.body.data[0].sourceId).toBe(harness.sourceA);
    });

    it('GET /contacts on sourceB (no grant there) → 403 — grant on sourceA does not open sourceB', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceB}/atak/contacts`);
      expect(res.status).toBe(403);
    });

    it('decorates a fresh contact with stale: false', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/atak/contacts`);
      expect(res.body.data[0].stale).toBe(false);
    });

    it('decorates a contact whose lastSeen exceeds the stale window with stale: true', async () => {
      await harness.db.atakContacts.upsertContact(
        makeContact(harness.sourceA, {
          uid: 'EUD-A',
          nodeNum: 1,
          lastSeen: Date.now() - ATAK_CONTACT_STALE_MS - 1000,
        }),
      );

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/sources/${harness.sourceA}/atak/contacts`);
      expect(res.body.data[0].stale).toBe(true);
    });
  });

  it('admin bypasses grants entirely (real admin bypass)', async () => {
    await harness.db.atakContacts.upsertContact(makeContact(harness.sourceA, { uid: 'EUD-ADMIN', nodeNum: 3 }));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/sources/${harness.sourceA}/atak/contacts`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.some((c: AtakContactRow) => c.uid === 'EUD-ADMIN')).toBe(true);
  });
});
