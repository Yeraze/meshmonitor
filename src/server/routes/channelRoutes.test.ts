import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// --- Mocked manager (per-source) ---
const mockManager = vi.hoisted(() => ({
  sourceId: 'src-1',
  setChannelConfig: vi.fn().mockResolvedValue(undefined),
  getDeviceConfig: vi.fn().mockResolvedValue({ lora: { region: 1, usePreset: true } }),
  beginEditSettings: vi.fn().mockResolvedValue(undefined),
  commitEditSettings: vi.fn().mockResolvedValue(undefined),
  setLoRaConfig: vi.fn().mockResolvedValue(undefined),
  refreshNodeDatabase: vi.fn().mockResolvedValue(undefined),
  isTxEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn(() => mockManager),
}));

// --- channelView: passthrough projection so we can assert psk stripping logic indirectly ---
vi.mock('../utils/channelView.js', () => ({
  transformChannel: vi.fn((channel: any, opts: any = {}) => ({
    id: channel.id,
    name: channel.name,
    role: channel.role,
    ...(opts.includePsk ? { psk: channel.psk } : {}),
  })),
  getEncryptionStatus: vi.fn((psk: string | null | undefined) =>
    !psk || psk === '' ? 'none' : psk === 'AQ==' ? 'default' : 'secure'),
  getRoleName: vi.fn(() => 'Unknown'),
}));

vi.mock('../utils/automationChannelMigration.js', () => ({
  migrateAutomationChannels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../constants/meshtastic.js', async (importOriginal) => ({
  // Partial mock: repositories/messages.ts (transitively imported) needs the
  // real PortNum constants (#3691 DM_CHAT_PORTNUMS); only override the two
  // symbols this suite controls.
  ...(await importOriginal<typeof import('../constants/meshtastic.js')>()),
  modemPresetChannelName: vi.fn(() => 'LongFast'),
  CHANNEL_DB_OFFSET: 100,
}));

const mockMeshcoreManager = vi.hoisted(() => ({
  // The route narrows via isMeshCoreManager(), which checks sourceType.
  sourceType: 'meshcore' as const,
  setChannel: vi.fn().mockResolvedValue(undefined),
  deleteChannel: vi.fn().mockResolvedValue(undefined),
}));
// MeshCore managers live in the unified sourceManagerRegistry (#3962 Ph2).
const mockSourceRegistry = vi.hoisted(() => ({
  getManager: vi.fn(() => mockMeshcoreManager),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockSourceRegistry,
}));

// --- channelUrlService (dynamically imported) ---
const mockChannelUrlService = vi.hoisted(() => ({
  decodeUrl: vi.fn(),
  encodeUrl: vi.fn(),
}));
vi.mock('../services/channelUrlService.js', () => ({
  default: mockChannelUrlService,
}));

// --- DatabaseService facade ---
const mockDb = vi.hoisted(() => ({
  channels: {
    getAllChannels: vi.fn().mockResolvedValue([]),
    getChannelById: vi.fn(),
    upsertChannel: vi.fn().mockResolvedValue(undefined),
    deleteChannel: vi.fn().mockResolvedValue(undefined),
    getChannelCount: vi.fn().mockResolvedValue(0),
  },
  channelDatabase: {
    getAllAsync: vi.fn().mockResolvedValue([]),
    getByIdAsync: vi.fn().mockResolvedValue(null),
  },
  messages: {
    purgeChannelMessages: vi.fn().mockResolvedValue(0),
    migrateMessagesForChannelMoves: vi.fn().mockResolvedValue(undefined),
    getDistinctChannelsForSource: vi.fn().mockResolvedValue([]),
  },
  getChannelDatabasePermissionsForUserAsSetAsync: vi.fn().mockResolvedValue({}),
  settings: {
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn().mockResolvedValue(undefined),
  },
  sources: {
    getSource: vi.fn().mockResolvedValue({ type: 'meshtastic_tcp' }),
  },
  auth: {
    migratePermissionsForChannelMoves: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../services/database.js', () => ({
  default: mockDb,
}));

// --- Auth middleware: admin user, all permissions granted ---
vi.mock('../auth/authMiddleware.js', () => ({
  optionalAuth: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
  requireAuth: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
  hasPermission: vi.fn().mockResolvedValue(true),
}));

// Silence handler logging so the suite output stays clean.
vi.mock('../../utils/logger.js', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
}));

import channelRoutes from './channelRoutes.js';

const app = express();
app.use(express.json());
app.use('/channels', channelRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mockManager.sourceId = 'src-1';
  // clearAllMocks resets call history but NOT implementations set via
  // mockResolvedValue/mockRejectedValue, so re-assert the defaults each test.
  mockDb.channels.getAllChannels.mockResolvedValue([]);
  mockDb.channels.getChannelCount.mockResolvedValue(0);
  mockDb.channelDatabase.getAllAsync.mockResolvedValue([]);
  mockDb.channelDatabase.getByIdAsync.mockResolvedValue(null);
  mockDb.messages.purgeChannelMessages.mockResolvedValue(0);
  mockDb.messages.getDistinctChannelsForSource.mockResolvedValue([]);
  mockDb.getChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue({});
  mockDb.sources.getSource.mockResolvedValue({ type: 'meshtastic_tcp' });
  mockSourceRegistry.getManager.mockReturnValue(mockMeshcoreManager);
});

describe('GET /channels and /channels/all', () => {
  it('returns projected channels (admin sees psk)', async () => {
    mockDb.channels.getAllChannels.mockResolvedValue([
      { id: 0, name: 'Primary', role: 1, psk: 'AQ==' },
    ]);
    const res = await request(app).get('/channels/all');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].psk).toBe('AQ==');
  });

  it('GET /channels filters out disabled (role 0) channels', async () => {
    mockDb.channels.getAllChannels.mockResolvedValue([
      { id: 0, name: 'Primary', role: 1, psk: 'AQ==' },
      { id: 1, name: 'Disabled', role: 0, psk: 'AQ==' },
    ]);
    const res = await request(app).get('/channels');
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).toEqual([0]);
  });

  it('returns 500 when the DB query throws', async () => {
    mockDb.channels.getAllChannels.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/channels');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch channels');
  });
});

describe('GET /channels for MQTT sources (virtual channel enumeration)', () => {
  it('enumerates channel_database-backed channels that have messages', async () => {
    mockDb.sources.getSource.mockResolvedValue({ type: 'mqtt_bridge' });
    // Two virtual channels (100+id) plus one raw straggler, ordered by activity.
    mockDb.messages.getDistinctChannelsForSource.mockResolvedValue([
      { channel: 101, messageCount: 50, lastTimestamp: 2000 },
      { channel: 102, messageCount: 10, lastTimestamp: 1000 },
      { channel: 3, messageCount: 2, lastTimestamp: 500 },
    ]);
    mockDb.channelDatabase.getByIdAsync.mockImplementation(async (id: number) => {
      if (id === 1) return { id: 1, name: 'MediumFast', psk: '' };
      if (id === 2) return { id: 2, name: 'Secret', psk: 'AQ==' };
      return null;
    });

    const res = await request(app).get('/channels?sourceId=mqtt-1');
    expect(res.status).toBe(200);
    // Device-slot getAllChannels must NOT be the source of truth here.
    expect(mockDb.messages.getDistinctChannelsForSource).toHaveBeenCalledWith('mqtt-1');

    const byId = Object.fromEntries(res.body.map((c: any) => [c.id, c]));
    expect(res.body.map((c: any) => c.id)).toEqual([101, 102, 3]);
    expect(byId[101].name).toBe('MediumFast');
    expect(byId[101].displayName).toBe('MediumFast #101');
    expect(byId[101].pskSet).toBe(false);
    expect(byId[102].displayName).toBe('Secret #102');
    expect(byId[102].pskSet).toBe(true);
    expect(byId[3].name).toBe('Channel 3');
  });

  it('returns [] for an MQTT source with no messages', async () => {
    mockDb.sources.getSource.mockResolvedValue({ type: 'mqtt_broker' });
    mockDb.messages.getDistinctChannelsForSource.mockResolvedValue([]);
    const res = await request(app).get('/channels?sourceId=mqtt-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('TCP sources keep the device-slot code path (getDistinctChannelsForSource not used)', async () => {
    mockDb.sources.getSource.mockResolvedValue({ type: 'meshtastic_tcp' });
    mockDb.channels.getAllChannels.mockResolvedValue([
      { id: 0, name: 'Primary', role: 1, psk: 'AQ==' },
    ]);
    const res = await request(app).get('/channels?sourceId=tcp-1');
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).toEqual([0]);
    expect(mockDb.messages.getDistinctChannelsForSource).not.toHaveBeenCalled();
  });
});

describe('GET /channels/collisions (#3644)', () => {
  it('flags a device channel sharing a key with a differently-named Channel Database entry', async () => {
    mockDb.channels.getAllChannels.mockResolvedValue([
      { id: 0, name: 'Custom', role: 1, psk: 'AQ==' },
    ]);
    mockDb.channelDatabase.getAllAsync.mockResolvedValue([
      { id: 5, name: 'LongFast', psk: 'AQ==' },
    ]);
    const res = await request(app).get('/channels/collisions');
    expect(res.status).toBe(200);
    expect(res.body.collisions).toEqual([
      { channelId: 0, channelName: 'Custom', dbId: 5, dbName: 'LongFast' },
    ]);
  });

  it('returns no collisions for a same-name mirror', async () => {
    mockDb.channels.getAllChannels.mockResolvedValue([
      { id: 0, name: 'LongFast', role: 1, psk: 'AQ==' },
    ]);
    mockDb.channelDatabase.getAllAsync.mockResolvedValue([
      { id: 5, name: 'LongFast', psk: 'AQ==' },
    ]);
    const res = await request(app).get('/channels/collisions');
    expect(res.status).toBe(200);
    expect(res.body.collisions).toEqual([]);
  });

  it('returns 500 when the DB query throws', async () => {
    mockDb.channels.getAllChannels.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/channels/collisions');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to detect channel collisions');
  });
});

describe('GET /channels/:id/export', () => {
  it('400s MISSING_SOURCE_ID when sourceId omitted (no cross-source PSK export)', async () => {
    const res = await request(app).get('/channels/2/export');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });

  it('rejects a non-numeric channel id', async () => {
    const res = await request(app).get('/channels/abc/export?sourceId=src-A');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid channel ID');
  });

  it('404s when the channel does not exist', async () => {
    mockDb.channels.getChannelById.mockResolvedValue(null);
    const res = await request(app).get('/channels/3/export?sourceId=src-A');
    expect(res.status).toBe(404);
  });

  it('exports the channel JSON scoped to the required source', async () => {
    mockDb.channels.getChannelById.mockResolvedValue({
      id: 2, name: 'Test Chan', psk: 'AQ==', role: 2,
      uplinkEnabled: 1, downlinkEnabled: 0, positionPrecision: 16,
    });
    const res = await request(app).get('/channels/2/export?sourceId=src-A');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('meshmonitor-channel-test_chan-');
    const body = JSON.parse(res.text);
    expect(body.channel.id).toBe(2);
    expect(body.channel.uplinkEnabled).toBe(true);   // normalized 1 -> true
    expect(body.channel.downlinkEnabled).toBe(false); // normalized 0 -> false
    // scoped to the supplied source, not a first-match across sources
    expect(mockDb.channels.getChannelById).toHaveBeenCalledWith(2, 'src-A');
  });
});

describe('channel-write routes require a sourceId', () => {
  it('PUT /channels/:id 400s MISSING_SOURCE_ID without sourceId', async () => {
    const res = await request(app).put('/channels/1').send({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });
  it('POST /channels/:slotId/import 400s MISSING_SOURCE_ID without sourceId', async () => {
    const res = await request(app).post('/channels/1/import').send({ channel: { name: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });
  it('POST /channels/reorder 400s MISSING_SOURCE_ID without sourceId', async () => {
    const res = await request(app).post('/channels/reorder').send({ newOrder: [0, 1, 2, 3, 4, 5, 6, 7] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });
  it('POST /channels/import-config 400s MISSING_SOURCE_ID without sourceId', async () => {
    const res = await request(app).post('/channels/import-config').send({ url: 'https://meshtastic.org/e/#x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });
});

describe('PUT /channels/:id', () => {
  it('rejects an out-of-range Meshtastic channel id', async () => {
    const res = await request(app).put('/channels/9').send({ name: 'x', sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('0-7');
  });

  it('rejects an over-long Meshtastic name (>11)', async () => {
    mockDb.channels.getChannelById.mockResolvedValue({ id: 1, name: 'old', psk: null });
    const res = await request(app).put('/channels/1').send({ name: 'this-name-is-way-too-long', sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('11 characters');
  });

  it('404s when updating a missing Meshtastic channel', async () => {
    mockDb.channels.getChannelById.mockResolvedValue(null);
    const res = await request(app).put('/channels/1').send({ name: 'ok', sourceId: 'src-1' });
    expect(res.status).toBe(404);
  });

  it('updates an existing channel and pushes config to the device', async () => {
    mockDb.channels.getChannelById.mockResolvedValue({ id: 1, name: 'old', psk: 'AQ==', role: 2 });
    const res = await request(app).put('/channels/1').send({ name: 'newname', sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.channels.upsertChannel).toHaveBeenCalled();
    expect(mockManager.setChannelConfig).toHaveBeenCalled();
  });

  it('rejects a MeshCore secret that is not 16 bytes', async () => {
    mockDb.sources.getSource.mockResolvedValue({ type: 'meshcore' });
    const res = await request(app).put('/channels/2').send({ name: 'mc', psk: 'AQ==', sourceId: 'mc-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('16 bytes');
  });

  it('503s for MeshCore when no manager is registered', async () => {
    mockDb.sources.getSource.mockResolvedValue({ type: 'meshcore' });
    mockSourceRegistry.getManager.mockReturnValue(undefined);
    const sixteen = Buffer.alloc(16).toString('base64');
    const res = await request(app).put('/channels/2').send({ name: 'mc', psk: sixteen, sourceId: 'mc-1' });
    expect(res.status).toBe(503);
  });
});

describe('DELETE /channels/:id', () => {
  it('requires a sourceId', async () => {
    const res = await request(app).delete('/channels/1');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sourceId is required');
  });

  it('refuses to delete the primary channel', async () => {
    const res = await request(app).delete('/channels/0').send({ sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('primary');
  });

  it('deletes a channel and purges its messages', async () => {
    mockDb.messages.purgeChannelMessages.mockResolvedValue(5);
    const res = await request(app).delete('/channels/3').send({ sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(res.body.messagesDeleted).toBe(5);
    expect(mockDb.channels.deleteChannel).toHaveBeenCalledWith(3, 'src-1');
  });

  it('MeshCore happy-path: deletes a channel via device manager and returns success', async () => {
    // Set up a MeshCore source
    mockDb.sources.getSource.mockResolvedValue({ type: 'meshcore' });
    mockSourceRegistry.getManager.mockReturnValue(mockMeshcoreManager);
    mockMeshcoreManager.deleteChannel.mockResolvedValue(undefined);

    // Delete channel 2 (not primary, which is allowed for MeshCore)
    const res = await request(app).delete('/channels/2').send({ sourceId: 'meshcore-1' });

    // Verify success response
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('Channel 2 deleted');
    expect(res.body.sourceId).toBe('meshcore-1');

    // Verify the device manager was called to delete on the device
    expect(mockMeshcoreManager.deleteChannel).toHaveBeenCalledWith(2);
    
    // Verify the manager registry was queried for the correct source
    expect(mockSourceRegistry.getManager).toHaveBeenCalledWith('meshcore-1');
  });
});

describe('POST /channels/:slotId/import', () => {
  it('rejects an invalid slot id', async () => {
    const res = await request(app).post('/channels/9/import').send({ channel: { name: 'x' }, sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('0-7');
  });

  it('requires a channel object', async () => {
    const res = await request(app).post('/channels/1/import').send({ sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Expected channel object');
  });

  it('imports a channel into the slot', async () => {
    mockDb.channels.getChannelById.mockResolvedValue({ id: 1, name: 'Imported' });
    const res = await request(app).post('/channels/1/import').send({ channel: { name: 'Imported', psk: 'AQ==' }, sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.channels.upsertChannel).toHaveBeenCalled();
  });
});

describe('POST /channels/reorder', () => {
  it('rejects a newOrder that is not 8 entries', async () => {
    const res = await request(app).post('/channels/reorder').send({ newOrder: [0, 1, 2], sourceId: 'src-1' });
    expect(res.status).toBe(400);
  });

  it('rejects a newOrder that is not a permutation of 0-7', async () => {
    const res = await request(app).post('/channels/reorder').send({ newOrder: [0, 0, 1, 2, 3, 4, 5, 6], sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('exactly once');
  });

  it('returns requiresReboot:false for the identity order without touching the device', async () => {
    const res = await request(app).post('/channels/reorder').send({ newOrder: [0, 1, 2, 3, 4, 5, 6, 7], sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(res.body.requiresReboot).toBe(false);
    expect(mockManager.beginEditSettings).not.toHaveBeenCalled();
  });

  it('scopes the message migration to the resolved source (#3712)', async () => {
    mockManager.sourceId = 'src-reorder';
    mockDb.channels.getAllChannels.mockResolvedValue([
      { id: 0, name: 'Primary', role: 1, psk: 'AQ==' },
      { id: 1, name: 'Second', role: 2, psk: 'BB==' },
    ]);
    // Swap slots 0 and 1 so the reorder produces real moves.
    const res = await request(app)
      .post('/channels/reorder')
      .send({ newOrder: [1, 0, 2, 3, 4, 5, 6, 7], sourceId: 'src-reorder' });
    expect(res.status).toBe(200);
    // The DB lookup driving the reorder must be scoped to the resolved source.
    expect(mockDb.channels.getAllChannels).toHaveBeenCalledWith('src-reorder');
    // The key fix: message migration must carry the sourceId so messages from
    // other sources sharing the same slot ids are not migrated.
    expect(mockDb.messages.migrateMessagesForChannelMoves).toHaveBeenCalledTimes(1);
    const [moves, passedSourceId] = mockDb.messages.migrateMessagesForChannelMoves.mock.calls[0];
    expect(passedSourceId).toBe('src-reorder');
    expect(moves).toEqual(expect.arrayContaining([
      { from: 1, to: 0 },
      { from: 0, to: 1 },
    ]));
  });

  it('happy-path: executes full reorder with device persistence and message migration', async () => {
    // Test the complete happy-path flow: reorder channels, persist to device, and migrate messages.
    // The route handles pacing delays internally (2000ms before, 1000ms between each slot, 1500ms before commit),
    // so this test verifies the core logic without relying on timer controls.
    mockManager.sourceId = 'src-reorder-full';
    mockDb.channels.getAllChannels.mockResolvedValue([
      { id: 0, name: 'Primary', role: 1, psk: 'AQ==', uplinkEnabled: true, downlinkEnabled: true },
      { id: 1, name: 'Channel A', role: 2, psk: 'BB==', uplinkEnabled: true, downlinkEnabled: true },
      { id: 2, name: 'Channel B', role: 2, psk: 'CC==', uplinkEnabled: true, downlinkEnabled: false },
      { id: 3, role: 0 }, // disabled slot
    ]);
    
    // Reorder: move slot 1 → 2, slot 2 → 1, rest identity
    const res = await request(app)
      .post('/channels/reorder')
      .send({ newOrder: [0, 2, 1, 3, 4, 5, 6, 7], sourceId: 'src-reorder-full' });
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.requiresReboot).toBe(true);
    
    // Verify the device-interaction bookends
    expect(mockManager.beginEditSettings).toHaveBeenCalledTimes(1);
    expect(mockManager.commitEditSettings).toHaveBeenCalledTimes(1);
    
    // Verify setChannelConfig was called for affected slots
    expect(mockManager.setChannelConfig).toHaveBeenCalled();
    const setCalls = mockManager.setChannelConfig.mock.calls;
    // Slot 0 is identity so it's not called; slots 1 and 2 should be updated
    expect(setCalls.some(call => call[0] === 1 && call[1]?.name === 'Channel B')).toBe(true);
    expect(setCalls.some(call => call[0] === 2 && call[1]?.name === 'Channel A')).toBe(true);
    
    // Verify message and permission migration
    expect(mockDb.messages.migrateMessagesForChannelMoves).toHaveBeenCalledTimes(1);
    const [moves] = mockDb.messages.migrateMessagesForChannelMoves.mock.calls[0];
    expect(moves).toEqual(expect.arrayContaining([
      { from: 1, to: 2 },
      { from: 2, to: 1 },
    ]));
    expect(mockDb.auth.migratePermissionsForChannelMoves).toHaveBeenCalledTimes(1);
  });
});

describe('POST /channels/decode-url', () => {
  it('requires a url', async () => {
    const res = await request(app).post('/channels/decode-url').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('URL is required');
  });

  it('400s on a malformed url', async () => {
    mockChannelUrlService.decodeUrl.mockReturnValue(null);
    const res = await request(app).post('/channels/decode-url').send({ url: 'https://meshtastic.org/e/#bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid or malformed');
  });

  it('returns the decoded config', async () => {
    mockChannelUrlService.decodeUrl.mockReturnValue({ channels: [{ name: 'A' }] });
    const res = await request(app).post('/channels/decode-url').send({ url: 'https://meshtastic.org/e/#ok' });
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
  });
});

describe('POST /channels/encode-url', () => {
  it('rejects a non-array channelIds', async () => {
    const res = await request(app).post('/channels/encode-url').send({ channelIds: 'nope', sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('channelIds must be an array');
  });

  it('400s when no valid channels are selected', async () => {
    mockDb.channels.getChannelById.mockResolvedValue(null);
    const res = await request(app).post('/channels/encode-url').send({ channelIds: [3], sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No valid channels');
  });

  it('encodes the selected channels into a url', async () => {
    mockDb.channels.getChannelById.mockResolvedValue({ id: 0, name: 'Primary', psk: 'AQ==' });
    mockChannelUrlService.encodeUrl.mockReturnValue('https://meshtastic.org/e/#encoded');
    const res = await request(app).post('/channels/encode-url').send({ channelIds: [0], sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('meshtastic.org');
  });

  it('emits the device actual txEnabled instead of forcing true (#4294)', async () => {
    mockDb.channels.getChannelById.mockResolvedValue({ id: 0, name: 'Primary', psk: 'AQ==' });
    mockManager.getDeviceConfig.mockResolvedValue({ lora: { region: 1, usePreset: true, txEnabled: false } });
    mockChannelUrlService.encodeUrl.mockReturnValue('https://meshtastic.org/e/#encoded');
    const res = await request(app)
      .post('/channels/encode-url')
      .send({ channelIds: [0], sourceId: 'src-1', includeLoraConfig: true });
    expect(res.status).toBe(200);
    expect(mockChannelUrlService.encodeUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ txEnabled: false }),
    );
  });
});

describe('POST /channels/import-config', () => {
  it('requires a url', async () => {
    const res = await request(app).post('/channels/import-config').send({ sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('URL is required');
  });

  it('400s on an empty/invalid config url', async () => {
    mockChannelUrlService.decodeUrl.mockReturnValue(null);
    const res = await request(app).post('/channels/import-config').send({ url: 'https://meshtastic.org/e/#x', sourceId: 'src-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid or empty');
  });

  it('imports channels + lora config and commits the transaction', async () => {
    mockChannelUrlService.decodeUrl.mockReturnValue({
      channels: [{ name: 'A', psk: 'AQ==' }],
      loraConfig: { region: 1 },
    });
    const res = await request(app).post('/channels/import-config').send({ url: 'https://meshtastic.org/e/#ok', sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.imported.channels).toBe(1);
    expect(res.body.requiresReboot).toBe(true);
    expect(mockManager.beginEditSettings).toHaveBeenCalled();
    expect(mockManager.commitEditSettings).toHaveBeenCalled();
  });

  // setLoRaConfig sends the device the ENTIRE LoRaConfig struct (whole-message
  // replace, not a patch), and proto3 decodes an omitted bool as false — so the
  // decoded URL's txEnabled must be overridden with the device's actual current
  // value (backfilled via isTxEnabled()), never stripped/omitted (#4294).
  it('overrides the decoded LoRa config txEnabled with the device actual value before calling setLoRaConfig (#4294)', async () => {
    mockManager.isTxEnabled.mockReturnValue(false);
    mockChannelUrlService.decodeUrl.mockReturnValue({
      channels: undefined,
      loraConfig: { region: 1, hopLimit: 3, txEnabled: true },
    });
    const res = await request(app).post('/channels/import-config').send({ url: 'https://meshtastic.org/e/#ok', sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(mockManager.setLoRaConfig).toHaveBeenCalledTimes(1);
    const [calledWith] = mockManager.setLoRaConfig.mock.calls[0];
    // The device's actual current txEnabled (false) wins over the decoded
    // URL's value (true) — the whole point of preserving current TX state.
    expect(calledWith).toMatchObject({ region: 1, hopLimit: 3, txEnabled: false });
  });

  it('backfills txEnabled:true when the device currently has transmit enabled', async () => {
    mockManager.isTxEnabled.mockReturnValue(true);
    mockChannelUrlService.decodeUrl.mockReturnValue({
      channels: undefined,
      loraConfig: { region: 1, hopLimit: 3 },
    });
    const res = await request(app).post('/channels/import-config').send({ url: 'https://meshtastic.org/e/#ok', sourceId: 'src-1' });
    expect(res.status).toBe(200);
    const [calledWith] = mockManager.setLoRaConfig.mock.calls[0];
    expect(calledWith).toMatchObject({ region: 1, hopLimit: 3, txEnabled: true });
  });
});

describe('POST /channels/refresh', () => {
  it('refreshes the node database and returns the channel count', async () => {
    mockDb.channels.getChannelCount.mockResolvedValue(4);
    const res = await request(app).post('/channels/refresh').send({ sourceId: 'src-1' });
    expect(res.status).toBe(200);
    expect(res.body.channelCount).toBe(4);
    expect(mockManager.refreshNodeDatabase).toHaveBeenCalled();
  });
});
