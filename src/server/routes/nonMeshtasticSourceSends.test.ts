/**
 * #5375 — MQTT/MeshCore sources fell back to the primary TCP radio for sends,
 * channel writes, tx-status and the unread-DM count.
 *
 * resolveSourceManager() only narrows to meshtastic_tcp managers; for an
 * mqtt_broker (or bridge / MeshCore) sourceId it returns the PRIMARY TCP
 * manager. So a message sent from an MQTT broker source went out over the
 * primary radio, a channel saved there was pushed to the primary radio, and
 * tx-status / unread-DM counts reported the primary's state.
 *
 * These tests register a primary meshtastic_tcp manager next to an
 * mqtt_broker manager and prove that no broker request reaches the TCP
 * manager's transmit/config methods, while the TCP source's own id still does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import messageRoutes from './messageRoutes.js';
import meshRequestRoutes from './meshRequestRoutes.js';
import channelRoutes from './channelRoutes.js';
import deviceStatusRoutes from './deviceStatusRoutes.js';
import pollRoutes from './pollRoutes.js';
import nodesRoutes from './nodesRoutes.js';
import announceRoutes from './announceRoutes.js';
import connectionRoutes from './connectionRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import { backupRouter } from './backupRoutes.js';
import { deviceRestoreService } from '../services/deviceRestoreService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

const TCP_NODE_ID = '!bf85a9d1';
const TCP_NODE_NUM = 0xbf85a9d1;
const PEER_NODE_ID = '!11111111';
const PEER_NODE_NUM = 0x11111111;
const BROKER_SOURCE_ID = 'rt-mqtt-broker-5375';

describe('non-Meshtastic sources never transmit through the primary radio (#5375)', () => {
  let harness: RouteTestHarness;
  let tcpManager: Record<string, ReturnType<typeof vi.fn> | string>;

  function makeTcpManager(): ISourceManager {
    tcpManager = {
      sourceId: harness.sourceA,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'Source A', sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: TCP_NODE_NUM, nodeId: TCP_NODE_ID, longName: 'TCP', shortName: 'TCP' }),
      isLocalNodeBridged: vi.fn().mockReturnValue(false),
      // Lists the peer so a DM from it would be visible if it were counted.
      getAllNodesAsync: vi.fn().mockResolvedValue([{ nodeNum: PEER_NODE_NUM, user: { id: PEER_NODE_ID, longName: 'Peer', shortName: 'PEER' } }]),
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, nodeResponsive: true, configuring: false, nodeIp: '10.0.0.1', userDisconnected: false }),
      getDeviceConfig: vi.fn().mockResolvedValue({ lora: { txEnabled: true } }),
      getDeviceNodeNums: vi.fn().mockReturnValue([]),
      isUdpBroadcastRelayEnabled: vi.fn().mockReturnValue(false),
      sendTextMessage: vi.fn().mockResolvedValue(1),
      sendTraceroute: vi.fn().mockResolvedValue(undefined),
      sendPositionRequest: vi.fn().mockResolvedValue({ packetId: 1, requestId: 1 }),
      setChannelConfig: vi.fn().mockResolvedValue(undefined),
      beginEditSettings: vi.fn().mockResolvedValue(undefined),
      commitEditSettings: vi.fn().mockResolvedValue(undefined),
      refreshNodeDatabase: vi.fn().mockResolvedValue(undefined),
      sendFavoriteNode: vi.fn().mockResolvedValue(undefined),
      sendAutoAnnouncement: vi.fn().mockResolvedValue(undefined),
      previewAnnouncementMessage: vi.fn().mockResolvedValue('preview from TCP'),
      userDisconnect: vi.fn().mockResolvedValue(undefined),
      userReconnect: vi.fn().mockResolvedValue(true),
      setNodeIpOverride: vi.fn().mockResolvedValue(undefined),
      getAutoPingSessions: vi.fn().mockResolvedValue([{ nodeNum: PEER_NODE_NUM }]),
      stopAutoPingSession: vi.fn(),
      supportsFavorites: vi.fn().mockReturnValue(true),
      sendRemoveFavoriteNode: vi.fn().mockResolvedValue(undefined),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
    };
    return tcpManager as unknown as ISourceManager;
  }

  function makeBrokerManager(): ISourceManager {
    return {
      sourceId: BROKER_SOURCE_ID,
      sourceType: 'mqtt_broker',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId: BROKER_SOURCE_ID, sourceName: 'Home Mqtt', sourceType: 'mqtt_broker', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue(null),
      getAllNodesAsync: vi.fn().mockResolvedValue([]),
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, nodeResponsive: true, configuring: false, nodeIp: 'broker.local', userDisconnected: false }),
      getDeviceConfig: vi.fn().mockResolvedValue(null),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
    } as unknown as ISourceManager;
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/messages', messageRoutes);
        app.use('/', meshRequestRoutes);
        app.use('/channels', channelRoutes);
        app.use('/', deviceStatusRoutes);
        app.use('/', pollRoutes);
        app.use('/', nodesRoutes);
        app.use('/announce', announceRoutes);
        app.use('/connection', connectionRoutes);
        app.use('/settings', settingsRoutes);
        app.use('/backup', backupRouter);
      },
    });
    await harness.db.sources.createSource({
      id: BROKER_SOURCE_ID,
      name: 'Home Mqtt',
      type: 'mqtt_broker',
      config: {},
      enabled: true,
    });
    await sourceManagerRegistry.addManager(makeTcpManager());
    await sourceManagerRegistry.addManager(makeBrokerManager());
  });

  afterEach(async () => {
    await sourceManagerRegistry.removeManager(BROKER_SOURCE_ID);
    await sourceManagerRegistry.removeManager(harness.sourceA);
    await harness.db.sources.deleteSource(BROKER_SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  describe('sends are refused with SOURCE_NOT_MESHTASTIC', () => {
    it('POST /messages/send does not send over the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/messages/send').send({ sourceId: BROKER_SOURCE_ID, text: 'hi', channel: 0 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.sendTextMessage).not.toHaveBeenCalled();
    });

    it('POST /messages/send still sends for the TCP source itself (positive control)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/messages/send').send({ sourceId: harness.sourceA, text: 'hi', channel: 0 });
      expect(res.status).toBe(200);
      expect(tcpManager.sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it('POST /traceroute does not traceroute over the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/traceroute').send({ sourceId: BROKER_SOURCE_ID, destination: PEER_NODE_NUM, channel: 0 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.sendTraceroute).not.toHaveBeenCalled();
    });

    it('POST /nodes/:id/send-key-warning does not send over the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`/nodes/${PEER_NODE_ID}/send-key-warning`).send({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.sendTextMessage).not.toHaveBeenCalled();
    });

    it('POST /announce/send does not announce over the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/announce/send').send({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.sendAutoAnnouncement).not.toHaveBeenCalled();
    });

    it('POST /position/request does not request over the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/position/request').send({ sourceId: BROKER_SOURCE_ID, destination: PEER_NODE_NUM });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.sendPositionRequest).not.toHaveBeenCalled();
    });
  });

  describe('channel writes', () => {
    beforeEach(async () => {
      await harness.db.channels.upsertChannel({ id: 1, name: 'old', psk: 'AQ==', role: 2 }, BROKER_SOURCE_ID);
    });

    it('PUT /channels/:id saves the broker row but never pushes it to the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put('/channels/1').send({ sourceId: BROKER_SOURCE_ID, name: 'renamed' });
      expect(res.status).toBe(200);
      expect(res.body.channel?.name).toBe('renamed');
      expect(tcpManager.setChannelConfig).not.toHaveBeenCalled();
    });

    it('POST /channels/:slot/import saves the broker row but never pushes it to the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/channels/2/import').send({ sourceId: BROKER_SOURCE_ID, channel: { name: 'imported', psk: 'AQ==' } });
      expect(res.status).toBe(200);
      expect(res.body.channel?.name).toBe('imported');
      expect(tcpManager.setChannelConfig).not.toHaveBeenCalled();
    });

    it('POST /channels/reorder is refused rather than rewriting the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/channels/reorder').send({ sourceId: BROKER_SOURCE_ID, newOrder: [0, 2, 1, 3, 4, 5, 6, 7] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.beginEditSettings).not.toHaveBeenCalled();
      expect(tcpManager.setChannelConfig).not.toHaveBeenCalled();
    });
  });

  describe('GET /device/tx-status', () => {
    it('reports no local radio for an mqtt_broker source instead of the primary\'s TX state', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/device/tx-status').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ txEnabled: false, udpRelayEnabled: false, canTransmit: false, hasLocalRadio: false });
      expect(tcpManager.getDeviceConfig).not.toHaveBeenCalled();
    });

    it('still reports the TCP source\'s own TX state (positive control)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/device/tx-status').query({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expect(res.body.canTransmit).toBe(true);
      expect(tcpManager.getDeviceConfig).toHaveBeenCalled();
    });
  });

  describe('unread DM counts', () => {
    beforeEach(async () => {
      // A DM the broker heard over MQTT, addressed to the primary TCP node.
      await harness.db.messages.insertMessage({
        id: `${BROKER_SOURCE_ID}_${PEER_NODE_NUM}_42`,
        fromNodeNum: PEER_NODE_NUM,
        toNodeNum: TCP_NODE_NUM,
        fromNodeId: PEER_NODE_ID,
        toNodeId: TCP_NODE_ID,
        text: 'hello primary',
        channel: -1,
        portnum: 1,
        timestamp: Date.now(),
        createdAt: Date.now(),
      } as any, BROKER_SOURCE_ID);
    });

    it('GET /poll does not count the primary node\'s DMs for an mqtt_broker source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/poll').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(200);
      expect(res.body.unreadCounts?.directMessages?.[PEER_NODE_ID]).toBeUndefined();
    });

    it('GET /messages/unread-counts does not count the primary node\'s DMs for an mqtt_broker source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/messages/unread-counts').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(200);
      expect(res.body.directMessages?.[PEER_NODE_ID]).toBeUndefined();
    });

    it('POST /messages/mark-read for a DM on an mqtt_broker source marks nothing instead of erroring', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/messages/mark-read').send({ sourceId: BROKER_SOURCE_ID, nodeId: PEER_NODE_ID });
      expect(res.status).toBe(200);
      expect(res.body.marked).toBe(0);
    });
  });

  describe('favorite device sync', () => {
    it('saves the favorite for the broker but skips syncing it to the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/nodes/${PEER_NODE_ID}/favorite`)
        .send({ sourceId: BROKER_SOURCE_ID, isFavorite: true, syncToDevice: true });
      expect(res.status).toBe(200);
      expect(res.body.deviceSync.status).toBe('skipped');
      expect(tcpManager.sendFavoriteNode).not.toHaveBeenCalled();
    });
  });
  describe('sources with no live manager', () => {
    const DISABLED_MQTT_ID = 'rt-mqtt-disabled-5375';

    beforeEach(async () => {
      await harness.db.sources.createSource({ id: DISABLED_MQTT_ID, name: 'Off Mqtt', type: 'mqtt_broker', config: {}, enabled: false });
    });
    afterEach(async () => {
      await harness.db.sources.deleteSource(DISABLED_MQTT_ID).catch(() => {});
    });

    it('refuses a disabled MQTT source with SOURCE_NOT_MESHTASTIC', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/messages/send').send({ sourceId: DISABLED_MQTT_ID, text: 'hi', channel: 0 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.sendTextMessage).not.toHaveBeenCalled();
    });

    it('refuses a disconnected TCP source with SOURCE_NOT_CONNECTED instead of using the primary', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/traceroute').send({ sourceId: harness.sourceB, destination: PEER_NODE_NUM, channel: 0 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      expect(tcpManager.sendTraceroute).not.toHaveBeenCalled();
    });

    it('GET /device/tx-status never reports the primary radio for a disabled MQTT source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/device/tx-status').query({ sourceId: DISABLED_MQTT_ID });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ txEnabled: false, udpRelayEnabled: false, canTransmit: false, hasLocalRadio: false });
      expect(tcpManager.getDeviceConfig).not.toHaveBeenCalled();
    });

    it('GET /device/tx-status reports a disconnected TCP source as not connected, not the primary', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/device/tx-status').query({ sourceId: harness.sourceB });
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(tcpManager.getDeviceConfig).not.toHaveBeenCalled();
    });

    it('leaves an unknown sourceId to the route (no guard refusal)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/messages/send').send({ sourceId: 'no-such-source-5375', text: 'hi', channel: 0 });
      expect(['SOURCE_NOT_MESHTASTIC', 'SOURCE_NOT_CONNECTED']).not.toContain(res.body.code);
    });

    it('omitted sourceId keeps the legacy primary path', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/messages/send').send({ text: 'hi', channel: 0 });
      expect(res.status).toBe(200);
      expect(tcpManager.sendTextMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('device backup restore', () => {
    it('POST /backup/restore/:file refuses an mqtt_broker source and never touches the primary radio', async () => {
      const restoreSpy = vi.spyOn(deviceRestoreService, 'restoreBackup');
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/backup/restore/backup-5375.yaml').send({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(restoreSpy).not.toHaveBeenCalled();
      restoreSpy.mockRestore();
    });
  });

  describe('connection routes', () => {
    it('POST /connection/disconnect, /reconnect and /configure refuse an mqtt_broker source', async () => {
      const agent = await harness.loginAs(harness.admin);
      for (const [path, body] of [
        ['/connection/disconnect', {}],
        ['/connection/reconnect', {}],
        ['/connection/configure', { nodeIp: '10.0.0.9' }],
      ] as const) {
        const res = await agent.post(path).send({ ...body, sourceId: BROKER_SOURCE_ID });
        expect(res.status, path).toBe(400);
        expect(res.body.code, path).toBe('SOURCE_NOT_MESHTASTIC');
      }
      expect(tcpManager.userDisconnect).not.toHaveBeenCalled();
      expect(tcpManager.userReconnect).not.toHaveBeenCalled();
      expect(tcpManager.setNodeIpOverride).not.toHaveBeenCalled();
    });

    it('GET /connection reports the broker\'s own link, not the primary radio', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/connection').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(200);
      expect(res.body.nodeIp).toBe('broker.local');
      expect(tcpManager.getConnectionStatus).not.toHaveBeenCalled();
    });

    it('GET /connection/info says the broker has no local radio and leaks no TCP address', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/connection/info').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(200);
      expect(res.body.hasLocalRadio).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.1');
      expect(tcpManager.getConnectionStatus).not.toHaveBeenCalled();
    });

    it('GET /connection still reports the TCP source itself (positive control)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/connection').query({ sourceId: harness.sourceA });
      expect(res.status).toBe(200);
      expect(res.body.nodeIp).toBe('10.0.0.1');
    });
  });

  describe('read-only automation status', () => {
    it('GET /announce/preview refuses an mqtt_broker source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/announce/preview').query({ sourceId: BROKER_SOURCE_ID, message: 'hi {LONG_NAME}' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.previewAnnouncementMessage).not.toHaveBeenCalled();
    });

    it('GET /auto-favorite/status reports no local node for an mqtt_broker source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/auto-favorite/status').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ localNodeRole: null, firmwareVersion: null, supportsFavorites: false, autoFavoriteNodes: [] });
      expect(tcpManager.supportsFavorites).not.toHaveBeenCalled();
    });

    it('GET /settings/auto-ping lists no sessions for an mqtt_broker source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/settings/auto-ping').query({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
      expect(tcpManager.getAutoPingSessions).not.toHaveBeenCalled();
    });

    it('POST /auto-ping/stop refuses an mqtt_broker source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`/auto-ping/stop/${PEER_NODE_NUM}`).send({ sourceId: BROKER_SOURCE_ID });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(tcpManager.stopAutoPingSession).not.toHaveBeenCalled();
    });
  });
});
