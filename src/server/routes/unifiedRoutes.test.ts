/**
 * Unified Routes Tests
 *
 * Tests for GET /api/unified/messages, /api/unified/channels, and
 * /api/unified/telemetry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import unifiedRoutes, { extractPacketIdFromRowId } from './unifiedRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: {
      getAllSources: vi.fn(),
    },
    messages: {
      getMessages: vi.fn(),
      getMessagesBeforeInChannel: vi.fn(),
    },
    channels: {
      getAllChannels: vi.fn(),
    },
    nodes: {
      getAllNodes: vi.fn(),
    },
    telemetry: {
      getLatestTelemetryByNode: vi.fn(),
    },
    channelDatabase: {
      getAllAsync: vi.fn(),
      getPermissionsForUserAsync: vi.fn(),
    },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  }
}));

// sourceManagerRegistry is imported dynamically inside the route handler
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
  }
}));

const mockDb = databaseService as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const createApp = (user: any = null): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    })
  );
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

const SOURCE_A = { id: 'src-a', name: 'Source A', type: 'meshtastic_tcp', enabled: true };
const SOURCE_B = { id: 'src-b', name: 'Source B', type: 'meshtastic_tcp', enabled: true };

// Channel list fixtures — same name "Primary" lives at slot 0 on both sources.
const CHANNELS_A = [
  { id: 0, name: 'Primary', role: 1 },
  { id: 1, name: 'Admin',   role: 2 },
];
const CHANNELS_B = [
  { id: 0, name: 'Primary', role: 1 },
];

/** Build a message row the way the repo layer returns it (post-normalize). */
function mkMsg(overrides: Record<string, any> = {}) {
  return {
    id: 'row-1',
    fromNodeNum: 0xaabbccdd,
    fromNodeId: '!aabbccdd',
    toNodeNum: 0xffffffff,
    toNodeId: '!ffffffff',
    text: 'hello',
    channel: 0,
    portnum: 1,
    requestId: 111,
    timestamp: 1_700_000_000_000,
    rxTime: 1_700_000_000_000,
    hopStart: 3,
    hopLimit: 3,
    rxSnr: -5.5,
    rxRssi: -110,
    relayNode: null,
    replyId: null,
    emoji: null,
    viaMqtt: null,
    ackFailed: null,
    routingErrorReceived: null,
    deliveryState: null,
    wantAck: null,
    ackFromNode: null,
    createdAt: 1_700_000_000_000,
    decryptedBy: null,
    ...overrides,
  };
}

const NODE_ONE = { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' };
const NODE_TWO = { nodeId: '!11223344', nodeNum: 0x11223344, longName: 'Node Two', shortName: 'N2' };

describe('Unified Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.findUserByIdAsync.mockResolvedValue(adminUser);
    mockDb.findUserByUsernameAsync.mockResolvedValue(null);
    mockDb.getUserPermissionSetAsync.mockResolvedValue({ resources: {}, isAdmin: false });
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    mockDb.nodes.getAllNodes.mockResolvedValue([NODE_ONE, NODE_TWO]);
    // Default: no virtual channels / no virtual channel permissions. Tests
    // covering virtual channel behavior override these per-case.
    mockDb.channelDatabase.getAllAsync.mockResolvedValue([]);
    mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([]);
  });

  // ── /channels ─────────────────────────────────────────────────────────────

  describe('GET /channels', () => {
    it('returns de-duplicated channel names across all accessible sources', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.channels.getAllChannels.mockImplementation((sourceId: string) =>
        Promise.resolve(sourceId === 'src-a' ? CHANNELS_A : CHANNELS_B)
      );

      const app = createApp(adminUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      // "Admin" (src-a only) and "Primary" (both)
      expect(res.body).toHaveLength(2);
      const primary = res.body.find((c: any) => c.name === 'Primary');
      expect(primary.sources).toHaveLength(2);
      expect(primary.sources.map((s: any) => s.sourceId).sort()).toEqual(['src-a', 'src-b']);
      const admin = res.body.find((c: any) => c.name === 'Admin');
      expect(admin.sources).toHaveLength(1);
      expect(admin.sources[0].sourceId).toBe('src-a');
    });

    it('excludes sources the user cannot read', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.checkPermissionAsync.mockImplementation(
        (_uid: number, _r: string, _a: string, sourceId: string) =>
          Promise.resolve(sourceId === 'src-a')
      );
      mockDb.channels.getAllChannels.mockImplementation((sourceId: string) =>
        Promise.resolve(sourceId === 'src-a' ? CHANNELS_A : CHANNELS_B)
      );

      const app = createApp(regularUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      // src-b skipped entirely
      for (const c of res.body) {
        expect(c.sources.every((s: any) => s.sourceId === 'src-a')).toBe(true);
      }
    });

    it('skips channels with empty names', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([
        { id: 0, name: 'Primary', role: 1 },
        { id: 1, name: '', role: 0 }, // disabled slot
        { id: 2, name: '   ', role: 0 }, // whitespace-only
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Primary');
    });

    it('labels channel 0 as "Primary" when its name is empty', async () => {
      // Real Meshtastic firmware leaves channel 0's name blank — the client
      // renders the modem preset instead. Unified view must still surface it.
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([
        { id: 0, name: '', role: 1 },       // unnamed primary
        { id: 1, name: 'telemetry', role: 2 },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      const names = res.body.map((c: any) => c.name).sort();
      expect(names).toEqual(['Primary', 'telemetry']);
      const primary = res.body.find((c: any) => c.name === 'Primary');
      expect(primary.sources[0].channelNumber).toBe(0);
    });

    it('skips disabled channels even when they have a default name', async () => {
      // Firmware leaves slots 3-7 named "Channel 3".."Channel 7" with role=0
      // (DISABLED). These are not real channels and must not show up.
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([
        { id: 0, name: '', role: 1 },
        { id: 1, name: 'telemetry', role: 2 },
        { id: 3, name: 'Channel 3', role: 0 },
        { id: 4, name: 'Channel 4', role: 0 },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      const names = res.body.map((c: any) => c.name);
      expect(names).toEqual(expect.arrayContaining(['Primary', 'telemetry']));
      expect(names).not.toEqual(expect.arrayContaining(['Channel 3', 'Channel 4']));
    });

    it('returns 500 on database error', async () => {
      mockDb.sources.getAllSources.mockRejectedValue(new Error('DB error'));
      const app = createApp(adminUser);
      const res = await request(app).get('/channels');
      expect(res.status).toBe(500);
    });
  });

  // ── /channels (virtual channels) ─────────────────────────────────────────

  describe('GET /channels (virtual channels)', () => {
    // Virtual channel number encoding: CHANNEL_DB_OFFSET (100) + vcId. Kept
    // as a local constant to mirror the production contract — any drift in
    // the offset should break these tests loudly.
    const VC_OFFSET = 100;

    it('includes enabled virtual channels scoped to the owning source', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.channels.getAllChannels.mockResolvedValue([]);
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 5, name: 'SecretOps', isEnabled: true, sourceId: 'src-a' },
        { id: 6, name: 'Crew', isEnabled: true, sourceId: 'src-b' },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      const secret = res.body.find((c: any) => c.name === 'SecretOps');
      expect(secret).toBeDefined();
      expect(secret.sources).toEqual([
        { sourceId: 'src-a', sourceName: 'Source A', channelNumber: VC_OFFSET + 5 },
      ]);
      const crew = res.body.find((c: any) => c.name === 'Crew');
      expect(crew.sources).toEqual([
        { sourceId: 'src-b', sourceName: 'Source B', channelNumber: VC_OFFSET + 6 },
      ]);
    });

    it('hides virtual channels the non-admin user has no canRead permission for', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([]);
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 5, name: 'Allowed', isEnabled: true, sourceId: 'src-a' },
        { id: 6, name: 'Forbidden', isEnabled: true, sourceId: 'src-a' },
      ]);
      mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([
        { channelDatabaseId: 5, canRead: true, canViewOnMap: false },
        { channelDatabaseId: 6, canRead: false, canViewOnMap: false },
      ]);

      const app = createApp(regularUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      const names = res.body.map((c: any) => c.name);
      expect(names).toContain('Allowed');
      expect(names).not.toContain('Forbidden');
    });

    it('admins see every enabled virtual channel without explicit grants', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([]);
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 9, name: 'AdminOnly', isEnabled: true, sourceId: 'src-a' },
      ]);
      // Deliberately no permissions row — admin bypass should still surface it.
      mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([]);

      const app = createApp(adminUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      expect(res.body.map((c: any) => c.name)).toContain('AdminOnly');
    });

    it('skips disabled virtual channels entirely', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([]);
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 5, name: 'Retired', isEnabled: false, sourceId: 'src-a' },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('collapses a physical channel and a same-name virtual channel into one group on the same source', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([
        { id: 2, name: 'LongFast', role: 1 },
      ]);
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 7, name: 'LongFast', isEnabled: true, sourceId: 'src-a' },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/channels');

      expect(res.status).toBe(200);
      const longfast = res.body.find((c: any) => c.name === 'LongFast');
      expect(longfast).toBeDefined();
      expect(longfast.sources).toHaveLength(2);
      const channelNumbers = longfast.sources.map((s: any) => s.channelNumber).sort((a: number, b: number) => a - b);
      expect(channelNumbers).toEqual([2, VC_OFFSET + 7]);
    });
  });

  // ── /messages (legacy: no channel filter) ─────────────────────────────────

  describe('GET /messages (no channel filter)', () => {
    it('returns merged messages wrapped with receptions array', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.messages.getMessages
        .mockResolvedValueOnce([mkMsg({ id: '1', text: 'Hello', requestId: 111, timestamp: 1000, rxTime: 1000, fromNodeNum: NODE_ONE.nodeNum })])
        .mockResolvedValueOnce([mkMsg({ id: '2', text: 'World', requestId: 222, timestamp: 900,  rxTime: 900,  fromNodeNum: NODE_TWO.nodeNum })]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?limit=50');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      // Sorted newest first.
      expect(res.body[0].timestamp).toBe(1000);
      expect(res.body[0].receptions[0].sourceName).toBe('Source A');
      expect(res.body[0].text).toBe('Hello');
      expect(res.body[1].timestamp).toBe(900);
      expect(res.body[1].receptions[0].sourceName).toBe('Source B');
    });

    it('de-duplicates the same (fromNodeNum, requestId) across sources into one entry with two receptions', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      // Same mesh packet heard by both sources — same fromNodeNum + requestId.
      mockDb.messages.getMessages
        .mockResolvedValueOnce([
          mkMsg({ id: 'a1', fromNodeNum: NODE_ONE.nodeNum, requestId: 42, text: 'ping', timestamp: 2000, rxTime: 2000, rxSnr: -5,  rxRssi: -100 }),
        ])
        .mockResolvedValueOnce([
          mkMsg({ id: 'b1', fromNodeNum: NODE_ONE.nodeNum, requestId: 42, text: 'ping', timestamp: 2100, rxTime: 2100, rxSnr: -8,  rxRssi: -115 }),
        ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?limit=50');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].requestId).toBe(42);
      expect(res.body[0].receptions).toHaveLength(2);
      // Canonical timestamp = earliest heard.
      expect(res.body[0].timestamp).toBe(2000);
      // Receptions sorted earliest-first.
      expect(res.body[0].receptions[0].sourceId).toBe('src-a');
      expect(res.body[0].receptions[1].sourceId).toBe('src-b');
      expect(res.body[0].receptions[0].rxSnr).toBe(-5);
      expect(res.body[0].receptions[1].rxSnr).toBe(-8);
    });

    it('resolves sender display names from the nodes table', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.messages.getMessages.mockResolvedValue([
        mkMsg({ id: '1', text: 'hi', fromNodeNum: NODE_ONE.nodeNum, requestId: 1 }),
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages');

      expect(res.status).toBe(200);
      expect(res.body[0].fromNodeLongName).toBe('Node One');
      expect(res.body[0].fromNodeShortName).toBe('N1');
    });

    it('respects limit parameter', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.messages.getMessages.mockResolvedValue([
        mkMsg({ id: '1', text: 'A', requestId: 1, timestamp: 100, rxTime: 100 }),
        mkMsg({ id: '2', text: 'B', requestId: 2, timestamp: 200, rxTime: 200 }),
        mkMsg({ id: '3', text: 'C', requestId: 3, timestamp: 300, rxTime: 300 }),
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?limit=2');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('caps limit at 500 (fetches 1000 per source for dedup headroom)', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.messages.getMessages.mockResolvedValue([]);

      const app = createApp(adminUser);
      await request(app).get('/messages?limit=9999');

      // fetchLimit = limit * 2 = 1000
      expect(mockDb.messages.getMessages).toHaveBeenCalledWith(1000, 0, SOURCE_A.id, [70]);
    });

    it('skips sources the user has no read permission for', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.checkPermissionAsync.mockImplementation(
        (_uid: number, _r: string, _a: string, sourceId: string) =>
          Promise.resolve(sourceId === 'src-a')
      );
      mockDb.messages.getMessages.mockResolvedValue([
        mkMsg({ id: '1', text: 'Hi', requestId: 7, fromNodeNum: NODE_ONE.nodeNum }),
      ]);

      const app = createApp(regularUser);
      const res = await request(app).get('/messages');

      expect(res.status).toBe(200);
      expect(res.body.every((m: any) => m.receptions.every((r: any) => r.sourceId === 'src-a'))).toBe(true);
      expect(mockDb.messages.getMessages).toHaveBeenCalledTimes(1);
    });

    it('returns 500 on database error', async () => {
      mockDb.sources.getAllSources.mockRejectedValue(new Error('DB error'));
      const app = createApp(adminUser);
      const res = await request(app).get('/messages');
      expect(res.status).toBe(500);
    });
  });

  // ── /messages (channel + before cursor) ──────────────────────────────────

  describe('GET /messages (channel filter + cursor)', () => {
    it('resolves channel name to per-source channel number and uses the cursor path', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue(CHANNELS_A);
      mockDb.messages.getMessagesBeforeInChannel.mockResolvedValue([
        mkMsg({ id: 'a1', text: 'on-primary', requestId: 9, fromNodeNum: NODE_ONE.nodeNum, timestamp: 5000, rxTime: 5000 }),
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?channel=Primary&before=10000&limit=50');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].text).toBe('on-primary');
      // Primary lives at slot 0 on SOURCE_A
      expect(mockDb.messages.getMessagesBeforeInChannel).toHaveBeenCalledWith(
        0,          // channel number
        10000,      // before cursor
        100,        // fetchLimit = limit*2
        SOURCE_A.id
      );
    });

    it('skips sources whose channel list does not contain the requested name', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.channels.getAllChannels.mockImplementation((sourceId: string) =>
        Promise.resolve(sourceId === 'src-a' ? CHANNELS_A : [{ id: 0, name: 'Other', role: 1 }])
      );
      mockDb.messages.getMessagesBeforeInChannel.mockResolvedValue([
        mkMsg({ id: 'a1', text: 'a', requestId: 1, fromNodeNum: NODE_ONE.nodeNum }),
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?channel=Primary');

      expect(res.status).toBe(200);
      // Only SOURCE_A was queried.
      expect(mockDb.messages.getMessagesBeforeInChannel).toHaveBeenCalledTimes(1);
      expect(mockDb.messages.getMessagesBeforeInChannel).toHaveBeenCalledWith(0, undefined, expect.any(Number), 'src-a');
      expect(res.body).toHaveLength(1);
    });

    it('de-duplicates identical packets heard on the same channel by multiple sources', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.channels.getAllChannels.mockResolvedValue([{ id: 0, name: 'Primary', role: 1 }]);
      mockDb.messages.getMessagesBeforeInChannel
        .mockResolvedValueOnce([
          mkMsg({ id: 'a1', fromNodeNum: NODE_ONE.nodeNum, requestId: 777, text: 'shared', timestamp: 1000, rxTime: 1000, rxSnr: -3 }),
        ])
        .mockResolvedValueOnce([
          mkMsg({ id: 'b1', fromNodeNum: NODE_ONE.nodeNum, requestId: 777, text: 'shared', timestamp: 1200, rxTime: 1200, rxSnr: -9 }),
        ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?channel=Primary');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].receptions).toHaveLength(2);
      expect(res.body[0].requestId).toBe(777);
    });

    it('de-duplicates using the mesh packet id extracted from the row id when requestId is null', async () => {
      // Real-world: received text messages store requestId=null — the mesh
      // packet id lives as the last `_`-separated segment of the row id.
      // Same packet received by two sources must collapse into one entry.
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.channels.getAllChannels.mockResolvedValue([{ id: 0, name: 'Primary', role: 1 }]);
      mockDb.messages.getMessagesBeforeInChannel
        .mockResolvedValueOnce([
          mkMsg({
            id: 'src-a_3303011195_69761528',
            fromNodeNum: 3303011195,
            requestId: null,
            text: 'Here comes the Rain',
            timestamp: 1000, rxTime: 1000, rxSnr: 5.2,
          }),
        ])
        .mockResolvedValueOnce([
          mkMsg({
            id: 'src-b_3303011195_69761528',
            fromNodeNum: 3303011195,
            requestId: null,
            text: 'Here comes the Rain',
            timestamp: 1200, rxTime: 1200, rxSnr: -3.1,
          }),
        ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?channel=Primary');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].receptions).toHaveLength(2);
      expect(res.body[0].text).toBe('Here comes the Rain');
      // Canonical timestamp = earliest heard.
      expect(res.body[0].timestamp).toBe(1000);
      // Both source names present.
      const names = res.body[0].receptions.map((r: any) => r.sourceName).sort();
      expect(names).toEqual(['Source A', 'Source B']);
    });

    it('resolves a virtual channel name to its synthetic channel number (CHANNEL_DB_OFFSET + vcId)', async () => {
      // Virtual channel messages are stored at `channel = CHANNEL_DB_OFFSET + vcId`.
      // A named-channel query for a pure virtual channel must hit that slot,
      // NOT a physical 0-7 slot.
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([]); // no physical match
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 4, name: 'SecretOps', isEnabled: true, sourceId: 'src-a' },
      ]);
      mockDb.messages.getMessagesBeforeInChannel.mockResolvedValue([
        mkMsg({ id: 'a1', text: 'covert', channel: 104, requestId: 1, fromNodeNum: NODE_ONE.nodeNum }),
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?channel=SecretOps');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].text).toBe('covert');
      expect(mockDb.messages.getMessagesBeforeInChannel).toHaveBeenCalledWith(
        104, // 100 + 4
        undefined,
        expect.any(Number),
        SOURCE_A.id,
      );
    });

    it('skips a virtual-channel-named request when the user lacks canRead', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([]);
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 4, name: 'SecretOps', isEnabled: true, sourceId: 'src-a' },
      ]);
      mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([
        { channelDatabaseId: 4, canRead: false, canViewOnMap: false },
      ]);
      // Regular user with messages:read denied too, so no fallback path.
      mockDb.checkPermissionAsync.mockResolvedValue(false);

      const app = createApp(regularUser);
      const res = await request(app).get('/messages?channel=SecretOps');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
      expect(mockDb.messages.getMessagesBeforeInChannel).not.toHaveBeenCalled();
    });

    it('unions physical + virtual channel numbers on the same source when names collide', async () => {
      // Same-name collision on one source: physical slot 2 AND virtual id 7.
      // The endpoint must fetch messages from BOTH channel numbers so the
      // unified stream includes messages tagged under either.
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([
        { id: 2, name: 'LongFast', role: 1 },
      ]);
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 7, name: 'LongFast', isEnabled: true, sourceId: 'src-a' },
      ]);
      mockDb.messages.getMessagesBeforeInChannel.mockImplementation(
        (ch: number) =>
          Promise.resolve([
            mkMsg({
              id: `src-a_${NODE_ONE.nodeNum}_${ch}`,
              text: `on-${ch}`,
              channel: ch,
              requestId: ch, // distinct → no dedup collapse
              fromNodeNum: NODE_ONE.nodeNum,
              timestamp: 1000 + ch,
              rxTime: 1000 + ch,
            }),
          ])
      );

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?channel=LongFast');

      expect(res.status).toBe(200);
      const texts = res.body.map((m: any) => m.text).sort();
      expect(texts).toEqual(['on-107', 'on-2']);
      expect(mockDb.messages.getMessagesBeforeInChannel).toHaveBeenCalledTimes(2);
      const calls = mockDb.messages.getMessagesBeforeInChannel.mock.calls
        .map((c: any[]) => c[0])
        .sort((a: number, b: number) => a - b);
      expect(calls).toEqual([2, 107]);
    });

    it('includes virtual channel numbers in the legacy no-filter allow-list', async () => {
      // When the user has messages:read denied but canRead on a virtual
      // channel, the /messages (no channel filter) path must still surface
      // messages stored at `CHANNEL_DB_OFFSET + vcId` and exclude everything
      // else on that source.
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channelDatabase.getAllAsync.mockResolvedValue([
        { id: 3, name: 'OpsChan', isEnabled: true, sourceId: 'src-a' },
      ]);
      mockDb.channelDatabase.getPermissionsForUserAsync.mockResolvedValue([
        { channelDatabaseId: 3, canRead: true, canViewOnMap: false },
      ]);
      // Deny ALL checkPermissionAsync checks (messages:read, channel_*:read).
      mockDb.checkPermissionAsync.mockResolvedValue(false);
      mockDb.messages.getMessages.mockResolvedValue([
        // Physical-slot message — user has NO read on physical slots, must be filtered out.
        mkMsg({ id: 'p1', text: 'physical', channel: 0, requestId: 1, fromNodeNum: NODE_ONE.nodeNum, timestamp: 2000, rxTime: 2000 }),
        // Virtual-slot message at CHANNEL_DB_OFFSET + 3 = 103 — must pass.
        mkMsg({ id: 'v1', text: 'virtual', channel: 103, requestId: 2, fromNodeNum: NODE_ONE.nodeNum, timestamp: 3000, rxTime: 3000 }),
      ]);

      const app = createApp(regularUser);
      const res = await request(app).get('/messages');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].text).toBe('virtual');
      expect(res.body[0].channel).toBe(103);
    });

    it('resolves "Primary" to channel 0 even when the source has a blank name for it', async () => {
      // Matches real firmware behavior: channel 0 is PRIMARY, name is empty.
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.channels.getAllChannels.mockResolvedValue([
        { id: 0, name: '', role: 1 },
        { id: 1, name: 'telemetry', role: 2 },
      ]);
      mockDb.messages.getMessagesBeforeInChannel.mockResolvedValue([
        mkMsg({ id: 'a1', text: 'unnamed-primary', requestId: 11, fromNodeNum: NODE_ONE.nodeNum, timestamp: 5000, rxTime: 5000 }),
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?channel=Primary');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].text).toBe('unnamed-primary');
      expect(mockDb.messages.getMessagesBeforeInChannel).toHaveBeenCalledWith(
        0,
        undefined,
        expect.any(Number),
        SOURCE_A.id
      );
    });
  });

  // ── /telemetry (unchanged contract) ──────────────────────────────────────

  describe('GET /telemetry', () => {
    // Telemetry timestamps are stored in milliseconds (see meshtasticManager).
    const recentTs = Date.now() - 100 * 1000; // 100s ago (ms)

    it('returns telemetry for all accessible sources', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
      ]);
      mockDb.telemetry.getLatestTelemetryByNode.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery_level', value: 85, timestamp: recentTs },
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'voltage', value: 4.1, timestamp: recentTs },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry?hours=24');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].sourceName).toBe('Source A');
      expect(res.body[0].nodeLongName).toBe('Node One');
      expect(['battery_level', 'voltage']).toContain(res.body[0].telemetryType);
    });

    it('filters out readings older than hours window', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
      ]);
      const oldTs = Date.now() - 7200 * 1000; // 2 hours ago (ms)
      mockDb.telemetry.getLatestTelemetryByNode.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery_level', value: 80, timestamp: oldTs },
      ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry?hours=1'); // only 1h window

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0); // filtered out
    });

    it('skips nodes from sources user cannot read', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.checkPermissionAsync.mockImplementation(
        (_userId: number, _resource: string, _action: string, sourceId: string) =>
          Promise.resolve(sourceId === 'src-a')
      );
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
      ]);
      mockDb.telemetry.getLatestTelemetryByNode.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery_level', value: 85, timestamp: recentTs },
      ]);

      const app = createApp(regularUser);
      const res = await request(app).get('/telemetry');

      expect(res.status).toBe(200);
      expect(res.body.every((e: any) => e.sourceId === 'src-a')).toBe(true);
    });

    it('returns entries sorted by timestamp descending', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
        { nodeId: '!11223344', nodeNum: 0x11223344, longName: 'Node Two', shortName: 'N2' },
      ]);
      mockDb.telemetry.getLatestTelemetryByNode
        .mockResolvedValueOnce([
          { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, telemetryType: 'battery_level', value: 80, timestamp: recentTs - 50 },
        ])
        .mockResolvedValueOnce([
          { nodeId: '!11223344', nodeNum: 0x11223344, telemetryType: 'battery_level', value: 90, timestamp: recentTs },
        ]);

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry');

      expect(res.status).toBe(200);
      expect(res.body[0].timestamp).toBeGreaterThan(res.body[1].timestamp);
    });

    it('caps hours at 168', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([]);

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry?hours=9999');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns 500 on database error', async () => {
      mockDb.sources.getAllSources.mockRejectedValue(new Error('DB error'));

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry');

      expect(res.status).toBe(500);
    });

    it('keeps per-node telemetry lookups parallel and tolerates a single-node failure', async () => {
      // When one node's telemetry fetch rejects, the endpoint should still
      // return entries for the other nodes in the same source rather than
      // failing the whole source. Also verifies getLatestTelemetryByNode is
      // called once per node (parallel fan-out, not sequential).
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeId: '!aabbccdd', nodeNum: 0xaabbccdd, longName: 'Node One', shortName: 'N1' },
        { nodeId: '!11223344', nodeNum: 0x11223344, longName: 'Node Two', shortName: 'N2' },
      ]);
      mockDb.telemetry.getLatestTelemetryByNode.mockImplementation((nodeId: string) => {
        if (nodeId === '!aabbccdd') {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve([
          { nodeId: '!11223344', nodeNum: 0x11223344, telemetryType: 'battery_level', value: 90, timestamp: recentTs },
        ]);
      });

      const app = createApp(adminUser);
      const res = await request(app).get('/telemetry');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].nodeLongName).toBe('Node Two');
      expect(mockDb.telemetry.getLatestTelemetryByNode).toHaveBeenCalledTimes(2);
    });
  });

  // ── /messages (partial-failure isolation) ────────────────────────────────

  describe('GET /messages partial failures', () => {
    it('keeps other sources working when a single source node lookup fails', async () => {
      // nodes.getAllNodes throws for src-a but the message still comes through
      // (without sender longName). src-b operates normally.
      mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
      mockDb.channels.getAllChannels.mockResolvedValue([{ id: 0, name: 'Primary', role: 1 }]);
      mockDb.nodes.getAllNodes.mockImplementation((sourceId: string) => {
        if (sourceId === 'src-a') return Promise.reject(new Error('nodes boom'));
        return Promise.resolve([NODE_ONE]);
      });
      mockDb.messages.getMessagesBeforeInChannel.mockImplementation(
        (_ch: number, _before: any, _lim: number, sourceId: string) =>
          Promise.resolve([
            mkMsg({
              id: `${sourceId}_${NODE_ONE.nodeNum}_42`,
              text: `from ${sourceId}`,
              fromNodeNum: NODE_ONE.nodeNum,
              timestamp: sourceId === 'src-a' ? 1000 : 2000,
              rxTime: sourceId === 'src-a' ? 1000 : 2000,
            }),
          ])
      );

      const app = createApp(adminUser);
      const res = await request(app).get('/messages?channel=Primary');

      expect(res.status).toBe(200);
      // Dedup on packet id 42 across sources → single entry, 2 receptions
      expect(res.body).toHaveLength(1);
      expect(res.body[0].receptions).toHaveLength(2);
      expect(res.body[0].fromNodeLongName).toBe('Node One'); // src-b's node map won
    });
  });

  // ── extractPacketIdFromRowId unit tests ──────────────────────────────────

  describe('extractPacketIdFromRowId', () => {
    it('parses the trailing numeric segment', () => {
      expect(extractPacketIdFromRowId('src-a_1234_567890')).toBe(567890);
    });

    it('returns null for empty, non-string, or oversized input', () => {
      expect(extractPacketIdFromRowId('')).toBeNull();
      expect(extractPacketIdFromRowId(123 as any)).toBeNull();
      expect(extractPacketIdFromRowId(null as any)).toBeNull();
      expect(extractPacketIdFromRowId(undefined as any)).toBeNull();
      expect(extractPacketIdFromRowId('x'.repeat(300))).toBeNull();
    });

    it('returns null for ids without an underscore-separated numeric tail', () => {
      expect(extractPacketIdFromRowId('no-underscore')).toBeNull();
      expect(extractPacketIdFromRowId('src_a_12abc')).toBeNull();
      expect(extractPacketIdFromRowId('src_a_')).toBeNull();
    });

    it('rejects values outside unsigned 32-bit range', () => {
      expect(extractPacketIdFromRowId('src_a_4294967295')).toBe(0xffffffff); // max valid
      expect(extractPacketIdFromRowId('src_a_4294967296')).toBeNull(); // one over
      expect(extractPacketIdFromRowId('src_a_99999999999')).toBeNull();
    });
  });
});
