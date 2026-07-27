/**
 * v1 API — actions endpoint tests
 *
 * Covers POST /api/v1/sources/:sourceId/actions/{traceroute,request-position,
 * request-nodeinfo,request-neighbors} including:
 *   - 200 happy paths
 *   - 400 missing/invalid destination
 *   - 401 unauthenticated
 *   - 403 insufficient permissions (per-source)
 *   - 429 rate-limited (request-neighbors)
 *   - 403 not-local/0-hop (request-neighbors)
 *   - per-source scoping of permission checks and manager lookup
 *   - canonical message ID format for system messages
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { neighborInfoRateLimitMap } from './actions.js';
import { TxDisabledError } from '../../errors/txDisabledError.js';

// ──────────────────────────────────────────────────────────────────────────────
// Shared test constants
// ──────────────────────────────────────────────────────────────────────────────

const SOURCE_A = 'source-a-uuid';
const SOURCE_B = 'source-b-uuid';

const LOCAL_NODE_NUM = 0xdeadbeef;
const LOCAL_NODE_ID = '!deadbeef';
const DEST_NUM = 0xa1b2c3d4;

const adminUser  = { id: 1, username: 'admin',  isActive: true, isAdmin: true  };
const normalUser = { id: 2, username: 'normal', isActive: true, isAdmin: false };

// ──────────────────────────────────────────────────────────────────────────────
// Mock: databaseService
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('../../../services/database.js', () => ({
  default: {
    checkPermissionAsync: vi.fn(),
    sources: {
      // attachSource resolves :sourceId via this call before any handler
      // logic runs. Tests that exercise unknown sources can override it
      // per-case to return null.
      getSource: vi.fn(),
      getAllSources: vi.fn(),
    },
    nodes: {
      getNode: vi.fn(),
    },
    messages: {
      insertMessage: vi.fn(),
    },
  },
}));

// ──────────────────────────────────────────────────────────────────────────────
// Mock: resolveSourceManager — returns a per-call mock manager
// ──────────────────────────────────────────────────────────────────────────────

const mockManager = {
  sendTraceroute:        vi.fn(),
  sendPositionRequest:   vi.fn(),
  sendNodeInfoRequest:   vi.fn(),
  sendNeighborInfoRequest: vi.fn(),
  getLocalNodeInfo:      vi.fn(),
};

vi.mock('../../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn(() => mockManager),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks
// ──────────────────────────────────────────────────────────────────────────────

import databaseService from '../../../services/database.js';
import { resolveSourceManager } from '../../utils/resolveSourceManager.js';
import actionsRouter from './actions.js';

const mockDb = databaseService as any;
const mockResolveSourceManager = resolveSourceManager as ReturnType<typeof vi.fn>;

// ──────────────────────────────────────────────────────────────────────────────
// App factory
// ──────────────────────────────────────────────────────────────────────────────

function buildApp(user: typeof adminUser | typeof normalUser | null): Express {
  const app = express();
  app.use(express.json());
  // Simulate requireAPIToken setting req.user
  app.use((req: any, _res, next) => {
    if (user) req.user = user;
    next();
  });
  // Mount with mergeParams so :sourceId is visible inside the router
  app.use('/api/v1/sources/:sourceId/actions', actionsRouter);
  return app;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function post(app: Express, sourceId: string, path: string, body: object) {
  return request(app)
    .post(`/api/v1/sources/${sourceId}/actions/${path}`)
    .send(body)
    .set('Content-Type', 'application/json');
}

// ──────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ──────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  neighborInfoRateLimitMap.clear();

  // Default: grant all permissions
  mockDb.checkPermissionAsync.mockResolvedValue(true);
  // Default: any sourceId resolves to a stub source row so attachSource
  // proceeds to the handler. Tests can override per-case.
  mockDb.sources.getSource.mockImplementation(async (id: string) => ({
    id,
    name: id,
    type: 'meshtastic_tcp',
    config: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    createdBy: null,
  }));
  mockDb.sources.getAllSources.mockResolvedValue([]);
  // Default: no node found → channel 0
  mockDb.nodes.getNode.mockResolvedValue(null);
  // Default: insertMessage succeeds
  mockDb.messages.insertMessage.mockResolvedValue(true);
  // Default: manager resolves to mockManager for any sourceId
  mockResolveSourceManager.mockReturnValue(mockManager);
  // Default: local node is available
  mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: LOCAL_NODE_NUM, nodeId: LOCAL_NODE_ID });
  // Default: send operations succeed
  mockManager.sendTraceroute.mockResolvedValue(undefined);
  mockManager.sendPositionRequest.mockResolvedValue({ packetId: 1001, requestId: 2001 });
  mockManager.sendNodeInfoRequest.mockResolvedValue({ packetId: 1002, requestId: 2002 });
  mockManager.sendNeighborInfoRequest.mockResolvedValue({ packetId: 1003, requestId: 2003 });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /traceroute
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /traceroute', () => {
  it('returns 200 and calls sendTraceroute with correct args', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: `!${DEST_NUM.toString(16)}` });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.destination).toBe(`!${DEST_NUM.toString(16).padStart(8, '0')}`);
    expect(mockManager.sendTraceroute).toHaveBeenCalledWith(DEST_NUM, 0);
    expect(mockResolveSourceManager).toHaveBeenCalledWith(SOURCE_A);
  });

  it('uses the node channel from the database', async () => {
    mockDb.nodes.getNode.mockResolvedValue({ channel: 3, hopsAway: 1 });
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: `!${DEST_NUM.toString(16)}` });

    expect(res.status).toBe(200);
    expect(mockManager.sendTraceroute).toHaveBeenCalledWith(DEST_NUM, 3);
    expect(mockDb.nodes.getNode).toHaveBeenCalledWith(DEST_NUM, SOURCE_A);
  });

  it('accepts channel override in request body', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: `!${DEST_NUM.toString(16)}`, channel: 5 });

    expect(res.status).toBe(200);
    expect(mockManager.sendTraceroute).toHaveBeenCalledWith(DEST_NUM, 5);
  });

  it('returns 400 when destination is missing', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', {});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for nodeNum 0 (invalid destination)', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { nodeNum: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 401 when user is not authenticated', async () => {
    const app = buildApp(null);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: '!a1b2c3d4' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks traceroute:write on the source', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(403);
    expect(res.body.required).toEqual({ resource: 'traceroute', action: 'write', sourceId: SOURCE_A });
  });

  it('returns 409 TX_DISABLED when transmit is disabled on this source', async () => {
    mockManager.sendTraceroute.mockRejectedValue(new TxDisabledError());
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('TX_DISABLED');
  });

  it('passes sourceId to checkPermissionAsync (per-source)', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'traceroute', { destination: '!a1b2c3d4' });

    const permCalls = mockDb.checkPermissionAsync.mock.calls;
    expect(permCalls.length).toBeGreaterThan(0);
    expect(permCalls[0][3]).toBe(SOURCE_A);
  });

  it('uses SOURCE_B manager when sourceId is SOURCE_B', async () => {
    const managerB = { ...mockManager, sendTraceroute: vi.fn().mockResolvedValue(undefined) };
    mockResolveSourceManager.mockImplementation((id: string) => (id === SOURCE_B ? managerB : mockManager));

    const app = buildApp(normalUser);
    await post(app, SOURCE_B, 'traceroute', { destination: '!a1b2c3d4' });

    expect(managerB.sendTraceroute).toHaveBeenCalled();
    expect(mockManager.sendTraceroute).not.toHaveBeenCalled();
  });

  it('admin bypasses permission check', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = buildApp(adminUser);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(200);
    expect(mockDb.checkPermissionAsync).not.toHaveBeenCalled();
  });

  it('accepts decimal nodeNum', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { nodeNum: DEST_NUM });
    expect(res.status).toBe(200);
    expect(mockManager.sendTraceroute).toHaveBeenCalledWith(DEST_NUM, expect.any(Number));
  });

  it('accepts 0x-prefixed hex destination', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: `0x${DEST_NUM.toString(16)}` });
    expect(res.status).toBe(200);
    expect(mockManager.sendTraceroute).toHaveBeenCalledWith(DEST_NUM, expect.any(Number));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /request-position
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /request-position', () => {
  it('returns 200 and calls sendPositionRequest', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockManager.sendPositionRequest).toHaveBeenCalled();
  });

  it('inserts system message with canonical ID format', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });

    expect(mockDb.messages.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${SOURCE_A}_${LOCAL_NODE_NUM}_1001`,
      }),
      SOURCE_A
    );
  });

  it('passes sourceId as second arg to insertMessage', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });

    const [, passedSourceId] = mockDb.messages.insertMessage.mock.calls[0];
    expect(passedSourceId).toBe(SOURCE_A);
  });

  it('omits requestId for broadcast destination', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-position', { destination: '!ffffffff' });

    const [msg] = mockDb.messages.insertMessage.mock.calls[0];
    expect(msg.requestId).toBeUndefined();
    expect(msg.text).toBe('Position broadcast sent');
  });

  it('stores DM as channel -1 when channel is 0', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });

    const [msg] = mockDb.messages.insertMessage.mock.calls[0];
    expect(msg.channel).toBe(-1);
  });

  it('stores non-zero channel as-is', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4', channel: 2 });

    const [msg] = mockDb.messages.insertMessage.mock.calls[0];
    expect(msg.channel).toBe(2);
  });

  it('skips insertMessage when localNodeInfo is null', async () => {
    mockManager.getLocalNodeInfo.mockReturnValue(null);
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(200);
    expect(mockDb.messages.insertMessage).not.toHaveBeenCalled();
  });

  it('returns 400 for missing destination', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-position', {});
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(null);
    const res = await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks messages:write on source', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(403);
    expect(res.body.required).toEqual({ resource: 'messages', action: 'write', sourceId: SOURCE_A });
  });

  it('passes sourceId to checkPermissionAsync', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });

    expect(mockDb.checkPermissionAsync.mock.calls[0][3]).toBe(SOURCE_A);
  });

  it('returns 409 TX_DISABLED when transmit is disabled on this source', async () => {
    mockManager.sendPositionRequest.mockRejectedValue(new TxDisabledError());
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-position', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('TX_DISABLED');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /request-nodeinfo
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /request-nodeinfo', () => {
  it('returns 200 and calls sendNodeInfoRequest', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-nodeinfo', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockManager.sendNodeInfoRequest).toHaveBeenCalled();
  });

  it('inserts system message with canonical ID format', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-nodeinfo', { destination: '!a1b2c3d4' });

    expect(mockDb.messages.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${SOURCE_A}_${LOCAL_NODE_NUM}_1002`,
        requestId: 2002,
      }),
      SOURCE_A
    );
  });

  it('returns 400 for missing destination', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-nodeinfo', {});
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(null);
    const res = await post(app, SOURCE_A, 'request-nodeinfo', { destination: '!a1b2c3d4' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks messages:write on source', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-nodeinfo', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(403);
    expect(res.body.required).toEqual({ resource: 'messages', action: 'write', sourceId: SOURCE_A });
  });

  it('passes sourceId to checkPermissionAsync', async () => {
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-nodeinfo', { destination: '!a1b2c3d4' });

    expect(mockDb.checkPermissionAsync.mock.calls[0][3]).toBe(SOURCE_A);
  });

  it('returns 409 TX_DISABLED when transmit is disabled on this source', async () => {
    mockManager.sendNodeInfoRequest.mockRejectedValue(new TxDisabledError());
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-nodeinfo', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('TX_DISABLED');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /request-neighbors
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /request-neighbors', () => {
  it('returns 200 for the local node', async () => {
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: DEST_NUM, nodeId: '!a1b2c3d4' });
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-neighbors', { destination: `!${DEST_NUM.toString(16)}` });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockManager.sendNeighborInfoRequest).toHaveBeenCalled();
  });

  it('returns 200 for a 0-hop node', async () => {
    mockDb.nodes.getNode.mockResolvedValue({ hopsAway: 0, channel: 1 });
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-neighbors', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(200);
  });

  it('returns 403 for a non-local non-0-hop node', async () => {
    mockDb.nodes.getNode.mockResolvedValue({ hopsAway: 2, channel: 0 });
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-neighbors', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/0-hop/);
  });

  it('returns 403 for unknown node (not in DB)', async () => {
    mockDb.nodes.getNode.mockResolvedValue(null);
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-neighbors', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(403);
  });

  it('returns 429 when rate-limited', async () => {
    mockDb.nodes.getNode.mockResolvedValue({ hopsAway: 0, channel: 0 });
    // Pre-populate rate limit for SOURCE_A
    neighborInfoRateLimitMap.set(`${SOURCE_A}:${DEST_NUM}`, Date.now());

    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-neighbors', { destination: `!${DEST_NUM.toString(16)}` });

    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty('retryAfter');
  });

  it('rate limit is per-source: SOURCE_B not affected by SOURCE_A limit', async () => {
    mockDb.nodes.getNode.mockResolvedValue({ hopsAway: 0, channel: 0 });
    // Pre-populate rate limit for SOURCE_A only
    neighborInfoRateLimitMap.set(`${SOURCE_A}:${DEST_NUM}`, Date.now());

    const app = buildApp(normalUser);
    const resB = await post(app, SOURCE_B, 'request-neighbors', { destination: `!${DEST_NUM.toString(16)}` });

    expect(resB.status).toBe(200);
  });

  it('returns 400 for missing destination', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-neighbors', {});
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(null);
    const res = await post(app, SOURCE_A, 'request-neighbors', { destination: '!a1b2c3d4' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user lacks traceroute:write on source', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-neighbors', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(403);
    expect(res.body.required).toEqual({ resource: 'traceroute', action: 'write', sourceId: SOURCE_A });
  });

  it('passes sourceId to checkPermissionAsync', async () => {
    mockDb.nodes.getNode.mockResolvedValue({ hopsAway: 0, channel: 0 });
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-neighbors', { destination: '!a1b2c3d4' });

    expect(mockDb.checkPermissionAsync.mock.calls[0][3]).toBe(SOURCE_A);
  });

  it('passes sourceId to getNode for source scoping', async () => {
    mockDb.nodes.getNode.mockResolvedValue({ hopsAway: 0, channel: 0 });
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-neighbors', { destination: '!a1b2c3d4' });

    expect(mockDb.nodes.getNode).toHaveBeenCalledWith(expect.any(Number), SOURCE_A);
  });

  it('rate-limit key includes sourceId to prevent cross-source interference', async () => {
    mockDb.nodes.getNode.mockResolvedValue({ hopsAway: 0, channel: 0 });
    const app = buildApp(normalUser);
    await post(app, SOURCE_A, 'request-neighbors', { destination: `!${DEST_NUM.toString(16)}` });

    expect(neighborInfoRateLimitMap.has(`${SOURCE_A}:${DEST_NUM}`)).toBe(true);
    expect(neighborInfoRateLimitMap.has(`${SOURCE_B}:${DEST_NUM}`)).toBe(false);
  });

  it('returns 409 TX_DISABLED when transmit is disabled on this source', async () => {
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: DEST_NUM, nodeId: '!a1b2c3d4' });
    mockManager.sendNeighborInfoRequest.mockRejectedValue(new TxDisabledError());
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'request-neighbors', { destination: `!${DEST_NUM.toString(16)}` });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('TX_DISABLED');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveDestination edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe('destination resolution edge cases', () => {
  it('accepts nodeId key as alias for destination', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { nodeId: '!a1b2c3d4' });
    expect(res.status).toBe(200);
  });

  it('accepts nodeNum key as alias for destination', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { nodeNum: DEST_NUM });
    expect(res.status).toBe(200);
  });

  it('rejects plain hex without prefix (ambiguous)', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { destination: 'a1b2c3d4' });
    expect(res.status).toBe(400);
  });

  it('rejects nodeNum out of valid range', async () => {
    const app = buildApp(normalUser);
    const res = await post(app, SOURCE_A, 'traceroute', { nodeNum: 0x1FFFFFFFF });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// `default` source alias — resolved by attachSource
// ══════════════════════════════════════════════════════════════════════════════

describe('default source alias', () => {
  it('resolves `default` to the first enabled source the admin can see', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([
      { id: SOURCE_A, name: 'A', type: 'meshtastic_tcp', config: {}, enabled: true,  createdAt: 1, updatedAt: 1, createdBy: null },
      { id: SOURCE_B, name: 'B', type: 'meshtastic_tcp', config: {}, enabled: true,  createdAt: 2, updatedAt: 2, createdBy: null },
    ]);

    const app = buildApp(adminUser);
    const res = await post(app, 'default', 'traceroute', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(200);
    // attachSource normalises req.params.sourceId to the resolved UUID, so the
    // handler asks the registry for SOURCE_A (the earliest-createdAt enabled row).
    expect(mockResolveSourceManager).toHaveBeenCalledWith(SOURCE_A);
  });

  it('returns 404 when no enabled source exists for `default`', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([]);

    const app = buildApp(adminUser);
    const res = await post(app, 'default', 'traceroute', { destination: '!a1b2c3d4' });

    expect(res.status).toBe(404);
  });
});
