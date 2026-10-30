/**
 * Legacy session-mount channel-database — permission model tests
 *
 * Converted from the monkey-patch pattern (vi.mock('../../services/database.js')
 * + vi.mock('../auth/authMiddleware.js')) to the real-middleware harness
 * (createRouteTestApp). The harness uses the live DatabaseService singleton with
 * real session + requireAuth + real checkPermissionAsync, seeding per-test
 * permission rows instead of hand-rolling fake implementations.
 *
 * Permission model (global resource — channel_database is NOT source-scoped):
 *   channel_database:read  → list / get (PSK masked) + retroactive-decrypt progress
 *   channel_database:write → create / update / delete / reorder + ACL management
 *
 * Source-isolation note: channel_database is a global-by-design resource
 * (no sourceId column on its permissions). The isolation assertion below
 * therefore proves that the REAL checkPermissionAsync enforces a global
 * grant/no-grant boundary rather than a per-source row boundary.
 * For per-source resource isolation see sourceRoutes.permissions.test.ts.
 *
 * Non-DB service mocks stay: channelDecryptionService and
 * retroactiveDecryptionService would attempt real file/network I/O.
 *
 * See src/server/test-helpers/routeTestApp.ts for the design rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Non-DB service mocks: keep these to avoid real I/O in tests.
vi.mock('../services/channelDecryptionService.js', () => ({
  channelDecryptionService: { invalidateCache: vi.fn() },
}));

vi.mock('../services/retroactiveDecryptionService.js', () => ({
  retroactiveDecryptionService: {
    processForChannel: vi.fn().mockResolvedValue(undefined),
    getProgress: vi.fn().mockReturnValue({ processed: 0, total: 0 }),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

import channelDatabaseRoutes from './channelDatabaseRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// ── shared test fixtures ──────────────────────────────────────────────────────

const fakePsk = Buffer.alloc(16, 0xab).toString('base64');
const channel1 = {
  id: 1,
  name: 'Channel 1',
  psk: fakePsk,
  pskLength: 16,
  description: null,
  isEnabled: true,
  enforceNameValidation: false,
  sortOrder: 0,
  decryptedPacketCount: 0,
  lastDecryptedAt: null,
  createdBy: 1,
  createdAt: 1000,
  updatedAt: 1000,
};

// ── harness wiring ────────────────────────────────────────────────────────────

let harness: RouteTestHarness;

beforeEach(async () => {
  harness = await createRouteTestApp({
    // channelDatabaseRoutes apply requireAuth() internally; the harness mounts
    // optionalAuth() before the router so the session is available, and
    // requireAuth() reads req.session.userId set by loginAs().
    mount: (app) => app.use('/api/channel-database', channelDatabaseRoutes),
  });

  // Spy on channelDatabase repo data methods so tests control returned rows
  // while real checkPermissionAsync enforces access gates.
  vi.spyOn(databaseService.channelDatabase, 'getAllAsync').mockResolvedValue([channel1 as any]);
  vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(channel1 as any);
  vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([]);
  vi.spyOn(databaseService.channelDatabase, 'getPermissionAsync').mockResolvedValue(null);
  vi.spyOn(databaseService.channelDatabase, 'createAsync').mockResolvedValue(42);

  // No channel_database permission grants by default — tests add what they need.
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.cleanup();
});

// ── describe 1: permission isolation (global-resource proof) ─────────────────
//
// channel_database is global — no sourceId scoping on the resource itself.
// The assertions below prove the real checkPermissionAsync enforces the
// grant/no-grant boundary correctly.

describe('permission isolation — global resource (real checkPermissionAsync)', () => {
  it('user WITH global channel_database:read grant can list channels (200)', async () => {
    // Global grant (no sourceId arg → sourceId=NULL row)
    await harness.grant(harness.limited.id, 'channel_database', 'read');
    // Per-entry permission: canRead=true for channel 1
    vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([
      { userId: harness.limited.id, channelDatabaseId: 1, canViewOnMap: false, canRead: true } as any,
    ]);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(200);
  });

  it('user WITHOUT channel_database:read grant is denied (403 — real checkPermissionAsync)', async () => {
    // No grant seeded — real checkPermissionAsync finds no row → false → 403.
    // Previously a `mockResolvedValue(false)` hid any real implementation bug.
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(403);
  });
});

// ── describe 2: GET / permission filtering ───────────────────────────────────

describe('Legacy mount — GET / permission filtering', () => {
  it('admin: returns channels with full PSK', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.data[0].psk).toBeDefined();
  });

  it('non-admin with :read + per-entry canRead: returns entry with masked PSK', async () => {
    await harness.grant(harness.limited.id, 'channel_database', 'read');
    vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([
      { userId: harness.limited.id, channelDatabaseId: 1, canViewOnMap: false, canRead: true } as any,
    ]);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].psk).toBeUndefined();
    // MISC-11 (#6087): masked callers get a constant sentinel, never key bytes.
    expect(res.body.data[0].pskPreview).toBe('(hidden)');
    expect(res.body.data[0].pskPreview).not.toContain('q6ur');
  });

  it('non-admin without :read: returns 403', async () => {
    // No grants for limited — real checkPermissionAsync returns false.
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(403);
  });

  it('non-admin without resource :read but WITH per-entry canRead: returns filtered list (200, masked PSK)', async () => {
    // Regression: the "Virtual Channel Permissions" UI writes only per-entry
    // canRead — it does NOT grant the resource-level channel_database:read. A
    // user granted read on every virtual channel must still be able to list
    // them, otherwise the grant is a silent no-op (the anonymous-MQTT bug).
    // No channel_database:read grant seeded here.
    vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([
      { userId: harness.limited.id, channelDatabaseId: 1, canViewOnMap: false, canRead: true } as any,
    ]);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].id).toBe(1);
    // PSK stays masked — per-entry read never exposes the raw key.
    expect(res.body.data[0].psk).toBeUndefined();
    // MISC-11 (#6087): masked callers get a constant sentinel, never key bytes.
    expect(res.body.data[0].pskPreview).toBe('(hidden)');
  });

  it('non-admin with neither resource :read nor any per-entry canRead: returns 403', async () => {
    // Per-entry row exists but canRead=false → not readable → still 403.
    vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([
      { userId: harness.limited.id, channelDatabaseId: 1, canViewOnMap: false, canRead: false } as any,
    ]);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(403);
  });

  it('ANONYMOUS (unauthenticated) with per-entry canRead: lists entries (200, not 401)', async () => {
    // The read route uses optionalAuth, not requireAuth — an anonymous account
    // with per-entry grants must reach the handler and get its filtered list,
    // not hit a 401 auth wall. This is what populates the frontend Channels tab
    // for anonymous viewers on an MQTT source.
    vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([
      { userId: harness.anonymous.id, channelDatabaseId: 1, canViewOnMap: false, canRead: true } as any,
    ]);

    const agent = await harness.loginAs(null); // unauthenticated → anonymous user
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].psk).toBeUndefined();
    // MISC-11 (#6087): an anonymous caller must not receive even a partial key
    // preview — no first-8-chars oracle, no shared-key fingerprint.
    expect(res.body.data[0].pskPreview).toBe('(hidden)');
    expect(res.body.data[0].pskPreview).not.toContain('q6ur');
  });

  it('ANONYMOUS with no grants: GET / reaches the handler (403), not a 401 auth wall', async () => {
    // getPermissionsForUserAsync default mock returns [] (beforeEach).
    const agent = await harness.loginAs(null);
    const res = await agent.get('/api/channel-database');
    expect(res.status).toBe(403);
  });
});

// ── describe 3: GET /:id permission filtering ─────────────────────────────────

describe('Legacy mount — GET /:id permission filtering', () => {
  it('non-admin with :read + per-entry canRead: returns channel with masked PSK', async () => {
    await harness.grant(harness.limited.id, 'channel_database', 'read');
    vi.spyOn(databaseService.channelDatabase, 'getPermissionAsync').mockResolvedValue(
      { userId: harness.limited.id, channelDatabaseId: 1, canViewOnMap: false, canRead: true } as any
    );

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.data.psk).toBeUndefined();
    // MISC-11 (#6087): masked callers get a constant sentinel, never key bytes.
    expect(res.body.data.pskPreview).toBe('(hidden)');
  });

  it('non-admin with :read but no per-entry row: returns 404', async () => {
    await harness.grant(harness.limited.id, 'channel_database', 'read');
    // getPermissionAsync already mocked to null (beforeEach default)

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database/1');
    expect(res.status).toBe(404);
  });

  it('non-admin WITHOUT resource :read but WITH per-entry canRead: returns entry (200, masked PSK)', async () => {
    // Regression (consistency with GET /): a per-entry canRead grant alone is
    // enough to read the specific entry — no resource-level channel_database:read
    // required. No :read grant seeded here.
    vi.spyOn(databaseService.channelDatabase, 'getPermissionAsync').mockResolvedValue(
      { userId: harness.limited.id, channelDatabaseId: 1, canViewOnMap: false, canRead: true } as any
    );

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database/1');
    expect(res.status).toBe(200);
    expect(res.body.data.psk).toBeUndefined();
    // MISC-11 (#6087): masked callers get a constant sentinel, never key bytes.
    expect(res.body.data.pskPreview).toBe('(hidden)');
  });

  it('non-admin with neither :read nor per-entry canRead: returns 404 (masks existence)', async () => {
    // No grants; getPermissionAsync returns null (beforeEach default). The entry
    // is hidden as 404 rather than 403 so its existence isn't revealed.
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database/1');
    expect(res.status).toBe(404);
  });
});

// ── describe 4: Write endpoints require channel_database:write ────────────────

describe('Legacy mount — Write endpoints require channel_database:write', () => {
  it('POST / → 403 for :read-only user', async () => {
    await harness.grant(harness.limited.id, 'channel_database', 'read');

    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .post('/api/channel-database')
      .send({ name: 'X', psk: fakePsk });
    expect(res.status).toBe(403);
  });

  it('POST / → 201 for non-admin with :write', async () => {
    await harness.grant(harness.limited.id, 'channel_database', 'write');
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(
      { ...channel1, id: 42 } as any
    );

    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .post('/api/channel-database')
      .send({ name: 'X', psk: fakePsk });
    expect(res.status).toBe(201);
  });

  it('admin bypasses write check (real admin bypass via resolveCallerScope)', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(
      { ...channel1, id: 42 } as any
    );

    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/api/channel-database')
      .send({ name: 'AdminChannel', psk: fakePsk });
    expect(res.status).toBe(201);
  });
});

// ── describe 5: AUTHZ-08 (#6072) — per-entry ownership on mutations ───────────
//
// channel_database:write is a flat global grant. Before the fix, ANY write
// holder could overwrite another user's PSK and re-grant another user's ACLs on
// an entry they did not create. These tests pin the ownership boundary:
//   - a non-admin write holder may mutate ONLY entries they created,
//   - an admin may mutate any entry.

describe('AUTHZ-08 — ownership check on channel-database mutations', () => {
  // An entry created by someone OTHER than `harness.limited`.
  const foreignEntry = { ...channel1, createdBy: 999999 };

  beforeEach(async () => {
    // Every test below acts as a non-admin WITH the global write grant — the
    // resource gate passes, so only the new per-row ownership check can deny.
    await harness.grant(harness.limited.id, 'channel_database', 'write');
  });

  it('PUT /:id → 403 when a write holder edits an entry they did not create', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(foreignEntry as any);
    const updateSpy = vi.spyOn(databaseService.channelDatabase, 'updateAsync').mockResolvedValue(undefined as any);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.put('/api/channel-database/1').send({ name: 'hijacked' });
    expect(res.status).toBe(403);
    // The PSK/ACL must be untouched: the handler must bail before writing.
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('DELETE /:id → 403 when a write holder deletes an entry they did not create', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(foreignEntry as any);
    const deleteSpy = vi.spyOn(databaseService.channelDatabase, 'deleteAsync').mockResolvedValue(undefined as any);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete('/api/channel-database/1');
    expect(res.status).toBe(403);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('PUT /:id/permissions/:userId → 403 when a write holder grants ACLs on an entry they did not create', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(foreignEntry as any);
    const setSpy = vi.spyOn(databaseService.channelDatabase, 'setPermissionAsync').mockResolvedValue(undefined as any);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .put(`/api/channel-database/1/permissions/${harness.anonymous.id}`)
      .send({ canViewOnMap: true, canRead: true });
    expect(res.status).toBe(403);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('DELETE /:id/permissions/:userId → 403 when a write holder revokes ACLs on an entry they did not create', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(foreignEntry as any);
    const delPermSpy = vi.spyOn(databaseService.channelDatabase, 'deletePermissionAsync').mockResolvedValue(undefined as any);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.delete(`/api/channel-database/1/permissions/${harness.anonymous.id}`);
    expect(res.status).toBe(403);
    expect(delPermSpy).not.toHaveBeenCalled();
  });

  it('GET /:id/permissions → 403 when a write holder views ACLs of an entry they did not create', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(foreignEntry as any);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/channel-database/1/permissions');
    expect(res.status).toBe(403);
  });

  it('PUT /:id → 200 when the write holder edits an entry THEY created (feature still works)', async () => {
    const ownEntry = { ...channel1, createdBy: harness.limited.id };
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(ownEntry as any);
    const updateSpy = vi.spyOn(databaseService.channelDatabase, 'updateAsync').mockResolvedValue(undefined as any);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.put('/api/channel-database/1').send({ name: 'my own rename' });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalled();
  });

  it('PUT /:id → 200 when an ADMIN edits an entry created by someone else (admin bypass intact)', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getByIdAsync').mockResolvedValue(foreignEntry as any);
    const updateSpy = vi.spyOn(databaseService.channelDatabase, 'updateAsync').mockResolvedValue(undefined as any);

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/api/channel-database/1').send({ name: 'admin rename' });
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalled();
  });
});
