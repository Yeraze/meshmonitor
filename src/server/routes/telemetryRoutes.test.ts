import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    nodes: {
      getNode: vi.fn(),
      getAllNodes: vi.fn(),
    },
    telemetry: {
      getTelemetryByNode: vi.fn(),
      deleteTelemetryByNodeAndType: vi.fn(),
    },
    settings: {
      getSettingForSource: vi.fn(),
    },
    getDirectNeighborStatsAsync: vi.fn(),
    getTelemetryByNodeAveragedAsync: vi.fn(),
    getPacketRatesAsync: vi.fn(),
    getSmartHopsStatsAsync: vi.fn(),
    getLinkQualityHistoryAsync: vi.fn(),
    getAllNodesTelemetryTypesAsync: vi.fn(),
    getAllEstimatedPositionsAsync: vi.fn(),
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  optionalAuth: () => (req: any, _res: any, next: any) => {
    req.user = { id: 1, isAdmin: true };
    next();
  },
  requireAuth: () => (req: any, _res: any, next: any) => {
    req.user = { id: 1, isAdmin: true };
    next();
  },
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.user = { id: 1, isAdmin: true };
    next();
  },
  hasPermission: vi.fn().mockResolvedValue(true),
}));

vi.mock('../utils/nodeEnhancer.js', () => ({
  filterNodesByChannelPermission: vi.fn(async (nodes: any[]) => nodes),
  checkNodeChannelAccess: vi.fn().mockResolvedValue(true),
  getEffectiveDbNodePosition: vi.fn(() => ({ latitude: null, longitude: null })),
}));

import databaseService from '../../services/database.js';
import telemetryRoutes from './telemetryRoutes.js';

const app = express();
app.use(express.json());
app.use('/', telemetryRoutes);

beforeEach(() => vi.clearAllMocks());

describe('GET /direct-neighbors', () => {
  it('returns stats with count', async () => {
    (databaseService.getDirectNeighborStatsAsync as any).mockResolvedValue({ a: 1, b: 2 });
    const res = await request(app).get('/direct-neighbors');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /telemetry/:nodeId', () => {
  it('returns telemetry data', async () => {
    (databaseService.nodes.getNode as any).mockResolvedValue({});
    (databaseService.getTelemetryByNodeAveragedAsync as any).mockResolvedValue([
      { telemetryType: 'temperature', value: 20 },
    ]);
    const res = await request(app).get('/telemetry/!12345678');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('skips the node lookup for a 64-hex MeshCore pubkey (no out-of-range nodeNum) (#3677)', async () => {
    // A 64-char pubkey would overflow parseInt and trip getNode's
    // out-of-range guard on every poll; the route must not call getNode.
    (databaseService.getTelemetryByNodeAveragedAsync as any).mockResolvedValue([
      { telemetryType: 'temperature', value: 20 },
    ]);
    const pubkey = 'a'.repeat(64);
    const res = await request(app).get(`/telemetry/${pubkey}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(databaseService.nodes.getNode).not.toHaveBeenCalled();
  });
});

describe('GET /telemetry/:nodeId/rates', () => {
  it('returns packet rates (sqlite path)', async () => {
    (databaseService.getPacketRatesAsync as any).mockResolvedValue({ numPacketsRx: [] });
    const res = await request(app).get('/telemetry/!12345678/rates');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('numPacketsRx');
  });
});

describe('GET /telemetry/:nodeId/smarthops', () => {
  it('returns smart hop stats and clamps hours', async () => {
    (databaseService.getSmartHopsStatsAsync as any).mockResolvedValue([{ avg: 2 }]);
    const res = await request(app).get('/telemetry/!12345678/smarthops?hours=9999&sourceId=src-A');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(databaseService.getSmartHopsStatsAsync).toHaveBeenCalledWith('!12345678', expect.any(Number), expect.any(Number), 'src-A');
  });

  it('400s when sourceId is omitted', async () => {
    const res = await request(app).get('/telemetry/!12345678/smarthops');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });
});

describe('GET /telemetry/:nodeId/linkquality', () => {
  it('returns link quality history', async () => {
    (databaseService.getLinkQualityHistoryAsync as any).mockResolvedValue([{ t: 1 }]);
    const res = await request(app).get('/telemetry/!12345678/linkquality?sourceId=src-A');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(databaseService.getLinkQualityHistoryAsync).toHaveBeenCalledWith('!12345678', expect.any(Number), 'src-A');
  });

  it('400s when sourceId is omitted', async () => {
    const res = await request(app).get('/telemetry/!12345678/linkquality');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });
});

describe('DELETE /telemetry/:nodeId/:telemetryType', () => {
  it('returns 200 when deleted and scopes to the required source', async () => {
    (databaseService.telemetry.deleteTelemetryByNodeAndType as any).mockResolvedValue(true);
    const res = await request(app).delete('/telemetry/!12345678/temperature?sourceId=src-A');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(databaseService.telemetry.deleteTelemetryByNodeAndType).toHaveBeenCalledWith('!12345678', 'temperature', 'src-A');
  });

  it('returns 404 when nothing deleted', async () => {
    (databaseService.telemetry.deleteTelemetryByNodeAndType as any).mockResolvedValue(false);
    const res = await request(app).delete('/telemetry/!12345678/temperature?sourceId=src-A');
    expect(res.status).toBe(404);
  });

  it('400s when sourceId is omitted (no cross-source wipe)', async () => {
    const res = await request(app).delete('/telemetry/!12345678/temperature');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });
});

describe('GET /telemetry/available/nodes', () => {
  it('classifies nodes with telemetry, weather, and unmapped status', async () => {
    (databaseService.nodes.getAllNodes as any).mockResolvedValue([
      { nodeId: '!a', hasPKC: false, publicKey: null },
      { nodeId: '!b', hasPKC: true, publicKey: null },
    ]);
    (databaseService.getAllNodesTelemetryTypesAsync as any).mockResolvedValue(
      new Map([['!a', ['temperature']]])
    );
    (databaseService.getAllEstimatedPositionsAsync as any).mockResolvedValue([]);
    (databaseService.settings.getSettingForSource as any).mockResolvedValue(null);

    const res = await request(app).get('/telemetry/available/nodes');
    expect(res.status).toBe(200);
    expect(res.body.nodes).toContain('!a');
    expect(res.body.weather).toContain('!a');
    expect(res.body.unmapped).toEqual(expect.arrayContaining(['!a', '!b']));
    expect(res.body.pkc).toContain('!b');
  });
});
