/**
 * sourceObserverRoutes — static-credential route tests (issue #4595).
 *
 * Harness-based (createRouteTestApp): mounts the real `sourceRoutes` router
 * (which mounts `sourceObserverRoutes` under `/:id/observer`) so permission
 * middleware runs for real against real SQL. Only non-DB collaborators are
 * mocked: `sourceManagerRegistry` and the credential-store singleton (rebuilt
 * per test from ('test-secret', true) so envelopes encrypt/decrypt
 * deterministically without touching the real SESSION_SECRET derivation).
 *
 * The headline assertion this file exists for: **the password is never
 * present in any API response**, on any route, in any shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  MeshCoreObserverCredentialStore,
  setMeshCoreObserverCredentialStoreForTesting,
  OBSERVER_PASSWORD_MAX_LENGTH,
  OBSERVER_USERNAME_MAX_LENGTH,
} from '../services/meshcoreObserverCredentialStore.js';

const mockSourceRegistry = vi.hoisted(() => ({
  getManager: vi.fn(),
  reconfigureObserver: vi.fn(),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockSourceRegistry,
}));

const SOURCE_ID = 'obs-creds-a';
const PASSWORD = 'sup3r-s3cret-broker-pw';

/** See sourceObserverRoutes.test.ts — one permission row must carry both
 *  actions because of the UNIQUE(user_id, resource, sourceId) index. */
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

describe('sourceObserverRoutes — /credentials (#4595)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources', sourceRoutes),
    });
    await harness.db.sources.deleteSource(SOURCE_ID).catch(() => {});
    await harness.db.sources.createSource({
      id: SOURCE_ID,
      name: 'Obs Creds A',
      type: 'meshcore',
      config: {},
      enabled: true,
    });
    await grantReadWrite(harness, harness.limited.id, SOURCE_ID);

    mockSourceRegistry.getManager.mockReset();
    mockSourceRegistry.getManager.mockReturnValue(undefined);
    mockSourceRegistry.reconfigureObserver.mockReset();
    mockSourceRegistry.reconfigureObserver.mockResolvedValue(true);
    setMeshCoreObserverCredentialStoreForTesting(new MeshCoreObserverCredentialStore('test-secret', true));
  });

  afterEach(async () => {
    setMeshCoreObserverCredentialStoreForTesting(null);
    await harness.db.sources.deleteSource(SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  function agentFor() {
    return harness.loginAs(harness.limited);
  }

  it('GET on an empty source returns stored:false', async () => {
    const agent = await agentFor();
    const res = await agent.get(`/api/sources/${SOURCE_ID}/observer/credentials`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ stored: false, username: null, keyRotated: false });
  });

  it('PUT stores the credentials and a follow-up GET agrees', async () => {
    const agent = await agentFor();
    const putRes = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });
    expect(putRes.status).toBe(200);
    expect(putRes.body.data).toMatchObject({ stored: true, username: 'meshcore', keyRotated: false });

    const getRes = await agent.get(`/api/sources/${SOURCE_ID}/observer/credentials`);
    expect(getRes.body.data).toMatchObject({ stored: true, username: 'meshcore' });
  });

  it('NEVER returns the password on any route', async () => {
    const agent = await agentFor();
    const put = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });
    const get = await agent.get(`/api/sources/${SOURCE_ID}/observer/credentials`);
    const del = await agent.delete(`/api/sources/${SOURCE_ID}/observer/credentials`);

    for (const res of [put, get, del]) {
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(PASSWORD);
      expect(res.body.data).not.toHaveProperty('password');
      expect(res.body.data).not.toHaveProperty('encryptedPassword');
      expect(res.body.data).not.toHaveProperty('storedKid');
    }
  });

  it('never leaks the password through the source GET/list config either', async () => {
    const agent = await agentFor();
    await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });

    const admin = await harness.loginAs(harness.admin);
    const single = await admin.get(`/api/sources/${SOURCE_ID}`);
    const list = await admin.get('/api/sources');
    expect(JSON.stringify(single.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(list.body)).not.toContain(PASSWORD);
  });

  it('stores the password encrypted, never as a plaintext column', async () => {
    const agent = await agentFor();
    await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });

    const row = await harness.db.meshcoreObserverCredentials.getBySourceId(SOURCE_ID);
    expect(row).not.toBeNull();
    expect(row!.username).toBe('meshcore');
    expect(row!.encryptedPassword).not.toContain(PASSWORD);
    expect(JSON.parse(row!.encryptedPassword)).toMatchObject({ v: 1 });
  });

  it('DELETE clears the credentials and is idempotent', async () => {
    const agent = await agentFor();
    await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });

    const first = await agent.delete(`/api/sources/${SOURCE_ID}/observer/credentials`);
    expect(first.status).toBe(200);
    expect(first.body.data.stored).toBe(false);

    const second = await agent.delete(`/api/sources/${SOURCE_ID}/observer/credentials`);
    expect(second.status).toBe(200);
    expect(second.body.data.stored).toBe(false);
  });

  it('hot-swaps the running publisher after a credential change', async () => {
    const agent = await agentFor();
    await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });
    expect(mockSourceRegistry.reconfigureObserver).toHaveBeenCalledWith(SOURCE_ID, undefined);

    mockSourceRegistry.reconfigureObserver.mockClear();
    await agent.delete(`/api/sources/${SOURCE_ID}/observer/credentials`);
    expect(mockSourceRegistry.reconfigureObserver).toHaveBeenCalled();
  });

  it('rejects a non-string username/password', async () => {
    const agent = await agentFor();
    const res = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: 1234 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PARAMETER_TYPE');
  });

  it('rejects an empty username and an empty password', async () => {
    const agent = await agentFor();
    const noUser = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: '   ', password: PASSWORD });
    expect(noUser.status).toBe(400);
    expect(noUser.body.code).toBe('INVALID_PARAMETER');

    const noPass = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: '' });
    expect(noPass.status).toBe(400);
    expect(noPass.body.code).toBe('INVALID_PARAMETER');
  });

  it('rejects over-long username/password', async () => {
    const agent = await agentFor();
    const longUser = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'u'.repeat(OBSERVER_USERNAME_MAX_LENGTH + 1), password: PASSWORD });
    expect(longUser.status).toBe(400);

    const longPass = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: 'p'.repeat(OBSERVER_PASSWORD_MAX_LENGTH + 1) });
    expect(longPass.status).toBe(400);
  });

  it('preserves password whitespace but trims the username', async () => {
    const agent = await agentFor();
    await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: '  meshcore  ', password: '  pw with spaces  ' });

    const res = await agent.get(`/api/sources/${SOURCE_ID}/observer/credentials`);
    expect(res.body.data.username).toBe('meshcore');

    const loaded = await new MeshCoreObserverCredentialStore('test-secret', true).load(SOURCE_ID);
    expect(loaded).toEqual({ kind: 'ok', username: 'meshcore', password: '  pw with spaces  ' });
  });

  it('404s for a source that does not exist and 400s for a non-meshcore source', async () => {
    // Admin agent: `requirePermission` runs BEFORE the source lookup, so a
    // limited user would get 403 on an unknown source, not 404.
    const agent = await harness.loginAs(harness.admin);
    const missing = await agent.get('/api/sources/nope/observer/credentials');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('SOURCE_NOT_FOUND');

    await harness.db.sources.createSource({
      id: 'tcp-src',
      name: 'TCP',
      type: 'meshtastic_tcp',
      config: {},
      enabled: true,
    });
    const wrongType = await agent.get('/api/sources/tcp-src/observer/credentials');
    expect(wrongType.status).toBe(400);
    await harness.db.sources.deleteSource('tcp-src').catch(() => {});
  });

  it('refuses to store when SESSION_SECRET is auto-generated', async () => {
    setMeshCoreObserverCredentialStoreForTesting(new MeshCoreObserverCredentialStore('ephemeral', false));
    const agent = await agentFor();
    const res = await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CREDENTIAL_PERSISTENCE_DISABLED');
  });

  it('still allows DELETE when SESSION_SECRET is auto-generated', async () => {
    const agent = await agentFor();
    await agent
      .put(`/api/sources/${SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });

    setMeshCoreObserverCredentialStoreForTesting(new MeshCoreObserverCredentialStore('ephemeral', false));
    const res = await agent.delete(`/api/sources/${SOURCE_ID}/observer/credentials`);
    expect(res.status).toBe(200);
    expect(res.body.data.stored).toBe(false);
  });

  it('403s on a source the caller has no configuration permission for', async () => {
    // Same logged-in user, a DIFFERENT source with no grant — this proves the
    // per-source scoping, not just that auth exists.
    await harness.db.sources.createSource({
      id: 'obs-creds-b',
      name: 'Obs Creds B',
      type: 'meshcore',
      config: {},
      enabled: true,
    });
    const agent = await agentFor();
    expect((await agent.get('/api/sources/obs-creds-b/observer/credentials')).status).toBe(403);
    expect(
      (
        await agent
          .put('/api/sources/obs-creds-b/observer/credentials')
          .send({ username: 'x', password: 'y' })
      ).status,
    ).toBe(403);
    expect((await agent.delete('/api/sources/obs-creds-b/observer/credentials')).status).toBe(403);
    await harness.db.sources.deleteSource('obs-creds-b').catch(() => {});
  });
});

/**
 * Per-broker `brokerKey` support (#5014 Phase 1 WP4, spec §5.3, tests 50-54).
 * A dedicated source carrying a real `brokers[]` config, so `brokerKey`
 * validation has something to bound against (`UNKNOWN_BROKER`).
 */
describe('sourceObserverRoutes — /credentials brokerKey (#5014 Phase 1)', () => {
  let harness: RouteTestHarness;

  const MULTI_SOURCE_ID = 'obs-creds-multi';
  const LEGACY_BROKER_KEY = 'wss://legacy.example:443';
  const SECOND_BROKER_KEY = 'wss://second.example:443';
  const UNKNOWN_KEY = 'wss://never-configured.example:443';

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources', sourceRoutes),
    });
    await harness.db.sources.deleteSource(MULTI_SOURCE_ID).catch(() => {});
    await harness.db.sources.createSource({
      id: MULTI_SOURCE_ID,
      name: 'Obs Creds Multi',
      type: 'meshcore',
      config: {
        observer: {
          enabled: true,
          iataCode: 'TST',
          brokerUrl: LEGACY_BROKER_KEY,
          tokenAudience: 'legacy-aud',
          brokers: [
            { url: LEGACY_BROKER_KEY, authMode: 'token', tokenAudience: 'legacy-aud', label: 'Legacy' },
            { url: SECOND_BROKER_KEY, authMode: 'password', label: 'Second' },
          ],
        },
      },
      enabled: true,
    });
    await grantReadWrite(harness, harness.limited.id, MULTI_SOURCE_ID);
    // Credentials are keyed by sourceId in a table independent of `sources`,
    // so re-creating the source above does NOT clear a prior test's row for
    // the same id — clear it explicitly for test isolation.
    await new MeshCoreObserverCredentialStore('test-secret', true).clear(MULTI_SOURCE_ID);

    mockSourceRegistry.getManager.mockReset();
    mockSourceRegistry.getManager.mockReturnValue(undefined);
    mockSourceRegistry.reconfigureObserver.mockReset();
    mockSourceRegistry.reconfigureObserver.mockResolvedValue(true);
    setMeshCoreObserverCredentialStoreForTesting(new MeshCoreObserverCredentialStore('test-secret', true));
  });

  afterEach(async () => {
    setMeshCoreObserverCredentialStoreForTesting(null);
    await new MeshCoreObserverCredentialStore('test-secret', true).clear(MULTI_SOURCE_ID);
    await harness.db.sources.deleteSource(MULTI_SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  function multiAgent() {
    return harness.loginAs(harness.limited);
  }

  it('PUT with no brokerKey behaves exactly as today (legacy path) even when brokers[] is configured', async () => {
    const agent = await multiAgent();
    const res = await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'meshcore', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stored: true, username: 'meshcore' });
    expect(mockSourceRegistry.reconfigureObserver).toHaveBeenCalled();

    const loaded = await new MeshCoreObserverCredentialStore('test-secret', true).load(MULTI_SOURCE_ID);
    expect(loaded).toEqual({ kind: 'ok', username: 'meshcore', password: PASSWORD });
  });

  it('PUT with a brokerKey matching a configured broker stores per-broker; GET lists it under brokers[]', async () => {
    const agent = await multiAgent();
    const putRes = await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'second-user', password: PASSWORD, brokerKey: SECOND_BROKER_KEY });
    expect(putRes.status).toBe(200);
    expect(putRes.body.data.brokers).toEqual([{ brokerKey: SECOND_BROKER_KEY, username: 'second-user' }]);
    // `stored`/`username` reflect "a row exists at all" (computeClearUsername
    // falls back to the lexicographically-first broker when there is no
    // legacy entry) — NOT the legacy single-credential slot specifically.
    expect(putRes.body.data.stored).toBe(true);
    expect(putRes.body.data.username).toBe('second-user');

    const getRes = await agent.get(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`);
    expect(getRes.body.data.brokers).toEqual([{ brokerKey: SECOND_BROKER_KEY, username: 'second-user' }]);
    // Never a password anywhere in the response.
    expect(JSON.stringify(getRes.body)).not.toContain(PASSWORD);

    const loaded = await new MeshCoreObserverCredentialStore('test-secret', true).loadForBroker(
      MULTI_SOURCE_ID,
      SECOND_BROKER_KEY,
    );
    expect(loaded).toEqual({ kind: 'ok', username: 'second-user', password: PASSWORD });
  });

  it('PUT with an unconfigured brokerKey -> 400 UNKNOWN_BROKER', async () => {
    const agent = await multiAgent();
    const res = await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'x', password: PASSWORD, brokerKey: UNKNOWN_KEY });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_BROKER');
  });

  it('PUT rejects a non-string / over-long brokerKey before checking it is configured', async () => {
    const agent = await multiAgent();
    const nonString = await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'x', password: PASSWORD, brokerKey: 12345 });
    expect(nonString.status).toBe(400);
    expect(nonString.body.code).toBe('INVALID_PARAMETER_TYPE');

    const tooLong = await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'x', password: PASSWORD, brokerKey: 'k'.repeat(256) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('INVALID_PARAMETER');
  });

  it('DELETE ?brokerKey= removes one entry, leaving the others and the legacy entry', async () => {
    const agent = await multiAgent();
    await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'legacy-user', password: PASSWORD });
    await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'legacy-broker-user', password: PASSWORD, brokerKey: LEGACY_BROKER_KEY });
    await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'second-user', password: PASSWORD, brokerKey: SECOND_BROKER_KEY });

    const delRes = await agent.delete(
      `/api/sources/${MULTI_SOURCE_ID}/observer/credentials?brokerKey=${encodeURIComponent(SECOND_BROKER_KEY)}`,
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.brokers).toEqual([{ brokerKey: LEGACY_BROKER_KEY, username: 'legacy-broker-user' }]);
    // The legacy credential (store()) survives a per-broker delete.
    expect(delRes.body.data.stored).toBe(true);
    expect(delRes.body.data.username).toBe('legacy-user');

    const store = new MeshCoreObserverCredentialStore('test-secret', true);
    expect(await store.loadForBroker(MULTI_SOURCE_ID, SECOND_BROKER_KEY)).toEqual({ kind: 'none' });
    expect(await store.load(MULTI_SOURCE_ID)).toEqual({ kind: 'ok', username: 'legacy-user', password: PASSWORD });
  });

  it('DELETE with no param still wipes everything (legacy + all brokers)', async () => {
    const agent = await multiAgent();
    await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'legacy-user', password: PASSWORD });
    await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'second-user', password: PASSWORD, brokerKey: SECOND_BROKER_KEY });

    const delRes = await agent.delete(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.stored).toBe(false);
    expect(delRes.body.data.brokers).toEqual([]);
  });

  it('DELETE with an unconfigured brokerKey -> 400 UNKNOWN_BROKER', async () => {
    const agent = await multiAgent();
    const res = await agent.delete(
      `/api/sources/${MULTI_SOURCE_ID}/observer/credentials?brokerKey=${encodeURIComponent(UNKNOWN_KEY)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_BROKER');
  });

  it('both the PUT and DELETE per-broker paths audit with brokerKey in the detail, and hot-swap the publisher', async () => {
    const agent = await multiAgent();

    mockSourceRegistry.reconfigureObserver.mockClear();
    await agent
      .put(`/api/sources/${MULTI_SOURCE_ID}/observer/credentials`)
      .send({ username: 'second-user', password: PASSWORD, brokerKey: SECOND_BROKER_KEY });
    expect(mockSourceRegistry.reconfigureObserver).toHaveBeenCalled();

    mockSourceRegistry.reconfigureObserver.mockClear();
    await agent.delete(
      `/api/sources/${MULTI_SOURCE_ID}/observer/credentials?brokerKey=${encodeURIComponent(SECOND_BROKER_KEY)}`,
    );
    expect(mockSourceRegistry.reconfigureObserver).toHaveBeenCalled();

    const entries = await harness.db.auth.getAuditLogEntries(20, 0);
    const setEntry = entries.find(
      (e) => e.action === 'meshcore_observer_credentials_set' && e.details?.includes(SECOND_BROKER_KEY),
    );
    const clearEntry = entries.find(
      (e) => e.action === 'meshcore_observer_credentials_clear' && e.details?.includes(SECOND_BROKER_KEY),
    );
    expect(setEntry).toBeDefined();
    expect(clearEntry).toBeDefined();
    expect(JSON.parse(setEntry!.details!)).toMatchObject({ sourceId: MULTI_SOURCE_ID, brokerKey: SECOND_BROKER_KEY });
    expect(JSON.parse(clearEntry!.details!)).toMatchObject({
      sourceId: MULTI_SOURCE_ID,
      brokerKey: SECOND_BROKER_KEY,
    });
    // Never a secret in the audit trail.
    for (const e of entries) {
      expect(e.details ?? '').not.toContain(PASSWORD);
    }
  });
});
