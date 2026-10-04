/**
 * Who gets the node address from the connection routes.
 *
 * The address is a connection endpoint, so it follows the same rule as
 * `config.host` on the source list: a signed-in user holding `sources:read`,
 * or an admin. Signed in is not enough on its own, and a caller with no login
 * never gets it.
 *
 * Real session + auth middleware + permission SQL via createRouteTestApp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import connectionRoutes from './connectionRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const NODE_HOST = 'node-host-sentinel.example';
const DEFAULT_HOST = 'default-host-sentinel.example';

const mockManager = vi.hoisted(() => ({
  sourceId: 'rt-source-a',
  getConnectionStatus: vi.fn(),
}));

// Non-DB mocks only: no test may open a real node connection.
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn().mockReturnValue(mockManager),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn().mockReturnValue(undefined), getAllManagers: vi.fn().mockReturnValue([]) },
}));
vi.mock('../config/environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/environment.js')>();
  return {
    ...actual,
    getEnvironmentConfig: () => ({
      ...actual.getEnvironmentConfig(),
      meshtasticNodeIp: 'default-host-sentinel.example',
      meshtasticTcpPort: 4403,
    }),
  };
});

type Caller = 'anonymous' | 'anonymousWithRead' | 'limited' | 'viewer' | 'admin';
const ALLOWED: Record<Caller, boolean> = {
  anonymous: false,
  anonymousWithRead: false,
  limited: false,
  viewer: true,
  admin: true,
};

describe('connection routes — node address', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/connection', connectionRoutes) });
    mockManager.getConnectionStatus.mockResolvedValue({ connected: true, nodeResponsive: true, nodeIp: NODE_HOST });
  });

  afterEach(async () => {
    await harness.revokeAll(harness.anonymous.id);
    await harness.cleanup();
  });

  async function agentFor(caller: Caller) {
    switch (caller) {
      case 'anonymous':
        return harness.loginAs(null);
      case 'anonymousWithRead':
        await harness.grant(harness.anonymous.id, 'sources', 'read');
        return harness.loginAs(null);
      case 'limited':
        return harness.loginAs(harness.limited);
      case 'viewer':
        await harness.grant(harness.limited.id, 'sources', 'read');
        return harness.loginAs(harness.limited);
      case 'admin':
        return harness.loginAs(harness.admin);
    }
  }

  it.each(Object.keys(ALLOWED) as Caller[])('GET /connection as %s', async (caller) => {
    const agent = await agentFor(caller);
    const res = await agent.get('/connection');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    if (ALLOWED[caller]) {
      expect(res.body.nodeIp).toBe(NODE_HOST);
    } else {
      expect(JSON.stringify(res.body)).not.toContain(NODE_HOST);
    }
  });

  it.each(['limited', 'viewer', 'admin'] as Caller[])('GET /connection/info as %s', async (caller) => {
    const agent = await agentFor(caller);
    const res = await agent.get('/connection/info');
    expect(res.status).toBe(200);
    // Ports and the override flag are not an address: everyone signed in gets them.
    expect(res.body.tcpPort).toBe(4403);
    expect(res.body.isOverridden).toBe(false);
    if (ALLOWED[caller]) {
      expect(res.body.nodeIp).toBe(NODE_HOST);
      expect(res.body.defaultIp).toBe(DEFAULT_HOST);
    } else {
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(NODE_HOST);
      expect(text).not.toContain(DEFAULT_HOST);
    }
  });

  it('GET /connection/info still refuses a caller with no login', async () => {
    const agent = await agentFor('anonymous');
    const res = await agent.get('/connection/info');
    expect(res.status).toBe(401);
  });
});
