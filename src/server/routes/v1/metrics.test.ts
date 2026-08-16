/**
 * Metrics API Endpoint Unit Tests
 *
 * Tests the v1 Prometheus metrics endpoint: exposition format, per-source
 * permission filtering, per-node telemetry export, the active-node window
 * parameter, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Source } from '../../../db/repositories/sources.js';
import type { DbNode } from '../../../db/types.js';
import type { User } from '../../../types/auth.js';
import type { ISourceManager } from '../../sourceManagerRegistry.js';

// Mock the database service and source manager registry before importing
// the router
vi.mock('../../../services/database.js', () => ({
  default: {
    sources: {
      getAllSources: vi.fn(),
    },
    nodes: {
      getNodeCount: vi.fn(),
      getActiveNodeCount: vi.fn(),
      getActiveNodes: vi.fn(),
    },
    messages: {
      getMessageCountSince: vi.fn(),
    },
    packetLog: {
      getPacketCountsByPortSince: vi.fn(),
    },
    checkPermissionAsync: vi.fn(),
  },
}));

vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getAllManagers: vi.fn(),
  },
}));

// Import after mocking
import metricsRouter from './metrics.js';
import databaseService from '../../../services/database.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';

const makeUser = (overrides: Partial<User>): User => ({
  id: 1,
  username: 'user',
  passwordHash: null,
  email: null,
  displayName: null,
  authProvider: 'local',
  oidcSubject: null,
  isAdmin: false,
  isActive: true,
  passwordLocked: false,
  mfaEnabled: false,
  mfaSecret: null,
  mfaBackupCodes: null,
  createdAt: 1700000000,
  lastLoginAt: null,
  createdBy: null,
  ...overrides,
});

const adminUser = makeUser({ id: 1, username: 'admin', isAdmin: true });
const readOnlyUser = makeUser({ id: 2, username: 'scraper' });

const tcpSource: Source = {
  id: 'src_tcp',
  name: 'Base Station',
  type: 'meshtastic_tcp',
  config: {},
  enabled: true,
  displayOrder: 0,
  createdAt: 1700000000,
  updatedAt: 1700000000,
  createdBy: 1,
};

const mqttSource: Source = {
  id: 'src_mqtt',
  name: 'Region Firehose',
  type: 'mqtt_broker',
  config: {},
  enabled: true,
  displayOrder: 1,
  createdAt: 1700000100,
  updatedAt: 1700000100,
  createdBy: 1,
};

const fullNode: DbNode = {
  nodeNum: 0xa1b2c3d4,
  nodeId: '!a1b2c3d4',
  longName: 'Base Station',
  shortName: 'BASE',
  hwModel: 9,
  batteryLevel: 85,
  voltage: 4.05,
  channelUtilization: 12.5,
  airUtilTx: 3.25,
  snr: 8.5,
  rssi: -45,
  lastHeard: 1700000500,
  hopsAway: 0,
  isIgnored: false,
  createdAt: 1700000000,
  updatedAt: 1700000500,
};

// A node that has never reported device metrics: every telemetry field
// null. Only last-heard should be exported for it.
const bareNode: DbNode = {
  nodeNum: 0x11223344,
  nodeId: '!11223344',
  longName: null,
  shortName: null,
  hwModel: null,
  batteryLevel: null,
  voltage: null,
  channelUtilization: null,
  airUtilTx: null,
  snr: null,
  rssi: null,
  lastHeard: 1700000400,
  hopsAway: null,
  isIgnored: false,
  createdAt: 1700000000,
  updatedAt: 1700000400,
};

const ignoredNode: DbNode = {
  ...fullNode,
  nodeNum: 0x55667788,
  nodeId: '!55667788',
  shortName: 'NOIS',
  isIgnored: true,
};

const connectedTcpManager = {
  sourceId: 'src_tcp',
  getStatus: () => ({
    sourceId: 'src_tcp',
    sourceName: 'Base Station',
    sourceType: 'meshtastic_tcp' as const,
    connected: true,
  }),
} as unknown as ISourceManager;

const createApp = (user: User | null) => {
  const app = express();
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use('/api/v1/metrics', metricsRouter);
  return app;
};

describe('Metrics API Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(databaseService.sources.getAllSources).mockResolvedValue([tcpSource, mqttSource]);
    vi.mocked(databaseService.nodes.getNodeCount).mockResolvedValue(12);
    vi.mocked(databaseService.nodes.getActiveNodeCount).mockResolvedValue(7);
    vi.mocked(databaseService.nodes.getActiveNodes).mockResolvedValue([fullNode, bareNode, ignoredNode]);
    vi.mocked(databaseService.messages.getMessageCountSince).mockResolvedValue(42);
    vi.mocked(databaseService.packetLog.getPacketCountsByPortSince).mockResolvedValue([
      { portnum: 3, portnumName: 'POSITION_APP', packetCount: 120 },
      { portnum: 67, portnumName: 'TELEMETRY_APP', packetCount: 55 },
      { portnum: 512, portnumName: null, packetCount: 7 },
    ]);
    vi.mocked(databaseService.checkPermissionAsync).mockResolvedValue(true);
    // src_mqtt deliberately has no manager -> reported as down
    vi.mocked(sourceManagerRegistry.getAllManagers).mockReturnValue([connectedTcpManager]);
  });

  describe('GET /api/v1/metrics', () => {
    it('returns Prometheus text format with source and node metrics', async () => {
      const app = createApp(adminUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      expect(response.headers['content-type']).toContain('text/plain');

      const body = response.text;
      // Source-level metrics
      expect(body).toContain('meshmonitor_source_info{source="src_tcp",name="Base Station",type="meshtastic_tcp"} 1');
      expect(body).toContain('meshmonitor_source_connected{source="src_tcp"} 1');
      expect(body).toContain('meshmonitor_nodes_total{source="src_tcp"} 12');
      expect(body).toContain('meshmonitor_nodes_active{source="src_tcp"} 7');
      expect(body).toContain('meshmonitor_messages_last_hour{source="src_tcp"} 42');
      // A source without a running manager reports its link as down
      expect(body).toContain('meshmonitor_source_connected{source="src_mqtt"} 0');
      // Per-node telemetry, channel utilization above all
      expect(body).toContain('meshmonitor_node_channel_utilization_percent{source="src_tcp",node_id="!a1b2c3d4",short_name="BASE"} 12.5');
      expect(body).toContain('meshmonitor_node_air_util_tx_percent{source="src_tcp",node_id="!a1b2c3d4",short_name="BASE"} 3.25');
      expect(body).toContain('meshmonitor_node_battery_level{source="src_tcp",node_id="!a1b2c3d4",short_name="BASE"} 85');
      expect(body).toContain('meshmonitor_node_voltage_volts{source="src_tcp",node_id="!a1b2c3d4",short_name="BASE"} 4.05');
      expect(body).toContain('meshmonitor_node_snr_db{source="src_tcp",node_id="!a1b2c3d4",short_name="BASE"} 8.5');
      expect(body).toContain('meshmonitor_node_rssi_dbm{source="src_tcp",node_id="!a1b2c3d4",short_name="BASE"} -45');
      expect(body).toContain('meshmonitor_node_last_heard_timestamp_seconds{source="src_tcp",node_id="!a1b2c3d4",short_name="BASE"} 1700000500');
      expect(body).toContain('meshmonitor_node_hops_away{source="src_tcp",node_id="!a1b2c3d4",short_name="BASE"} 0');
      // Build info
      expect(body).toMatch(/meshmonitor_info\{version="[^"]+"\} 1/);
    });

    it('omits telemetry gauges a node never reported, but keeps last-heard', async () => {
      const app = createApp(adminUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      const body = response.text;
      expect(body).toContain('meshmonitor_node_last_heard_timestamp_seconds{source="src_tcp",node_id="!11223344",short_name="unknown"} 1700000400');
      expect(body).not.toContain('meshmonitor_node_battery_level{source="src_tcp",node_id="!11223344"');
      expect(body).not.toContain('meshmonitor_node_channel_utilization_percent{source="src_tcp",node_id="!11223344"');
    });

    it('does not export ignored nodes', async () => {
      const app = createApp(adminUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      expect(response.text).not.toContain('!55667788');
    });

    it('skips sources the token has no nodes read permission on', async () => {
      vi.mocked(databaseService.checkPermissionAsync).mockImplementation(
        async (_userId, resource, _action, sourceId) =>
          resource === 'nodes' && sourceId === 'src_tcp'
      );

      const app = createApp(readOnlyUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      const body = response.text;
      expect(body).toContain('meshmonitor_nodes_total{source="src_tcp"}');
      expect(body).not.toContain('src_mqtt');
      // nodes read alone does not grant the message-volume gauge
      expect(body).not.toContain('meshmonitor_messages_last_hour{source="src_tcp"}');
    });

    it('exports the message-volume gauge when the token also has messages read', async () => {
      vi.mocked(databaseService.checkPermissionAsync).mockImplementation(
        async (_userId, _resource, _action, sourceId) => sourceId === 'src_tcp'
      );

      const app = createApp(readOnlyUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      expect(response.text).toContain('meshmonitor_messages_last_hour{source="src_tcp"} 42');
      expect(databaseService.messages.getMessageCountSince).toHaveBeenCalledWith('src_tcp', 3600000);
    });

    it('exports the packet mix by protocol with display names', async () => {
      const app = createApp(adminUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      const body = response.text;
      expect(body).toContain('meshmonitor_packets_by_port_last_hour{source="src_tcp",portnum="3",portnum_name="POSITION_APP"} 120');
      expect(body).toContain('meshmonitor_packets_by_port_last_hour{source="src_tcp",portnum="67",portnum_name="TELEMETRY_APP"} 55');
      // A port the decoder has no name for falls back to the number
      expect(body).toContain('meshmonitor_packets_by_port_last_hour{source="src_tcp",portnum="512",portnum_name="PORT_512"} 7');
      expect(databaseService.packetLog.getPacketCountsByPortSince).toHaveBeenCalledWith('src_tcp', 3600000);
    });

    it('emits no packet-mix series when the packet log is empty', async () => {
      vi.mocked(databaseService.packetLog.getPacketCountsByPortSince).mockResolvedValue([]);

      const app = createApp(adminUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      expect(response.text).not.toContain('meshmonitor_packets_by_port_last_hour{');
    });

    it('withholds the packet mix without packetmonitor read permission', async () => {
      vi.mocked(databaseService.checkPermissionAsync).mockImplementation(
        async (_userId, resource, _action, sourceId) =>
          sourceId === 'src_tcp' && resource !== 'packetmonitor'
      );

      const app = createApp(readOnlyUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      expect(response.text).toContain('meshmonitor_messages_last_hour{source="src_tcp"} 42');
      expect(response.text).not.toContain('meshmonitor_packets_by_port_last_hour{');
    });

    it('uses the default 24h per-node window', async () => {
      const app = createApp(adminUser);
      await request(app).get('/api/v1/metrics').expect(200);

      expect(databaseService.nodes.getActiveNodes).toHaveBeenCalledWith(1, 'src_tcp');
    });

    it('respects and clamps the window query parameter', async () => {
      const app = createApp(adminUser);

      await request(app).get('/api/v1/metrics?window=3600').expect(200);
      expect(databaseService.nodes.getActiveNodes).toHaveBeenCalledWith(3600 / 86400, 'src_tcp');

      vi.mocked(databaseService.nodes.getActiveNodes).mockClear();
      await request(app).get('/api/v1/metrics?window=1').expect(200);
      expect(databaseService.nodes.getActiveNodes).toHaveBeenCalledWith(60 / 86400, 'src_tcp');

      vi.mocked(databaseService.nodes.getActiveNodes).mockClear();
      await request(app).get('/api/v1/metrics?window=99999999').expect(200);
      expect(databaseService.nodes.getActiveNodes).toHaveBeenCalledWith(604800 / 86400, 'src_tcp');
    });

    it('ignores disabled sources', async () => {
      vi.mocked(databaseService.sources.getAllSources).mockResolvedValue([
        { ...tcpSource, enabled: false },
      ]);

      const app = createApp(adminUser);
      const response = await request(app).get('/api/v1/metrics').expect(200);

      expect(response.text).not.toContain('src_tcp');
    });

    it('returns 401 without an authenticated user', async () => {
      const app = createApp(null);
      const response = await request(app).get('/api/v1/metrics').expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });

    it('returns 500 when a database query fails', async () => {
      vi.mocked(databaseService.sources.getAllSources).mockRejectedValue(new Error('db gone'));

      const app = createApp(adminUser);
      const response = await request(app).get('/api/v1/metrics').expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Internal Server Error');
    });
  });
});
