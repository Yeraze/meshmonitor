import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockManager = vi.hoisted(() => ({
  sourceId: 'mgr-src',
  sendTraceroute: vi.fn(),
  sendPositionRequest: vi.fn(),
  sendNodeInfoRequest: vi.fn(),
  sendNeighborInfoRequest: vi.fn(),
  sendTelemetryRequest: vi.fn(),
  getLocalNodeInfo: vi.fn(),
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn().mockReturnValue(mockManager),
}));

vi.mock('../utils/parseDestination.js', () => ({
  parseDestinationNum: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: {
      getNode: vi.fn(),
    },
    messages: {
      insertMessage: vi.fn(),
    },
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.user = { id: 1, isAdmin: true };
    next();
  },
}));

import databaseService from '../../services/database.js';
import { parseDestinationNum } from '../utils/parseDestination.js';
import meshRequestRoutes from './meshRequestRoutes.js';

const app = express();
app.use(express.json());
app.use('/', meshRequestRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  (parseDestinationNum as any).mockResolvedValue(0x12345678);
  (databaseService.nodes.getNode as any).mockResolvedValue({ channel: 2 });
  mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: 1, nodeId: '!00000001' });
});

describe('POST /traceroute', () => {
  it('returns 400 when destination missing', async () => {
    const res = await request(app).post('/traceroute').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when destination cannot be parsed', async () => {
    (parseDestinationNum as any).mockResolvedValue(null);
    const res = await request(app).post('/traceroute').send({ destination: 'bad' });
    expect(res.status).toBe(400);
  });

  it('sends traceroute on the node channel', async () => {
    mockManager.sendTraceroute.mockResolvedValue(undefined);
    const res = await request(app).post('/traceroute').send({ destination: '!12345678' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockManager.sendTraceroute).toHaveBeenCalledWith(0x12345678, 2);
  });

  it('returns 503 when node is not connected', async () => {
    mockManager.sendTraceroute.mockRejectedValue(new Error('Not connected to Meshtastic node'));
    const res = await request(app).post('/traceroute').send({ destination: '!12345678' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Service Unavailable');
    expect(res.body.message).toContain('Not connected');
  });
});

describe('POST /position/request', () => {
  it('uses explicit channel when valid', async () => {
    mockManager.sendPositionRequest.mockResolvedValue({ packetId: 5, requestId: 9 });
    const res = await request(app).post('/position/request').send({ destination: '!12345678', channel: 3 });
    expect(res.status).toBe(200);
    expect(mockManager.sendPositionRequest).toHaveBeenCalledWith(0x12345678, 3);
    expect(databaseService.messages.insertMessage).toHaveBeenCalled();
  });

  it('returns 400 when destination missing', async () => {
    const res = await request(app).post('/position/request').send({});
    expect(res.status).toBe(400);
  });

  it('returns 503 when node is not connected', async () => {
    mockManager.sendPositionRequest.mockRejectedValue(new Error('Not connected to Meshtastic node'));
    const res = await request(app).post('/position/request').send({ destination: '!12345678' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Service Unavailable');
    expect(res.body.message).toContain('Not connected');
  });
});

describe('POST /nodeinfo/request', () => {
  it('sends nodeinfo request and inserts system message', async () => {
    mockManager.sendNodeInfoRequest.mockResolvedValue({ packetId: 7, requestId: 11 });
    const res = await request(app).post('/nodeinfo/request').send({ destination: '!12345678' });
    expect(res.status).toBe(200);
    expect(mockManager.sendNodeInfoRequest).toHaveBeenCalledWith(0x12345678, 2);
    expect(databaseService.messages.insertMessage).toHaveBeenCalled();
  });

  it('returns 503 when node is not connected', async () => {
    mockManager.sendNodeInfoRequest.mockRejectedValue(new Error('Not connected to Meshtastic node'));
    const res = await request(app).post('/nodeinfo/request').send({ destination: '!12345678' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Service Unavailable');
    expect(res.body.message).toContain('Not connected');
  });
});

describe('POST /neighborinfo/request', () => {
  it('rejects nodes that are neither local nor 0-hop', async () => {
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: 1, nodeId: '!00000001' });
    (databaseService.nodes.getNode as any).mockResolvedValue({ channel: 0, hopsAway: 3 });
    const res = await request(app).post('/neighborinfo/request').send({ destination: '!12345678' });
    expect(res.status).toBe(403);
    expect(res.body.eligible).toBe(false);
  });

  it('sends to a directly-heard (0-hop) node', async () => {
    // Unique destination num so the module-level rate-limit map doesn't bleed
    // across tests.
    (parseDestinationNum as any).mockResolvedValue(0x0000aaaa);
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: 1, nodeId: '!00000001' });
    (databaseService.nodes.getNode as any).mockResolvedValue({ channel: 1, hopsAway: 0 });
    mockManager.sendNeighborInfoRequest.mockResolvedValue({ packetId: 3, requestId: 4 });
    const res = await request(app).post('/neighborinfo/request').send({ destination: '!0000aaaa' });
    expect(res.status).toBe(200);
    expect(mockManager.sendNeighborInfoRequest).toHaveBeenCalledWith(0x0000aaaa, 1);
  });

  it('rate-limits repeat requests to the same destination', async () => {
    (parseDestinationNum as any).mockResolvedValue(0x0000bbbb);
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: 1, nodeId: '!00000001' });
    (databaseService.nodes.getNode as any).mockResolvedValue({ channel: 1, hopsAway: 0 });
    mockManager.sendNeighborInfoRequest.mockResolvedValue({ packetId: 3, requestId: 4 });
    await request(app).post('/neighborinfo/request').send({ destination: '!0000bbbb' });
    const res = await request(app).post('/neighborinfo/request').send({ destination: '!0000bbbb' });
    expect(res.status).toBe(429);
    expect(res.body.retryAfter).toBeGreaterThan(0);
  });

  it('returns 503 when node is not connected (after eligibility passes)', async () => {
    // Unique destination so the module-level rate-limit map doesn't bleed across tests.
    (parseDestinationNum as any).mockResolvedValue(0x0000cccc);
    mockManager.getLocalNodeInfo.mockReturnValue({ nodeNum: 1, nodeId: '!00000001' });
    (databaseService.nodes.getNode as any).mockResolvedValue({ channel: 1, hopsAway: 0 });
    mockManager.sendNeighborInfoRequest.mockRejectedValue(new Error('Not connected to Meshtastic node'));
    const res = await request(app).post('/neighborinfo/request').send({ destination: '!0000cccc' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Service Unavailable');
    expect(res.body.message).toContain('Not connected');
  });
});

describe('POST /telemetry/request', () => {
  it('rejects invalid telemetry type', async () => {
    const res = await request(app).post('/telemetry/request').send({ destination: '!12345678', telemetryType: 'nope' });
    expect(res.status).toBe(400);
  });

  it('sends telemetry request', async () => {
    mockManager.sendTelemetryRequest.mockResolvedValue({ packetId: 1, requestId: 2 });
    const res = await request(app).post('/telemetry/request').send({ destination: '!12345678', telemetryType: 'environment' });
    expect(res.status).toBe(200);
    expect(mockManager.sendTelemetryRequest).toHaveBeenCalledWith(0x12345678, 2, 'environment');
  });

  // Regression for #3573: when the frontend omits sourceId, the channel lookup
  // must be scoped to the resolved manager's source (not undefined, which would
  // cross-source-match a wrong row and send on an invalid channel).
  it('scopes the channel lookup to the manager source when no sourceId is sent', async () => {
    mockManager.sendTelemetryRequest.mockResolvedValue({ packetId: 1, requestId: 2 });
    await request(app).post('/telemetry/request').send({ destination: '!12345678', telemetryType: 'device' });
    expect(databaseService.nodes.getNode).toHaveBeenCalledWith(0x12345678, 'mgr-src');
  });

  it('clamps an out-of-range stored channel (the MQTT channel=101 case) to 0', async () => {
    (databaseService.nodes.getNode as any).mockResolvedValue({ channel: 101 });
    mockManager.sendTelemetryRequest.mockResolvedValue({ packetId: 1, requestId: 2 });
    await request(app).post('/telemetry/request').send({ destination: '!12345678', telemetryType: 'device' });
    expect(mockManager.sendTelemetryRequest).toHaveBeenCalledWith(0x12345678, 0, 'device');
  });

  it('returns 503 when node is not connected', async () => {
    mockManager.sendTelemetryRequest.mockRejectedValue(new Error('Not connected to Meshtastic node'));
    const res = await request(app).post('/telemetry/request').send({ destination: '!12345678', telemetryType: 'environment' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Service Unavailable');
    expect(res.body.message).toContain('Not connected');
  });
});
