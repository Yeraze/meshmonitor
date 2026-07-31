/**
 * sourceObserverRoutes — key-management route tests (#4457 Phase 1 WP4, spec §8.5)
 *
 * Harness-based (createRouteTestApp): mounts the real `sourceRoutes` router
 * (which mounts `sourceObserverRoutes` under `/:id/observer`) so permission
 * middleware runs for real. Only non-DB collaborators are mocked:
 *   - `sourceManagerRegistry` (fake MeshCore manager for the import flow)
 *   - `MeshCoreObserverKeyStore` singleton, rebuilt per test from
 *     `('test-secret', true)` so envelopes encrypt/decrypt deterministically
 *     without touching the real `SESSION_SECRET` derivation.
 * `databaseService` itself is never mocked — see routeTestApp.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  MeshCoreObserverKeyStore,
  setMeshCoreObserverKeyStoreForTesting,
} from '../services/meshcoreObserverKeyStore.js';

// Deterministic, valid, clamped orlp private key — same recipe as
// meshcoreObserverToken.test.ts (spec §8.3): seed -> SHA-512 -> clamp.
const seed = Buffer.alloc(32, 7);
const h = crypto.createHash('sha512').update(seed).digest();
h[0] &= 248;
h[31] &= 63;
h[31] |= 64;
const PRIV = h.toString('hex');

// Deterministic INVALID (unclamped) fixture — see meshcoreObserverToken.test.ts
// for why a random 64-byte buffer is flaky (~50% pass rate): only byte 31's
// top bit is checked by the orlp WASM, so this fixture sets exactly that bit.
const UNCLAMPED_PRIV = '00'.repeat(31) + 'ff' + '00'.repeat(32);

const mockSourceRegistry = vi.hoisted(() => ({
  getManager: vi.fn(),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockSourceRegistry,
}));

const SOURCE_ID = 'obs-a';

/**
 * `permissions` carries a UNIQUE(user_id, resource, sourceId) index (migration
 * 033) — one row per (user, resource, source) holding all three action flags
 * together. `harness.grant()` inserts a fresh row per call, so two calls for
 * the same resource+source (one for 'read', one for 'write') collide on that
 * unique index. Routes here need both actions on the same source (GET reads,
 * PUT/POST/DELETE write), so grant both in a single row via the repository
 * directly rather than two `harness.grant()` calls.
 */
async function grantReadWrite(harness: RouteTestHarness, userId: number, sourceId: string): Promise<void> {
  await harness.db.auth.createPermission({
    userId,
    resource: 'configuration',
    canRead: true,
    canWrite: true,
    sourceId,
    grantedAt: Date.now(),
    grantedBy: null,
  });
}

describe('sourceObserverRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources', sourceRoutes),
    });
    await harness.db.sources.deleteSource(SOURCE_ID).catch(() => {});
    await harness.db.sources.createSource({
      id: SOURCE_ID,
      name: 'Obs A',
      type: 'meshcore',
      config: {},
      enabled: true,
    });
    await grantReadWrite(harness, harness.limited.id, SOURCE_ID);

    mockSourceRegistry.getManager.mockReset();
    mockSourceRegistry.getManager.mockReturnValue(undefined);
    setMeshCoreObserverKeyStoreForTesting(new MeshCoreObserverKeyStore('test-secret', true));
  });

  afterEach(async () => {
    setMeshCoreObserverKeyStoreForTesting(null);
    await harness.db.sources.deleteSource(SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  function agentFor() {
    return harness.loginAs(harness.limited);
  }

  it('GET /key on an empty source returns stored:false', async () => {
    const agent = await agentFor();
    const res = await agent.get(`/api/sources/${SOURCE_ID}/observer/key`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.stored).toBe(false);
    expect(res.body.data.publicKey).toBeNull();
  });

  it('PUT /key with a valid key stores it, and a follow-up GET agrees', async () => {
    const agent = await agentFor();
    const putRes = await agent.put(`/api/sources/${SOURCE_ID}/observer/key`).send({ privateKey: PRIV });
    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);
    expect(putRes.body.data.stored).toBe(true);
    expect(putRes.body.data.origin).toBe('manual');
    expect(typeof putRes.body.data.publicKey).toBe('string');
    expect(putRes.body.data.publicKey).toHaveLength(64);

    const getRes = await agent.get(`/api/sources/${SOURCE_ID}/observer/key`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.stored).toBe(true);
    expect(getRes.body.data.publicKey).toBe(putRes.body.data.publicKey);
    expect(getRes.body.data.origin).toBe('manual');
  });

  it('PUT /key with 127 hex chars -> 400 INVALID_KEY_LENGTH', async () => {
    const agent = await agentFor();
    const res = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/key`)
      .send({ privateKey: PRIV.slice(0, 127) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_KEY_LENGTH');
  });

  it('PUT /key with 128 non-hex chars -> 400 INVALID_KEY_LENGTH', async () => {
    const agent = await agentFor();
    const res = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/key`)
      .send({ privateKey: 'z'.repeat(128) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_KEY_LENGTH');
  });

  it('PUT /key with unclamped 128-hex -> 400 INVALID_KEY_MATERIAL', async () => {
    const agent = await agentFor();
    const res = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/key`)
      .send({ privateKey: UNCLAMPED_PRIV });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_KEY_MATERIAL');
  });

  it('PUT /key with a non-string privateKey -> 400 INVALID_PARAMETER_TYPE', async () => {
    const agent = await agentFor();
    const res = await agent.put(`/api/sources/${SOURCE_ID}/observer/key`).send({ privateKey: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PARAMETER_TYPE');
  });

  it('POST /key/import with a mocked manager returning a valid key -> 200, origin:device', async () => {
    mockSourceRegistry.getManager.mockReturnValue({
      sourceType: 'meshcore',
      exportPrivateKey: vi.fn().mockResolvedValue(PRIV),
    });
    const agent = await agentFor();
    const res = await agent.post(`/api/sources/${SOURCE_ID}/observer/key/import`);
    expect(res.status).toBe(200);
    expect(res.body.data.stored).toBe(true);
    expect(res.body.data.origin).toBe('device');
  });

  it('POST /key/import with exportPrivateKey -> null returns 409 EXPORT_FAILED', async () => {
    mockSourceRegistry.getManager.mockReturnValue({
      sourceType: 'meshcore',
      exportPrivateKey: vi.fn().mockResolvedValue(null),
    });
    const agent = await agentFor();
    const res = await agent.post(`/api/sources/${SOURCE_ID}/observer/key/import`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXPORT_FAILED');
  });

  it('POST /key/import with no registered manager -> 409 SOURCE_NOT_CONNECTED', async () => {
    mockSourceRegistry.getManager.mockReturnValue(undefined);
    const agent = await agentFor();
    const res = await agent.post(`/api/sources/${SOURCE_ID}/observer/key/import`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
  });

  it('POST /key/import with a manager returning a malformed key -> 502 INVALID_KEY_LENGTH', async () => {
    mockSourceRegistry.getManager.mockReturnValue({
      sourceType: 'meshcore',
      exportPrivateKey: vi.fn().mockResolvedValue('abcd'),
    });
    const agent = await agentFor();
    const res = await agent.post(`/api/sources/${SOURCE_ID}/observer/key/import`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('INVALID_KEY_LENGTH');
  });

  it('DELETE /key is idempotent (200 stored:false, twice)', async () => {
    const agent = await agentFor();
    const first = await agent.delete(`/api/sources/${SOURCE_ID}/observer/key`);
    expect(first.status).toBe(200);
    expect(first.body.data.stored).toBe(false);

    const second = await agent.delete(`/api/sources/${SOURCE_ID}/observer/key`);
    expect(second.status).toBe(200);
    expect(second.body.data.stored).toBe(false);
  });

  it('DELETE /key clears a previously-stored key', async () => {
    const agent = await agentFor();
    await agent.put(`/api/sources/${SOURCE_ID}/observer/key`).send({ privateKey: PRIV });
    const del = await agent.delete(`/api/sources/${SOURCE_ID}/observer/key`);
    expect(del.status).toBe(200);
    expect(del.body.data.stored).toBe(false);

    const getRes = await agent.get(`/api/sources/${SOURCE_ID}/observer/key`);
    expect(getRes.body.data.stored).toBe(false);
  });

  it('non-meshcore source -> 400 INVALID_PARAMETER on every route', async () => {
    const agent = await agentFor();
    // harness.sourceA is seeded as type 'meshtastic_tcp'.
    await grantReadWrite(harness, harness.limited.id, harness.sourceA);

    const getRes = await agent.get(`/api/sources/${harness.sourceA}/observer/key`);
    expect(getRes.status).toBe(400);
    expect(getRes.body.code).toBe('INVALID_PARAMETER');

    const putRes = await agent
      .put(`/api/sources/${harness.sourceA}/observer/key`)
      .send({ privateKey: PRIV });
    expect(putRes.status).toBe(400);
    expect(putRes.body.code).toBe('INVALID_PARAMETER');

    const postRes = await agent.post(`/api/sources/${harness.sourceA}/observer/key/import`);
    expect(postRes.status).toBe(400);
    expect(postRes.body.code).toBe('INVALID_PARAMETER');

    const delRes = await agent.delete(`/api/sources/${harness.sourceA}/observer/key`);
    expect(delRes.status).toBe(400);
    expect(delRes.body.code).toBe('INVALID_PARAMETER');
  });

  it('unknown source id -> 404 SOURCE_NOT_FOUND', async () => {
    // Use admin so the 404 (not a permission 403) is what's under test.
    const adminAgent = await harness.loginAs(harness.admin);
    const res = await adminAgent.get('/api/sources/does-not-exist/observer/key');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SOURCE_NOT_FOUND');
  });

  it('canStore:false store: PUT/POST -> 400 CREDENTIAL_PERSISTENCE_DISABLED; GET still 200', async () => {
    setMeshCoreObserverKeyStoreForTesting(new MeshCoreObserverKeyStore('test-secret', false));
    const agent = await agentFor();

    const getRes = await agent.get(`/api/sources/${SOURCE_ID}/observer/key`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.canStore).toBe(false);
    expect(getRes.body.data.reason).not.toBeNull();

    const putRes = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/key`)
      .send({ privateKey: PRIV });
    expect(putRes.status).toBe(400);
    expect(putRes.body.code).toBe('CREDENTIAL_PERSISTENCE_DISABLED');

    mockSourceRegistry.getManager.mockReturnValue({
      sourceType: 'meshcore',
      exportPrivateKey: vi.fn().mockResolvedValue(PRIV),
    });
    const postRes = await agent.post(`/api/sources/${SOURCE_ID}/observer/key/import`);
    expect(postRes.status).toBe(400);
    expect(postRes.body.code).toBe('CREDENTIAL_PERSISTENCE_DISABLED');
  });

  // ── Envelope shape + secret-leak sweep (spec §7.1, §7.5, §8.5) ──────────────

  it('every response has the shared envelope shape', async () => {
    const agent = await agentFor();
    const ok = await agent.get(`/api/sources/${SOURCE_ID}/observer/key`);
    expect(ok.body).toHaveProperty('success', true);
    expect(ok.body).toHaveProperty('data');

    // Use the admin agent so this hits our own SOURCE_NOT_FOUND fail()
    // envelope rather than requirePermission's own (differently-shaped)
    // FORBIDDEN response for an unpermitted, nonexistent source.
    const adminAgent = await harness.loginAs(harness.admin);
    const errRes = await adminAgent.get('/api/sources/does-not-exist/observer/key');
    expect(errRes.body).toHaveProperty('success', false);
    expect(errRes.body).toHaveProperty('error');
    expect(errRes.body).toHaveProperty('code');
  });

  it('no 2xx response body ever contains a 128-hex substring (secret-leak sweep)', async () => {
    const agent = await agentFor();
    const hex128 = /[0-9a-fA-F]{128}/;

    const responses = [];
    responses.push(await agent.get(`/api/sources/${SOURCE_ID}/observer/key`));
    responses.push(await agent.put(`/api/sources/${SOURCE_ID}/observer/key`).send({ privateKey: PRIV }));
    responses.push(await agent.get(`/api/sources/${SOURCE_ID}/observer/key`));

    mockSourceRegistry.getManager.mockReturnValue({
      sourceType: 'meshcore',
      exportPrivateKey: vi.fn().mockResolvedValue(PRIV),
    });
    responses.push(await agent.post(`/api/sources/${SOURCE_ID}/observer/key/import`));
    responses.push(await agent.delete(`/api/sources/${SOURCE_ID}/observer/key`));

    for (const res of responses) {
      if (res.status >= 200 && res.status < 300) {
        expect(hex128.test(JSON.stringify(res.body))).toBe(false);
      }
    }
  });
});
