/**
 * GET /ingest/overview — who sees the region and the broker host.
 *
 * The page header showed a dash for both because the view read them from
 * `getStatus()`, which never carried them (and must not: that payload answers
 * callers with no login, #5596). The overview route now supplies them, and
 * these tests pin the rule for each kind of viewer against the real auth
 * middleware and a real `MeshCoreMqttManager`:
 *
 *   region     anyone who passes the route's `nodes:read` gate
 *   brokerUrl  admin, or a signed-in user with `sources:read`; null otherwise
 *
 * No viewer ever receives `user:password@` from the URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MeshCoreMqttManager } from '../meshcoreMqttManager.js';

const managers = new Map<string, unknown>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => managers.get(id),
    getAllManagers: () => [...managers.values()],
  },
}));

import ingestReadRoutes from './meshcoreIngestReadRoutes.js';

const SECRET_USER = 'feeduser';
const SECRET_PASS = 'hunter2@with-at';
const RAW_URL = `wss://${SECRET_USER}:${SECRET_PASS}@broker.example:443/mqtt`;
const REDACTED_URL = 'wss://***@broker.example:443/mqtt';

let harness: RouteTestHarness;
let overviewPath: string;

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: app => app.use('/api/sources/:id/meshcore', ingestReadRoutes),
  });
  managers.clear();
  // Never started: no broker connection is made. Lower-case region on purpose.
  managers.set(
    harness.sourceA,
    new MeshCoreMqttManager(harness.sourceA, 'Ingest A', {
      brokerUrl: RAW_URL,
      region: 'mco',
      username: SECRET_USER,
      password: SECRET_PASS,
    }),
  );
  overviewPath = `/api/sources/${harness.sourceA}/meshcore/ingest/overview`;
});

afterEach(async () => {
  await harness.cleanup();
});

function expectNoCredentials(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(SECRET_PASS);
  expect(text).not.toContain('hunter2');
  expect(text).not.toContain(`${SECRET_USER}:`);
}

describe('GET /ingest/overview — region and broker visibility', () => {
  it('admin sees the region and the redacted broker URL', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(overviewPath);
    expect(res.status).toBe(200);
    expect(res.body.data.region).toBe('MCO');
    expect(res.body.data.brokerUrl).toBe(REDACTED_URL);
    expectNoCredentials(res.body);
  });

  it('keeps region and broker out of the status object', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(overviewPath);
    expect(res.body.data.status).not.toHaveProperty('brokerUrl');
    expect(res.body.data.status).not.toHaveProperty('region');
  });

  it('a user with nodes:read but not sources:read sees the region, not the host', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(overviewPath);
    expect(res.status).toBe(200);
    expect(res.body.data.region).toBe('MCO');
    expect(res.body.data.brokerUrl).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('broker.example');
    expectNoCredentials(res.body);
  });

  it('a user with nodes:read and sources:read sees the redacted URL', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'sources', 'read');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(overviewPath);
    expect(res.status).toBe(200);
    expect(res.body.data.brokerUrl).toBe(REDACTED_URL);
    expectNoCredentials(res.body);
  });

  it('a user with no grant on the source is refused outright', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(overviewPath);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('broker.example');
  });

  it('anonymous without nodes:read is refused', async () => {
    await harness.revokeAll(harness.anonymous.id);
    const agent = await harness.loginAs(null);
    const res = await agent.get(overviewPath);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('broker.example');
  });

  it('anonymous with nodes:read sees the region but never the host', async () => {
    await harness.grant(harness.anonymous.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(null);
    const res = await agent.get(overviewPath);
    expect(res.status).toBe(200);
    expect(res.body.data.region).toBe('MCO');
    expect(res.body.data.brokerUrl).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('broker.example');
    expectNoCredentials(res.body);
  });

  it('anonymous granted sources:read still does not get the host', async () => {
    // #5596: the broker host stays away from callers with no login, whatever
    // the anonymous account has been granted.
    await harness.revokeAll(harness.anonymous.id);
    await harness.grant(harness.anonymous.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.anonymous.id, 'sources', 'read');
    const agent = await harness.loginAs(null);
    const res = await agent.get(overviewPath);
    expect(res.status).toBe(200);
    expect(
      await harness.db.checkPermissionAsync(harness.anonymous.id, 'sources', 'read'),
    ).toBe(true);
    expect(res.body.data.brokerUrl).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('broker.example');
  });
});
