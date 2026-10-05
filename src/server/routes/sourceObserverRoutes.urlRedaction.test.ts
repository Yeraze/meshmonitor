/**
 * sourceObserverRoutes — what each caller is shown of the broker URLs.
 *
 * `GET /status`, `GET /key` and `GET /credentials` are gated on
 * `configuration:read` for the source. A broker URL in a response then goes
 * out per caller:
 *
 *   admin      as stored,
 *   signed in  without `user:password@`, query string or fragment,
 *   no login   not at all, whatever the anonymous account was granted.
 *
 * Real session + auth middleware + permission SQL via createRouteTestApp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  MeshCoreObserverKeyStore,
  setMeshCoreObserverKeyStoreForTesting,
} from '../services/meshcoreObserverKeyStore.js';
import {
  MeshCoreObserverCredentialStore,
  setMeshCoreObserverCredentialStoreForTesting,
} from '../services/meshcoreObserverCredentialStore.js';
import { observerBrokerKey } from '../meshcoreConfig.js';

const mockSourceRegistry = vi.hoisted(() => ({
  getManager: vi.fn(),
  reconfigureObserver: vi.fn(),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockSourceRegistry,
}));

const SOURCE = 'obs-url-redaction';

/** URL credentials, query string, fragment: admin only. */
const SEC = 'SECSENTINEL';
/** Hosts, labels, audiences, usernames: any signed-in caller past the gate. */
const EP = 'EPSENTINEL';

const URL_ONE = `wss://${SEC}-user:${SEC}-pw@${EP}-one.example:443/mqtt?token=${SEC}-query#${SEC}-frag`;
const URL_TWO = `mqtts://${EP}-two.example:8883`;
const SHOWN_ONE = `wss://***@${EP}-one.example:443/mqtt`;

const CONFIG = {
  transport: 'usb',
  port: '/dev/ttyUSB7',
  deviceType: 'companion',
  autoConnect: false,
  observer: {
    enabled: true,
    iataCode: 'MCO',
    brokers: [
      { url: URL_ONE, authMode: 'password', label: `${EP}-label-one` },
      { url: URL_TWO, authMode: 'token', tokenAudience: `${EP}-audience-two`, label: `${EP}-label-two` },
    ],
  },
};

type Caller = 'admin' | 'reader' | 'anonymousWithRead';

describe('sourceObserverRoutes — broker URLs per caller', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources', sourceRoutes),
    });
    await harness.db.sources.deleteSource(SOURCE).catch(() => {});
    await harness.db.sources.createSource({ id: SOURCE, name: 'Obs URLs', type: 'meshcore', config: CONFIG, enabled: true });

    mockSourceRegistry.getManager.mockReset().mockReturnValue(undefined);
    mockSourceRegistry.reconfigureObserver.mockReset().mockResolvedValue(true);
    setMeshCoreObserverKeyStoreForTesting(new MeshCoreObserverKeyStore('test-secret', true));
    const credentials = new MeshCoreObserverCredentialStore('test-secret', true);
    setMeshCoreObserverCredentialStoreForTesting(credentials);
    await credentials.store(SOURCE, `${EP}-legacy-user`, 'legacy-password');
    await credentials.storeForBroker(SOURCE, observerBrokerKey(URL_ONE), `${EP}-broker-user`, 'broker-password');
  });

  afterEach(async () => {
    setMeshCoreObserverKeyStoreForTesting(null);
    setMeshCoreObserverCredentialStoreForTesting(null);
    await harness.db.sources.deleteSource(SOURCE).catch(() => {});
    await harness.revokeAll(harness.anonymous.id);
    await harness.cleanup();
  });

  async function agentFor(caller: Caller) {
    switch (caller) {
      case 'admin':
        return harness.loginAs(harness.admin);
      case 'reader':
        await harness.grant(harness.limited.id, 'configuration', 'read', SOURCE);
        return harness.loginAs(harness.limited);
      case 'anonymousWithRead':
        await harness.grant(harness.anonymous.id, 'configuration', 'read', SOURCE);
        return harness.loginAs(null);
    }
  }

  /** A running publisher's status, with host-bearing error text. */
  function runningManager() {
    const lastError = `connect failed for ${URL_ONE}: getaddrinfo ENOTFOUND ${EP}-one.example (${SEC}-pw)`;
    mockSourceRegistry.getManager.mockReturnValue({
      sourceType: 'meshcore',
      getObserverStatus: () => ({
        configured: true,
        authMode: 'token',
        keyStored: true,
        connected: false,
        publishes: 4,
        dropped: 1,
        lastPublishAt: null,
        lastError,
        tokenExpiresAt: null,
        brokers: [
          {
            key: observerBrokerKey(URL_ONE),
            url: URL_ONE,
            label: `${EP}-label-one`,
            authMode: 'password',
            tokenAudience: null,
            configured: true,
            keyStored: true,
            connected: false,
            publishes: 4,
            dropped: 1,
            lastPublishAt: null,
            lastError,
            tokenExpiresAt: null,
          },
        ],
      }),
    });
  }

  const text = (body: unknown) => JSON.stringify(body).toLowerCase();
  const sec = SEC.toLowerCase();
  const ep = EP.toLowerCase();

  describe.each(['not running', 'running'])('GET /status (%s)', (mode) => {
    beforeEach(() => {
      if (mode === 'running') runningManager();
    });

    it('admin gets the status as built', async () => {
      const res = await (await agentFor('admin')).get(`/api/sources/${SOURCE}/observer/status`);
      expect(res.status).toBe(200);
      expect(res.body.data.brokers[0].url).toBe(URL_ONE);
      expect(res.body.data.brokers[0].key).toBe(observerBrokerKey(URL_ONE));
    });

    it('a signed-in configuration:read holder gets hosts, and no URL credential', async () => {
      const res = await (await agentFor('reader')).get(`/api/sources/${SOURCE}/observer/status`);
      expect(res.status).toBe(200);
      expect(text(res.body)).not.toContain(sec);
      const [one] = res.body.data.brokers;
      expect(one.url).toBe(SHOWN_ONE);
      expect(one.key).toBe(SHOWN_ONE.toLowerCase());
      expect(one.label).toBe(`${EP}-label-one`);
      if (mode === 'running') {
        // The error still names the host; the credentials in it are gone.
        expect(res.body.data.lastError).toContain(`${EP}-one.example`);
        expect(one.lastError).toContain(`${EP}-one.example`);
        expect(res.body.data.publishes).toBe(4);
      } else {
        expect(res.body.data.brokers[1].tokenAudience).toBe(`${EP}-audience-two`);
      }
    });

    it('a caller with no login gets no host, whatever the anonymous account holds', async () => {
      const res = await (await agentFor('anonymousWithRead')).get(`/api/sources/${SOURCE}/observer/status`);
      expect(res.status).toBe(200);
      expect(text(res.body)).not.toContain(sec);
      expect(text(res.body)).not.toContain(ep);
      const brokers = res.body.data.brokers as Array<Record<string, unknown>>;
      expect(brokers.length).toBe(mode === 'running' ? 1 : 2);
      expect(brokers[0]).toMatchObject({ key: 'broker-0', url: '', label: null, tokenAudience: null, lastError: null });
      expect(res.body.data.lastError).toBeNull();
      // Counts and state survive.
      expect(res.body.data.configured).toBe(true);
    });
  });

  describe('GET /credentials', () => {
    it('admin gets broker keys as stored', async () => {
      const res = await (await agentFor('admin')).get(`/api/sources/${SOURCE}/observer/credentials`);
      expect(res.status).toBe(200);
      expect(res.body.data.brokers).toEqual([
        { brokerKey: observerBrokerKey(URL_ONE), username: `${EP}-broker-user` },
      ]);
    });

    it('a signed-in configuration:read holder gets keys with no URL credential', async () => {
      const res = await (await agentFor('reader')).get(`/api/sources/${SOURCE}/observer/credentials`);
      expect(res.status).toBe(200);
      expect(text(res.body)).not.toContain(sec);
      expect(res.body.data.username).toBe(`${EP}-legacy-user`);
      expect(res.body.data.brokers).toEqual([
        { brokerKey: SHOWN_ONE.toLowerCase(), username: `${EP}-broker-user` },
      ]);
    });

    it('a caller with no login gets no host and no username', async () => {
      const res = await (await agentFor('anonymousWithRead')).get(`/api/sources/${SOURCE}/observer/credentials`);
      expect(res.status).toBe(200);
      expect(text(res.body)).not.toContain(sec);
      expect(text(res.body)).not.toContain(ep);
      expect(res.body.data.stored).toBe(true);
      expect(res.body.data.username).toBeNull();
      expect(res.body.data.brokers).toEqual([{ brokerKey: 'broker-0', username: null }]);
    });
  });

  describe('GET /key', () => {
    it.each(['admin', 'reader', 'anonymousWithRead'] as Caller[])('%s: carries no URL at all', async (caller) => {
      const res = await (await agentFor(caller)).get(`/api/sources/${SOURCE}/observer/key`);
      expect(res.status).toBe(200);
      expect(text(res.body)).not.toContain(sec);
      expect(text(res.body)).not.toContain(ep);
      expect(Object.keys(res.body.data).sort()).toEqual(
        ['canStore', 'keyRotated', 'origin', 'publicKey', 'reason', 'stored', 'updatedAt'],
      );
    });
  });

  it('a caller with no grant on the source is still refused', async () => {
    const limited = await harness.loginAs(harness.limited);
    const anon = await harness.loginAs(null);
    for (const route of ['status', 'key', 'credentials']) {
      expect((await limited.get(`/api/sources/${SOURCE}/observer/${route}`)).status).toBe(403);
      expect([401, 403]).toContain((await anon.get(`/api/sources/${SOURCE}/observer/${route}`)).status);
    }
  });

  describe('writing credentials with the key a non-admin was shown', () => {
    async function writer() {
      await harness.db.auth.createPermission({
        userId: harness.limited.id,
        resource: 'configuration',
        canRead: true,
        canWrite: true,
        sourceId: SOURCE,
        grantedAt: Date.now(),
        grantedBy: null,
      });
      return harness.loginAs(harness.limited);
    }

    it('accepts the shown key and stores under the real one', async () => {
      const agent = await writer();
      const shown = (await agent.get(`/api/sources/${SOURCE}/observer/status`)).body.data.brokers[0].key;
      expect(shown).toBe(SHOWN_ONE.toLowerCase());

      const res = await agent
        .put(`/api/sources/${SOURCE}/observer/credentials`)
        .send({ brokerKey: shown, username: 'changed-user', password: 'changed-password' });
      expect(res.status).toBe(200);
      expect(text(res.body)).not.toContain(sec);
      expect(res.body.data.brokers).toEqual([{ brokerKey: shown, username: 'changed-user' }]);

      const admin = await harness.loginAs(harness.admin);
      const asAdmin = await admin.get(`/api/sources/${SOURCE}/observer/credentials`);
      expect(asAdmin.body.data.brokers).toEqual([
        { brokerKey: observerBrokerKey(URL_ONE), username: 'changed-user' },
      ]);

      const cleared = await agent
        .delete(`/api/sources/${SOURCE}/observer/credentials`)
        .query({ brokerKey: shown });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.brokers).toEqual([]);
    });

    it('still refuses a key that names no configured broker, echoing only what was sent', async () => {
      const agent = await writer();
      const res = await agent
        .put(`/api/sources/${SOURCE}/observer/credentials`)
        .send({ brokerKey: 'wss://nowhere.example', username: 'u', password: 'p' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_BROKER');
      expect(text(res.body)).not.toContain(sec);
      expect(text(res.body)).not.toContain(ep);
    });
  });
});
