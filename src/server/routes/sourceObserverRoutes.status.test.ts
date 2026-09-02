/**
 * GET /api/sources/:id/observer/status route tests (#5014 Phase 1 WP4,
 * spec §5.2, §6.8, tests 44-49).
 *
 * Harness-based (createRouteTestApp): mounts the real `sourceRoutes` router
 * so permission middleware runs for real against real SQL. Only
 * `sourceManagerRegistry` is mocked, with a fake MeshCore manager exposing
 * `getObserverStatus()` — the exact duck-type the route depends on (it never
 * imports the publisher, so WP3 and WP4 can land independently).
 * `databaseService` itself is never mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const mockSourceRegistry = vi.hoisted(() => ({
  getManager: vi.fn(),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockSourceRegistry,
}));

const RUNNING_SOURCE_ID = 'obs-status-running';
const NOT_RUNNING_SOURCE_ID = 'obs-status-not-running'; // no manager registered
const DISABLED_SOURCE_ID = 'obs-status-disabled'; // observer disabled in config
const NO_GRANT_SOURCE_ID = 'obs-status-no-grant';
const ALL_SOURCE_IDS = [RUNNING_SOURCE_ID, NOT_RUNNING_SOURCE_ID, DISABLED_SOURCE_ID, NO_GRANT_SOURCE_ID];

const FULL_STATUS = {
  configured: true,
  authMode: 'token' as const,
  keyStored: true,
  connected: true,
  publishes: 412,
  dropped: 3,
  lastPublishAt: 1756800000000,
  lastError: null,
  tokenExpiresAt: 1756880000,
  brokers: [
    {
      key: 'wss://mqtt.meshmapper.net:443',
      url: 'wss://mqtt.meshmapper.net:443',
      label: 'MeshMapper',
      authMode: 'token' as const,
      tokenAudience: 'mqtt.meshmapper.net',
      configured: true,
      keyStored: true,
      connected: true,
      publishes: 412,
      dropped: 3,
      lastPublishAt: 1756800000000,
      lastError: null,
      tokenExpiresAt: 1756880000,
    },
  ],
};

const MULTI_BROKER_CONFIG = {
  observer: {
    enabled: true,
    iataCode: 'TST',
    brokerUrl: 'wss://legacy.example:443',
    tokenAudience: 'legacy-aud',
    brokers: [
      { url: 'wss://legacy.example:443', authMode: 'token', tokenAudience: 'legacy-aud', label: 'Legacy' },
      { url: 'wss://second.example:443', authMode: 'password', label: 'Second' },
    ],
  },
};

describe('GET /api/sources/:id/observer/status (#5014 Phase 1)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources', sourceRoutes),
    });

    for (const id of ALL_SOURCE_IDS) {
      await harness.db.sources.deleteSource(id).catch(() => {});
    }

    await harness.db.sources.createSource({
      id: RUNNING_SOURCE_ID,
      name: 'Running',
      type: 'meshcore',
      config: MULTI_BROKER_CONFIG,
      enabled: true,
    });
    await harness.db.sources.createSource({
      id: NOT_RUNNING_SOURCE_ID,
      name: 'Not running',
      type: 'meshcore',
      config: MULTI_BROKER_CONFIG,
      enabled: true,
    });
    await harness.db.sources.createSource({
      id: DISABLED_SOURCE_ID,
      name: 'Disabled',
      type: 'meshcore',
      config: { observer: { enabled: false } },
      enabled: true,
    });
    await harness.db.sources.createSource({
      id: NO_GRANT_SOURCE_ID,
      name: 'No grant',
      type: 'meshcore',
      config: MULTI_BROKER_CONFIG,
      enabled: true,
    });

    await harness.grant(harness.limited.id, 'configuration', 'read', RUNNING_SOURCE_ID);
    await harness.grant(harness.limited.id, 'configuration', 'read', NOT_RUNNING_SOURCE_ID);
    await harness.grant(harness.limited.id, 'configuration', 'read', DISABLED_SOURCE_ID);
    // Deliberately NO grant on NO_GRANT_SOURCE_ID — proves per-source isolation.

    mockSourceRegistry.getManager.mockReset();
    mockSourceRegistry.getManager.mockImplementation((id: string) => {
      if (id === RUNNING_SOURCE_ID) {
        return { sourceType: 'meshcore', getObserverStatus: vi.fn().mockReturnValue(FULL_STATUS) };
      }
      if (id === NOT_RUNNING_SOURCE_ID) {
        return { sourceType: 'meshcore', getObserverStatus: vi.fn().mockReturnValue(undefined) };
      }
      return undefined;
    });
  });

  afterEach(async () => {
    for (const id of ALL_SOURCE_IDS) {
      await harness.db.sources.deleteSource(id).catch(() => {});
    }
    await harness.cleanup();
  });

  it('[44] 200 with the full aggregate + brokers[] for a configuration:read grant, wrapped in the envelope', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/sources/${RUNNING_SOURCE_ID}/observer/status`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ running: true, ...FULL_STATUS });
  });

  it('[45] 403 without the grant, and per-source isolation from a grant on a different source', async () => {
    const agent = await harness.loginAs(harness.limited);
    // `harness.limited` IS granted on RUNNING_SOURCE_ID (beforeEach) but NOT
    // on NO_GRANT_SOURCE_ID — the grant on the other source must not leak.
    const res = await agent.get(`/api/sources/${NO_GRANT_SOURCE_ID}/observer/status`);
    expect(res.status).toBe(403);
  });

  it('[46] 404 SOURCE_NOT_FOUND for an unknown id; 400 INVALID_PARAMETER for a non-meshcore source', async () => {
    // Admin agent: requirePermission runs before the source lookup, so a
    // limited user would get 403 on an unknown source, not 404.
    const admin = await harness.loginAs(harness.admin);
    const missing = await admin.get('/api/sources/does-not-exist/observer/status');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('SOURCE_NOT_FOUND');

    await harness.db.sources.createSource({
      id: 'tcp-src-status',
      name: 'TCP',
      type: 'meshtastic_tcp',
      config: {},
      enabled: true,
    });
    const wrongType = await admin.get('/api/sources/tcp-src-status/observer/status');
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.code).toBe('INVALID_PARAMETER');
    await harness.db.sources.deleteSource('tcp-src-status').catch(() => {});
  });

  it('[47] no registered manager -> 200 running:false, zeroed counters, brokers[] synthesized from config', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/sources/${NOT_RUNNING_SOURCE_ID}/observer/status`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      running: false,
      configured: true,
      authMode: 'token',
      keyStored: false,
      connected: false,
      publishes: 0,
      dropped: 0,
      lastPublishAt: null,
      lastError: null,
      tokenExpiresAt: null,
      brokers: [
        {
          key: 'wss://legacy.example:443',
          url: 'wss://legacy.example:443',
          label: 'Legacy',
          authMode: 'token',
          tokenAudience: 'legacy-aud',
          configured: true,
          keyStored: false,
          connected: false,
          publishes: 0,
          dropped: 0,
          lastPublishAt: null,
          lastError: null,
          tokenExpiresAt: null,
        },
        {
          key: 'wss://second.example:443',
          url: 'wss://second.example:443',
          label: 'Second',
          authMode: 'password',
          tokenAudience: null,
          configured: true,
          keyStored: false,
          connected: false,
          publishes: 0,
          dropped: 0,
          lastPublishAt: null,
          lastError: null,
          tokenExpiresAt: null,
        },
      ],
    });
  });

  it('[48] observer disabled in config -> 200 running:false, configured:false, brokers: []', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/sources/${DISABLED_SOURCE_ID}/observer/status`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ running: false, configured: false, brokers: [] });
  });

  it('[49] the response never contains a password, private key or token-shaped string', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/api/sources/${RUNNING_SOURCE_ID}/observer/status`);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/privateKey/i);
    // A JWT-shaped token has two dots joining base64url segments.
    expect(body).not.toMatch(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  });
});
