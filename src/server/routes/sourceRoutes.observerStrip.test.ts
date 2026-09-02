/**
 * Analyzer Observer (#4457 Phase 1, WP2) — stripSourceSecrets defence-in-depth.
 *
 * The observer config block itself carries no secrets by design (brokerUrl /
 * iataCode / tokenAudience are all public-by-nature), and validateObserverConfig's
 * OBSERVER_KEY_IN_CONFIG check rejects any attempt to write key material into
 * `sources.config` going forward. This test covers the defence-in-depth case: a
 * row written *before* that validation existed, still carrying a raw
 * `observer.privateKey`. `stripSourceSecrets` must remove it for every caller —
 * including admins, unlike the pre-existing `password`/`apiKey` strip which only
 * applies to non-admins (see docs/internal/dev-notes/MESHCORE_OBSERVER_PHASE1_SPEC.md §5.4).
 *
 * Uses the real createRouteTestApp harness (real session + auth middleware +
 * real permission SQL) per CLAUDE.md's Route Test Harness guidance — not the
 * deprecated vi.mock('../../services/database.js', ...) monkey-patch pattern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// Non-DB mocks only — sourceRoutes.ts calls these at request time (radio
// summary computation) and they must not attempt a real device connection.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

const OBSERVER_SOURCE_ID = 'obs-strip-source';
// 128 hex chars — shape of a real orlp Ed25519 private key. Must never survive
// stripSourceSecrets, for any caller.
const LEAKED_PRIVATE_KEY = 'ab'.repeat(64);

describe('sourceRoutes — stripSourceSecrets omits observer key material (#4457)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    // Simulate a pre-existing row written before OBSERVER_KEY_IN_CONFIG
    // validation existed.
    await harness.db.sources.deleteSource(OBSERVER_SOURCE_ID).catch(() => {});
    await harness.db.sources.createSource({
      id: OBSERVER_SOURCE_ID,
      name: 'Observer Strip Source',
      type: 'meshcore',
      config: {
        transport: 'usb',
        port: '/dev/ttyACM0',
        deviceType: 'companion',
        observer: {
          enabled: true,
          brokerUrl: 'mqtts://host:8883',
          iataCode: 'MCO',
          tokenAudience: 'aud',
          privateKey: LEAKED_PRIVATE_KEY,
        },
      },
      enabled: true,
    });

    // GET /:id is gated by `sources:read` with no sourceIdFrom — a global grant.
    await harness.grant(harness.limited.id, 'sources', 'read');
  });

  afterEach(async () => {
    await harness.db.sources.deleteSource(OBSERVER_SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  describe('GET /api/sources (list)', () => {
    it('omits observer.privateKey for the admin', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      const row = res.body.find((s: any) => s.id === OBSERVER_SOURCE_ID);
      expect(row).toBeDefined();
      expect(row.config.observer.privateKey).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain(LEAKED_PRIVATE_KEY);
      // Non-secret observer fields still round-trip for the admin edit form.
      expect(row.config.observer.brokerUrl).toBe('mqtts://host:8883');
      expect(row.config.observer.enabled).toBe(true);
    });

    it('omits observer.privateKey for the limited (non-admin) user', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      const row = res.body.find((s: any) => s.id === OBSERVER_SOURCE_ID);
      expect(row).toBeDefined();
      expect(row.config.observer.privateKey).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain(LEAKED_PRIVATE_KEY);
    });
  });

  describe('GET /api/sources/:id', () => {
    it('omits observer.privateKey for the admin', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/${OBSERVER_SOURCE_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.config.observer.privateKey).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(LEAKED_PRIVATE_KEY);
      expect(res.body.config.observer.brokerUrl).toBe('mqtts://host:8883');
    });

    it('omits observer.privateKey for the limited (non-admin) user', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/${OBSERVER_SOURCE_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.config.observer.privateKey).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(LEAKED_PRIVATE_KEY);
    });
  });
});

// Test 15 (#5014 Phase 1 WP1): the same strip must also reach into
// observer.brokers[] entries, not just the block itself.
describe('sourceRoutes — stripSourceSecrets omits observer.brokers[] key material (#5014)', () => {
  let harness: RouteTestHarness;

  const BROKERS_SOURCE_ID = 'obs-strip-brokers-source';
  // Distinct "leaked" password so we can assert it never survives, for a
  // second broker entry (index 1) specifically — the pattern the spec test
  // calls out.
  const LEAKED_BROKER_PASSWORD = 'super-secret-broker-password';

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    await harness.db.sources.deleteSource(BROKERS_SOURCE_ID).catch(() => {});
    await harness.db.sources.createSource({
      id: BROKERS_SOURCE_ID,
      name: 'Observer Brokers Strip Source',
      type: 'meshcore',
      config: {
        transport: 'usb',
        port: '/dev/ttyACM0',
        deviceType: 'companion',
        observer: {
          enabled: true,
          iataCode: 'MCO',
          brokers: [
            { url: 'wss://mqtt.meshmapper.net:443', tokenAudience: 'mqtt.meshmapper.net' },
            { url: 'wss://mqtt-us-v1.letsmesh.net:443', password: LEAKED_BROKER_PASSWORD },
          ],
        },
      },
      enabled: true,
    });

    await harness.grant(harness.limited.id, 'sources', 'read');
  });

  afterEach(async () => {
    await harness.db.sources.deleteSource(BROKERS_SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  it('strips observer.brokers[1].password for admins and non-admins alike, keeping the non-secret broker fields', async () => {
    for (const user of ['admin', 'limited'] as const) {
      const agent = await harness.loginAs(harness[user]);
      const res = await agent.get(`/${BROKERS_SOURCE_ID}`);
      expect(res.status).toBe(200);
      const brokers = res.body.config.observer.brokers;
      expect(brokers).toHaveLength(2);
      expect(brokers[1].password).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(LEAKED_BROKER_PASSWORD);
      // Non-secret fields still round-trip.
      expect(brokers[0].url).toBe('wss://mqtt.meshmapper.net:443');
      expect(brokers[1].url).toBe('wss://mqtt-us-v1.letsmesh.net:443');
    }
  });

  it('strips observer.brokers[1].password from the sources list too', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    const row = res.body.find((s: any) => s.id === BROKERS_SOURCE_ID);
    expect(row).toBeDefined();
    expect(row.config.observer.brokers[1].password).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(LEAKED_BROKER_PASSWORD);
  });
});
