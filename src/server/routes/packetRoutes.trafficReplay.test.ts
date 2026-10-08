/**
 * GET /api/packets/traffic-management/replay (#5670) on the route harness:
 * real sessions, real permission rows, the real packet log in SQLite. Only the
 * source managers are faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import packetRoutes from './packetRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { PortNum, TransportMechanism } from '../constants/meshtastic.js';
import { TMM_MIRROR_FIRMWARE_VERSION } from '../../utils/trafficManagementReplay.js';

const LOCAL = 0x0a0a0a0a;
const ALICE = 0x11111111;
const BOB = 0x22222222;
const CAROL = 0x33333333; // never gets a node row
const BROADCAST = 0xffffffff;
const MIN = 60_000;
const MESHCORE = 'rt-replay-meshcore';
const MQTT = 'rt-replay-mqtt';
const nodeId = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

describe('GET /api/packets/traffic-management/replay', () => {
  let harness: RouteTestHarness;
  let registered: string[];
  let managerState: {
    connected: boolean;
    supported: boolean;
    trafficManagement: Record<string, number> | undefined;
  };
  let sendSpies: Record<string, ReturnType<typeof vi.fn>>;

  const base = '/api/packets/traffic-management/replay';
  const query = (over: Record<string, string | number> = {}) => ({
    sourceId: harness.sourceA,
    positionMinIntervalSecs: 0,
    rateLimitWindowSecs: 300,
    rateLimitMaxPackets: 5,
    ...over,
  });

  async function addMeshtasticManager(sourceId: string) {
    sendSpies = {
      sendAdminMessage: vi.fn(),
      setModuleConfig: vi.fn(),
      requestModuleConfig: vi.fn(),
      sendTextMessage: vi.fn(),
    };
    await sourceManagerRegistry.addManager({
      sourceId,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: true }),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      getLocalNodeInfo: () => (managerState.connected ? { nodeNum: LOCAL, nodeId: nodeId(LOCAL), longName: 'Local', shortName: 'LCL' } : null),
      getConnectionStatus: async () => ({ connected: managerState.connected, nodeResponsive: managerState.connected, configuring: false, nodeIp: '' }),
      supportsTrafficManagement: () => managerState.supported,
      getCurrentConfig: () => ({
        deviceConfig: { lora: { usePreset: true, modemPreset: 0 } },
        moduleConfig: managerState.trafficManagement ? { trafficManagement: managerState.trafficManagement } : {},
        localNodeInfo: null,
        supportedModules: {},
      }),
      ...sendSpies,
    } as unknown as ISourceManager);
    registered.push(sourceId);
  }

  async function log(over: Record<string, unknown>) {
    await harness.db.insertPacketLogAsync({
      timestamp: Date.now(),
      from_node: ALICE,
      from_node_id: nodeId(ALICE),
      to_node: BROADCAST,
      channel: 0,
      portnum: PortNum.TEXT_MESSAGE_APP,
      portnum_name: 'TEXT_MESSAGE_APP',
      encrypted: false,
      direction: 'rx',
      decrypted_by: 'node',
      transport_mechanism: TransportMechanism.LORA,
      sourceId: harness.sourceA,
      ...over,
    } as never);
  }

  /** 40 minutes of traffic: ALICE and BOB every 20 s, CAROL every 30 s. */
  async function seedTraffic() {
    const end = Date.now() - 1000;
    for (let t = 40 * MIN; t >= 0; t -= 20_000) {
      await log({ timestamp: end - t, from_node: ALICE, from_node_id: nodeId(ALICE) });
      await log({ timestamp: end - t + 1, from_node: BOB, from_node_id: nodeId(BOB), channel: 1, portnum: PortNum.TELEMETRY_APP });
    }
    for (let t = 40 * MIN; t >= 0; t -= 30_000) {
      await log({ timestamp: end - t + 2, from_node: CAROL, from_node_id: nodeId(CAROL) });
    }
  }

  async function seedNodes() {
    const lastHeard = Math.floor(Date.now() / 1000);
    await harness.db.nodes.upsertNode({ nodeNum: ALICE, nodeId: nodeId(ALICE), longName: 'Alice', shortName: 'ALI', channel: 0, lastHeard }, harness.sourceA);
    await harness.db.nodes.upsertNode({ nodeNum: BOB, nodeId: nodeId(BOB), longName: 'Bob', shortName: 'BOB', channel: 1, lastHeard }, harness.sourceA);
  }

  async function grantReplay(sourceId: string) {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', sourceId);
    await harness.grant(harness.limited.id, 'configuration', 'read', sourceId);
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/packets', packetRoutes) });
    harness.db.setSetting('packet_log_enabled', '1');
    registered = [];
    managerState = {
      connected: true,
      supported: true,
      trafficManagement: { positionMinIntervalSecs: 0, rateLimitWindowSecs: 0, rateLimitMaxPackets: 0 },
    };
    await addMeshtasticManager(harness.sourceA);
  });

  afterEach(async () => {
    for (const id of registered) await sourceManagerRegistry.removeManager(id);
    await harness.db.packetLog.clearPacketLogs(harness.sourceA);
    await harness.db.packetLog.clearPacketLogs(harness.sourceB);
    await harness.db.sources.deleteSource(MESHCORE).catch(() => {});
    await harness.db.sources.deleteSource(MQTT).catch(() => {});
    await harness.cleanup();
  });

  describe('permissions', () => {
    it('401/403s an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get(base).query(query());
      expect([401, 403]).toContain(res.status);
    });

    it('needs packetmonitor:read on the named source', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(base).query(query())).status).toBe(403);
    });

    it('needs configuration:read on the named source too', async () => {
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(base).query(query())).status).toBe(403);
    });

    it('a grant on source A cannot estimate source B', async () => {
      await addMeshtasticManager(harness.sourceB);
      await grantReplay(harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(base).query(query())).status).toBe(200);
      expect((await agent.get(base).query(query({ sourceId: harness.sourceB }))).status).toBe(403);
    });

    it('400s without a sourceId instead of falling back to some source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query({ rateLimitWindowSecs: 300, rateLimitMaxPackets: 5, positionMinIntervalSecs: 0 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_ID_REQUIRED');
    });
  });

  describe('source type', () => {
    it('refuses a MeshCore source', async () => {
      await harness.db.sources.createSource({ id: MESHCORE, name: 'MC', type: 'meshcore', config: {}, enabled: true } as never);
      await sourceManagerRegistry.addManager({
        sourceId: MESHCORE,
        sourceType: 'meshcore',
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue({ sourceId: MESHCORE, sourceName: 'MC', sourceType: 'meshcore', connected: true }),
        getLocalNodeInfo: () => null,
      } as unknown as ISourceManager);
      registered.push(MESHCORE);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query({ sourceId: MESHCORE }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
    });

    it('refuses an MQTT source', async () => {
      await harness.db.sources.createSource({ id: MQTT, name: 'MQ', type: 'mqtt_broker', config: {}, enabled: true } as never);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query({ sourceId: MQTT }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
    });

    it('refuses a Meshtastic source with no live manager', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query({ sourceId: harness.sourceB }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
    });

    it('refuses a Meshtastic source whose node is not connected', async () => {
      managerState.connected = false;
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
    });

    it('refuses firmware without Traffic Management', async () => {
      managerState.supported = false;
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TRAFFIC_MANAGEMENT_UNSUPPORTED');
    });

    it('refuses when the node has not reported its Traffic Management config', async () => {
      managerState.trafficManagement = undefined;
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TRAFFIC_MANAGEMENT_CONFIG_NOT_LOADED');
    });
  });

  describe('input', () => {
    it.each([
      { rateLimitMaxPackets: -1 },
      { rateLimitMaxPackets: '1.5' },
      { rateLimitWindowSecs: 'abc' },
      { positionMinIntervalSecs: '99999999999' },
    ])('400s on %o', async (bad) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query(bad as Record<string, string | number>));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SETTINGS');
    });
  });

  describe('result', () => {
    it('refuses, with the reason, when packet logging is off', async () => {
      await seedTraffic();
      harness.db.setSetting('packet_log_enabled', '0');
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query({ positionMinIntervalSecs: 3600 }));
      expect(res.status).toBe(200);
      expect(res.body.data.loggingEnabled).toBe(false);
      expect(res.body.data.rowsScanned).toBe(0);
      expect(res.body.data.rateLimit).toMatchObject({ status: 'cannot_estimate', reason: 'PACKET_LOG_DISABLED' });
      expect(res.body.data.positionDedup).toMatchObject({ status: 'cannot_estimate', reason: 'PACKET_LOG_DISABLED' });
    });

    it('refuses when the log holds too little history', async () => {
      await log({ timestamp: Date.now() - 5 * MIN });
      await log({ timestamp: Date.now() - 1000 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query());
      expect(res.body.data.rateLimit).toMatchObject({ status: 'cannot_estimate', reason: 'HISTORY_TOO_SHORT' });
    });

    it('refuses a setting looser than the one the node runs', async () => {
      await seedTraffic();
      managerState.trafficManagement = { positionMinIntervalSecs: 0, rateLimitWindowSecs: 300, rateLimitMaxPackets: 3 };
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query({ rateLimitMaxPackets: 10 }));
      expect(res.body.data.current).toMatchObject({ rateLimitWindowSecs: 300, rateLimitMaxPackets: 3 });
      expect(res.body.data.rateLimit).toMatchObject({ status: 'cannot_estimate', reason: 'LOOSER_THAN_CURRENT' });
    });

    it('returns a range, breakdowns and caveats for an admin, reading only this source', async () => {
      await seedTraffic();
      await seedNodes();
      // Noise on another source must not count.
      await log({ sourceId: harness.sourceB, from_node: 0x99999999 });
      const rowsBefore = await harness.db.packetLog.getPacketLogCount({ sourceId: harness.sourceA });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query());
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(res.body.success).toBe(true);
      expect(data.firmwareVersion).toBe(TMM_MIRROR_FIRMWARE_VERSION);
      expect(data.sourceId).toBe(harness.sourceA);
      expect(data.rowsScanned).toBe(rowsBefore);
      expect(data.truncated).toBe(false);
      expect(data.positionDedup.status).toBe('unchanged');

      const rate = data.rateLimit;
      expect(rate.status).toBe('estimate');
      expect(rate.bound).toBe('lower_bound');
      expect(rate.droppedMin).toBeGreaterThan(0);
      expect(rate.droppedMax).toBeGreaterThanOrEqual(rate.droppedMin);
      expect(rate.caveats).toEqual(expect.arrayContaining(['ALREADY_FILTERED_ABSENT', 'RELAYED_UNICAST_INVISIBLE', 'LOCAL_NODE_ONLY']));
      // CAROL has no node row on this source: counted, never named, even for an admin.
      expect(rate.bySender.map((r: { key: number | null }) => r.key).sort()).toEqual([ALICE, BOB, null].sort());
      expect(data.senders[String(ALICE)]).toMatchObject({ shortName: 'ALI', longName: 'Alice' });
      expect(data.senders[String(CAROL)]).toBeUndefined();
      expect(rate.byPortnum.map((r: { key: number | null }) => r.key).sort()).toEqual([PortNum.TEXT_MESSAGE_APP, PortNum.TELEMETRY_APP].sort());

      // A read: nothing written, nothing sent.
      expect(await harness.db.packetLog.getPacketLogCount({ sourceId: harness.sourceA })).toBe(rowsBefore);
      for (const spy of Object.values(sendSpies)) expect(spy).not.toHaveBeenCalled();
    });

    it('does not name a sender or a port the caller cannot see', async () => {
      await seedTraffic();
      await seedNodes();
      await grantReplay(harness.sourceA);
      // May see nodes and packets on channel 0 (ALICE), not channel 1 (BOB).
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(base).query(query());
      expect(res.status).toBe(200);
      const rate = res.body.data.rateLimit;
      expect(rate.status).toBe('estimate');
      expect(rate.bySender.map((r: { key: number | null }) => r.key).sort()).toEqual([ALICE, null].sort());
      expect(Object.keys(res.body.data.senders)).toEqual([String(ALICE)]);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(String(BOB));
      expect(text).not.toContain(nodeId(BOB));
      expect(text).not.toContain('Bob');
      // No channel read grant at all: every port folds into "other".
      expect(rate.byPortnum.map((r: { key: number | null }) => r.key)).toEqual([null]);
      // The totals still count everyone.
      const other = rate.bySender.find((r: { key: number | null }) => r.key === null);
      expect(other.max).toBeGreaterThan(0);
    });

    it('names a port once the caller may read that channel', async () => {
      await seedTraffic();
      await seedNodes();
      await grantReplay(harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(base).query(query());
      const keys = res.body.data.rateLimit.byPortnum.map((r: { key: number | null }) => r.key).sort();
      expect(keys).toEqual([PortNum.TEXT_MESSAGE_APP, null].sort());
      // read is not viewOnMap: no sender is named.
      expect(res.body.data.rateLimit.bySender.map((r: { key: number | null }) => r.key)).toEqual([null]);
    });

    it('does not count rows MeshMonitor decrypted itself', async () => {
      await seedTraffic();
      const end = Date.now() - 500;
      for (let i = 0; i < 50; i++) {
        await log({ timestamp: end - i * 100, from_node: CAROL, from_node_id: nodeId(CAROL), decrypted_by: 'server' });
      }
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query());
      expect(res.body.data.skipped.serverDecrypted).toBe(50);
      expect(res.body.data.rateLimit.caveats).toContain('SERVER_DECRYPTED_NOT_COUNTED');
    });

    it('reads position coordinates for the dedup rule', async () => {
      await harness.db.channels.upsertChannel({ id: 0, name: '', psk: 'AQ==', role: 1, positionPrecision: 13 } as never, harness.sourceA);
      const end = Date.now() - 1000;
      const metadata = JSON.stringify({ decoded_payload: { latitudeI: 407000000, longitudeI: -740000000 } });
      for (let t = 120 * MIN; t >= 0; t -= 2 * MIN) {
        await log({ timestamp: end - t, portnum: PortNum.POSITION_APP, portnum_name: 'POSITION_APP', metadata });
      }
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(base).query(query({ positionMinIntervalSecs: 3600, rateLimitWindowSecs: 0, rateLimitMaxPackets: 0 }));
      const dedup = res.body.data.positionDedup;
      expect(dedup.status).toBe('estimate');
      expect(dedup.bound).toBe('logged_only');
      expect(dedup.consideredPackets).toBe(61);
      expect(dedup.droppedMin).toBeGreaterThan(40);
      expect(res.body.data.rateLimit.status).toBe('unchanged');
    });
  });
});
