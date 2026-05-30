/**
 * Unified Packet Monitor route tests
 *
 * Covers GET /api/unified/packets and GET /api/unified/packets/distribution:
 *  - per-source packetmonitor:read isolation
 *  - per-source content filtering (channel-read + DM privacy)
 *  - NO dedup (one row per receiving source)
 *  - composite keyset cursor plumbing + hasMore/nextCursor
 *  - distribution aggregation (byDevice / byType / bySource)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import unifiedRoutes from './unifiedRoutes.js';
import databaseService from '../../services/database.js';
import packetLogService from '../services/packetLogService.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: { getAllSources: vi.fn() },
    nodes: { getAllNodes: vi.fn(), getDistinctNodeCount: vi.fn(), getDistinctActiveNodeCount: vi.fn().mockResolvedValue(0) },
    channelDatabase: { getPermissionsForUserAsync: vi.fn().mockResolvedValue([]) },
    settings: { getSetting: vi.fn().mockResolvedValue(null) },
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
  },
}));

vi.mock('../services/packetLogService.js', () => ({
  default: {
    getPacketsAsync: vi.fn(),
    getPacketCountsByNodeAsync: vi.fn(),
    getPacketCountsByPortnumAsync: vi.fn(),
    isEnabled: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn().mockReturnValue(null) },
}));

const mockDb = databaseService as any;
const mockPackets = packetLogService as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const SOURCE_A = { id: 'src-a', name: 'Source A', type: 'meshtastic_tcp', enabled: true };
const SOURCE_B = { id: 'src-b', name: 'Source B', type: 'meshtastic_tcp', enabled: true };

const createApp = (user: any = null): Express => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  app.use((req: any, _res: any, next: any) => {
    if (user) {
      req.session.userId = user.id;
      mockDb.findUserByIdAsync.mockResolvedValue(user);
    }
    next();
  });
  app.use('/', unifiedRoutes);
  return app;
};

/** Minimal packet row shaped like the repo layer (post-normalize). */
function mkPkt(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    packet_id: 555,
    timestamp: 1_700_000_000_000,
    from_node: 0x11111111,
    to_node: 0xffffffff,
    channel: 0,
    portnum: 3, // POSITION_APP (not a DM)
    encrypted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPackets.isEnabled.mockResolvedValue(true);
  mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([]);
});

describe('GET /api/unified/packets', () => {
  it('only returns packets from sources the user can read', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    // Regular user: packetmonitor:read on A only.
    mockDb.checkPermissionAsync.mockImplementation(async (_uid: number, _res: string, _act: string, sourceId: string) => sourceId === 'src-a');
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ channel_0: { read: true }, messages: { read: true } });
    mockPackets.getPacketsAsync.mockImplementation(async (opts: any) => [mkPkt({ id: opts.sourceId === 'src-a' ? 10 : 20, channel: 0 })]);

    const res = await request(createApp(regularUser)).get('/packets');
    expect(res.status).toBe(200);
    expect(res.body.packets.every((p: any) => p.sourceId === 'src-a')).toBe(true);
    // Source list (filter dropdown) only includes readable sources.
    expect(res.body.sources).toEqual([{ id: 'src-a', name: 'Source A' }]);
    // src-b must never be queried for packets.
    const queried = mockPackets.getPacketsAsync.mock.calls.map((c: any[]) => c[0].sourceId);
    expect(queried).not.toContain('src-b');
  });

  it('does NOT dedup — one row per source for the same mesh packet', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    // Same packet_id + timestamp heard by both sources.
    mockPackets.getPacketsAsync.mockImplementation(async (opts: any) => [
      mkPkt({ id: opts.sourceId === 'src-a' ? 1 : 2, packet_id: 999, timestamp: 1_700_000_000_000 }),
    ]);

    const res = await request(createApp(adminUser)).get('/packets');
    expect(res.status).toBe(200);
    expect(res.body.packets).toHaveLength(2);
    expect(new Set(res.body.packets.map((p: any) => p.sourceName))).toEqual(new Set(['Source A', 'Source B']));
  });

  it('applies per-source content filtering (channel-read + DM privacy)', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    // User can read channel 0 only, and cannot read messages.
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ channel_0: { read: true }, messages: { read: false } });
    mockPackets.getPacketsAsync.mockResolvedValue([
      mkPkt({ id: 1, channel: 0, encrypted: false, portnum: 3 }),                 // visible (ch0 readable)
      mkPkt({ id: 2, channel: 2, encrypted: false, portnum: 3 }),                 // hidden  (ch2 not readable)
      mkPkt({ id: 3, channel: 2, encrypted: true, portnum: 3 }),                  // visible (encrypted always)
      mkPkt({ id: 4, channel: 0, encrypted: false, portnum: 1, to_node: 123 }),   // hidden  (DM, no messages:read)
    ]);

    const res = await request(createApp(regularUser)).get('/packets');
    expect(res.status).toBe(200);
    const ids = res.body.packets.map((p: any) => p.id).sort();
    expect(ids).toEqual([1, 3]);
  });

  it('parses the composite cursor and reports hasMore/nextCursor', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    // Return a saturated page (>= fetchLimit = 2*limit) so hasMore is true.
    const rows = Array.from({ length: 6 }, (_, i) => mkPkt({ id: 100 - i, timestamp: 1_700_000_000_000 - i }));
    mockPackets.getPacketsAsync.mockResolvedValue(rows);

    const res = await request(createApp(adminUser)).get('/packets?limit=3&cursor=1700000000050_77');
    expect(res.status).toBe(200);
    // limit=3 → fetchLimit=6 passed through; cursor parsed into untilTs/untilId.
    const callOpts = mockPackets.getPacketsAsync.mock.calls[0][0];
    expect(callOpts.limit).toBe(6);
    expect(callOpts.untilTs).toBe(1700000000050);
    expect(callOpts.untilId).toBe(77);
    expect(res.body.packets).toHaveLength(3);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).toMatch(/^\d+_\d+$/);
  });
});

describe('GET /api/unified/packets/distribution', () => {
  it('aggregates byDevice / byType across sources and tallies bySource', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockPackets.getPacketCountsByNodeAsync.mockImplementation(async (opts: any) =>
      opts.sourceId === 'src-a'
        ? [{ from_node: 100, from_node_id: '!64', from_node_longName: 'Alpha', count: 5 }]
        : [{ from_node: 100, from_node_id: '!64', from_node_longName: 'Alpha', count: 3 }]
    );
    mockPackets.getPacketCountsByPortnumAsync.mockImplementation(async (opts: any) =>
      opts.sourceId === 'src-a'
        ? [{ portnum: 1, portnum_name: 'TEXT_MESSAGE_APP', count: 4 }, { portnum: 3, portnum_name: 'POSITION_APP', count: 6 }]
        : [{ portnum: 1, portnum_name: 'TEXT_MESSAGE_APP', count: 2 }]
    );

    const res = await request(createApp(adminUser)).get('/packets/distribution');
    expect(res.status).toBe(200);
    // byDevice: node 100 summed across sources = 8.
    expect(res.body.byDevice).toEqual([{ from_node: 100, from_node_id: '!64', from_node_longName: 'Alpha', count: 8 }]);
    // byType: portnum 1 = 4+2 = 6, portnum 3 = 6.
    const byType = Object.fromEntries(res.body.byType.map((t: any) => [t.portnum, t.count]));
    expect(byType).toEqual({ 1: 6, 3: 6 });
    // bySource: A = 10, B = 2; total = 12.
    expect(res.body.bySource).toEqual([
      { sourceId: 'src-a', sourceName: 'Source A', count: 10 },
      { sourceId: 'src-b', sourceName: 'Source B', count: 2 },
    ]);
    expect(res.body.total).toBe(12);
  });

  it('excludes sources the user cannot read from the aggregation', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.checkPermissionAsync.mockImplementation(async (_uid: number, _res: string, _act: string, sourceId: string) => sourceId === 'src-a');
    mockPackets.getPacketCountsByNodeAsync.mockResolvedValue([]);
    mockPackets.getPacketCountsByPortnumAsync.mockResolvedValue([{ portnum: 3, portnum_name: 'POSITION_APP', count: 7 }]);

    const res = await request(createApp(regularUser)).get('/packets/distribution');
    expect(res.status).toBe(200);
    expect(res.body.bySource).toEqual([{ sourceId: 'src-a', sourceName: 'Source A', count: 7 }]);
    expect(mockPackets.getPacketCountsByPortnumAsync).toHaveBeenCalledTimes(1);
  });
});
