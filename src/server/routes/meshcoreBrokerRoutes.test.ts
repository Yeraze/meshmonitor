/**
 * Routes for the embedded MeshCore MQTT broker (#6197): diagnostics need the
 * per-source `nodes:read` the ingest overview card uses; the own observer key
 * needs `sources:write` to change. Real auth middleware via the route harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockGetManager = vi.fn();
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (...args: unknown[]) => mockGetManager(...args),
    addManager: vi.fn(),
    removeManager: vi.fn(),
  },
}));

import meshcoreBrokerRoutes from './meshcoreBrokerRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  MeshCoreObserverKeyStore,
  setMeshCoreObserverKeyStoreForTesting,
} from '../services/meshcoreObserverKeyStore.js';

const OBS = 'AB'.repeat(32);

function fakeDiagnostics() {
  return {
    listening: true,
    port: 1884,
    clientCount: 1,
    lastError: 'listen detail',
    limits: { maxClients: 50, maxMessagesPerSecond: 20, maxPayloadBytes: 65536 },
    regions: [],
    tokenAuth: true,
    staticAuth: false,
    allowedObserverCount: 1,
    ownIdentityPublicKey: null,
    totals: { received: 3, accepted: 2, rejected: 1, rateDropped: 0, authRejected: 0 },
    connections: [
      {
        clientId: 'c1',
        remoteAddress: '10.1.2.3',
        authMode: 'token',
        observerKey: OBS,
        connectedAt: 1,
        received: 3,
        accepted: 2,
        rejected: 1,
        rateDropped: 0,
        lastTopic: `meshcore/SEA/${OBS}/packets`,
        lastMessageAt: 2,
        lastRejectReason: 'missing_raw',
        lastRejectAt: 2,
      },
    ],
    recent: [],
    forwarding: [
      {
        id: 't1',
        label: 'Up',
        url: 'mqtt://upstream.example:1883',
        identityMode: 'passthrough',
        connected: true,
        forwarded: 2,
        dropped: 0,
        lastError: null,
        authStopped: false,
      },
    ],
  };
}

describe('meshcoreBrokerRoutes', () => {
  let harness: RouteTestHarness;
  let brokerId: string;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/:id/meshcore-broker', meshcoreBrokerRoutes),
    });
    // Re-create source A as a broker source; grants key off the id string.
    brokerId = harness.sourceA;
    await harness.db.sources.deleteSource(brokerId);
    await harness.db.sources.createSource({
      id: brokerId,
      name: 'Broker',
      type: 'meshcore_mqtt_broker',
      config: { listener: { port: 1884 }, auth: { tokenAudience: 'a' } },
      enabled: true,
    });
    mockGetManager.mockReturnValue({
      sourceType: 'meshcore_mqtt_broker',
      getDiagnostics: fakeDiagnostics,
    });
    setMeshCoreObserverKeyStoreForTesting(new MeshCoreObserverKeyStore('route-test-secret', true));
  });

  afterEach(async () => {
    setMeshCoreObserverKeyStoreForTesting(null);
    await harness.db.meshcoreObserverKeys.deleteBySourceId(brokerId).catch(() => {});
    await harness.cleanup();
  });

  it('GET /diagnostics needs nodes:read on THIS source', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(`/${brokerId}/meshcore-broker/diagnostics`)).status).toBe(403);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    expect((await agent.get(`/${brokerId}/meshcore-broker/diagnostics`)).status).toBe(403);
    await harness.grant(harness.limited.id, 'nodes', 'read', brokerId);
    const res = await agent.get(`/${brokerId}/meshcore-broker/diagnostics`);
    expect(res.status).toBe(200);
    expect(res.body.data.connections[0]).toMatchObject({ lastRejectReason: 'missing_raw', observerKey: OBS });
  });

  it('hides observer IPs, upstream URLs and listener errors without the endpoint view', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', brokerId);
    const limited = await harness.loginAs(harness.limited);
    const res = await limited.get(`/${brokerId}/meshcore-broker/diagnostics`);
    expect(res.body.data.connections[0].remoteAddress).toBeNull();
    expect(res.body.data.forwarding[0].url).toBe('');
    expect(res.body.data.lastError).toBeNull();

    const admin = await harness.loginAs(harness.admin);
    const full = await admin.get(`/${brokerId}/meshcore-broker/diagnostics`);
    expect(full.body.data.connections[0].remoteAddress).toBe('10.1.2.3');
    expect(full.body.data.forwarding[0].url).toBe('mqtt://upstream.example:1883');
  });

  it('reports running:false when the broker is not started, and 404 for a non-broker source', async () => {
    mockGetManager.mockReturnValue(undefined);
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.get(`/${brokerId}/meshcore-broker/diagnostics`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ running: false });
    expect((await admin.get(`/${harness.sourceB}/meshcore-broker/diagnostics`)).status).toBe(404);
  });

  it('PUT /key needs sources:write and never returns the private key', async () => {
    const limited = await harness.loginAs(harness.limited);
    await harness.grant(harness.limited.id, 'sources', 'read');
    expect((await limited.put(`/${brokerId}/meshcore-broker/key`).send({ generate: true })).status).toBe(403);

    const admin = await harness.loginAs(harness.admin);
    const res = await admin.put(`/${brokerId}/meshcore-broker/key`).send({ generate: true });
    expect(res.status).toBe(200);
    expect(res.body.data.stored).toBe(true);
    expect(res.body.data.publicKey).toMatch(/^[0-9A-F]{64}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{128}/i);

    const status = await limited.get(`/${brokerId}/meshcore-broker/key`);
    expect(status.status).toBe(200);
    expect(status.body.data.publicKey).toBe(res.body.data.publicKey);

    expect((await admin.put(`/${brokerId}/meshcore-broker/key`).send({ privateKey: 'abc' })).status).toBe(400);
    const cleared = await admin.delete(`/${brokerId}/meshcore-broker/key`);
    expect(cleared.body.data.stored).toBe(false);
  });
});
