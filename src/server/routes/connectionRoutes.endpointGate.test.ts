/**
 * Who gets the node address from the connection routes.
 *
 * The address is a connection endpoint, so it follows ONE rule everywhere, the
 * rule for `config.host` on the source list and for `/api/poll`
 * (`mayViewSourceEndpoint`): a signed-in user holding `sources:read`, or an
 * admin. `connection:read` decides the rest of the status (the full status,
 * the ports, the override flag) and has no say on the address: it neither
 * grants it nor is needed for it. A caller with no login never gets it.
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

type Caller =
  | 'anonymous'
  | 'anonymousWithRead'
  | 'limited'
  | 'sourcesReadOnly'
  | 'connectionReadOnly'
  | 'otherSourceConnection'
  | 'viewer'
  | 'admin';
/** Who gets the address: `sources:read` (signed in) or admin, and nothing else. */
const ALLOWED: Record<Caller, boolean> = {
  anonymous: false,
  // The anonymous user is not signed in, whatever it is granted.
  anonymousWithRead: false,
  limited: false,
  // `sources:read` without `connection:read` on this source.
  sourcesReadOnly: true,
  // `connection:read` on this source without `sources:read`.
  connectionReadOnly: false,
  // `sources:read`, with `connection:read` on another source only.
  otherSourceConnection: true,
  viewer: true,
  admin: true,
};
/** Who holds `connection:read` on the source, and so gets more than the link flags. */
const READS_CONNECTION: Record<Caller, boolean> = {
  anonymous: false,
  anonymousWithRead: false,
  limited: false,
  sourcesReadOnly: false,
  connectionReadOnly: true,
  otherSourceConnection: false,
  viewer: true,
  admin: true,
};

const LINK_FLAGS = ['configuring', 'connected', 'nodeResponsive', 'userDisconnected'];

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
      case 'sourcesReadOnly':
        await harness.grant(harness.limited.id, 'sources', 'read');
        return harness.loginAs(harness.limited);
      case 'connectionReadOnly':
        await harness.grant(harness.limited.id, 'connection', 'read', harness.sourceA);
        return harness.loginAs(harness.limited);
      case 'otherSourceConnection':
        await harness.grant(harness.limited.id, 'sources', 'read');
        await harness.grant(harness.limited.id, 'connection', 'read', harness.sourceB);
        return harness.loginAs(harness.limited);
      case 'viewer':
        await harness.grant(harness.limited.id, 'sources', 'read');
        await harness.grant(harness.limited.id, 'connection', 'read', harness.sourceA);
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
    if (!READS_CONNECTION[caller]) {
      // The link flags, plus the address for a caller the one rule allows.
      expect(Object.keys(res.body).sort()).toEqual([...LINK_FLAGS, ...(ALLOWED[caller] ? ['nodeIp'] : [])].sort());
    }
  });

  const SIGNED_IN: Caller[] = ['limited', 'sourcesReadOnly', 'connectionReadOnly', 'otherSourceConnection', 'viewer', 'admin'];

  it.each(SIGNED_IN)('GET /connection/info as %s', async (caller) => {
    const agent = await agentFor(caller);
    const res = await agent.get('/connection/info');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    if (READS_CONNECTION[caller]) {
      // Ports and the override flag are not an address: `connection:read` gets them.
      expect(res.body.tcpPort).toBe(4403);
      expect(res.body.isOverridden).toBe(false);
    } else {
      // The link flags, plus the addresses for a caller the one rule allows.
      // Never the ports or the override flag.
      expect(Object.keys(res.body).sort()).toEqual([...LINK_FLAGS, ...(ALLOWED[caller] ? ['defaultIp', 'nodeIp'] : [])].sort());
    }
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
