import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockManager = vi.hoisted(() => ({
  getDeviceConfig: vi.fn(),
  getSecurityKeys: vi.fn(),
  isUdpBroadcastRelayEnabled: vi.fn(() => false),
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn().mockReturnValue(mockManager),
}));

vi.mock('../auth/authMiddleware.js', () => ({
  optionalAuth: () => (req: any, _res: any, next: any) => next(),
  requireAdmin: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

import deviceStatusRoutes from './deviceStatusRoutes.js';

const app = express();
app.use(express.json());
app.use('/', deviceStatusRoutes);

beforeEach(() => vi.clearAllMocks());

describe('GET /device/tx-status', () => {
  beforeEach(() => mockManager.isUdpBroadcastRelayEnabled.mockReturnValue(false));

  it('reports txEnabled true by default', async () => {
    mockManager.getDeviceConfig.mockResolvedValue({ lora: {} });
    const res = await request(app).get('/device/tx-status');
    expect(res.status).toBe(200);
    expect(res.body.txEnabled).toBe(true);
    expect(res.body.canTransmit).toBe(true);
  });

  it('reports txEnabled false when explicitly disabled', async () => {
    mockManager.getDeviceConfig.mockResolvedValue({ lora: { txEnabled: false } });
    const res = await request(app).get('/device/tx-status');
    expect(res.body.txEnabled).toBe(false);
    expect(res.body.udpRelayEnabled).toBe(false);
    expect(res.body.canTransmit).toBe(false);
  });

  // #4394: firmware still UDP-broadcasts a TX-disabled node's outgoing packets,
  // and a LAN peer relays them onto the mesh — so sends are NOT futile.
  it('reports canTransmit true when TX is off but UDP Broadcast relays', async () => {
    mockManager.getDeviceConfig.mockResolvedValue({ lora: { txEnabled: false } });
    mockManager.isUdpBroadcastRelayEnabled.mockReturnValue(true);
    const res = await request(app).get('/device/tx-status');
    expect(res.body.txEnabled).toBe(false);
    expect(res.body.udpRelayEnabled).toBe(true);
    expect(res.body.canTransmit).toBe(true);
  });
});

describe('GET /device/security-keys', () => {
  it('returns the security keys', async () => {
    mockManager.getSecurityKeys.mockReturnValue({ publicKey: 'pub', privateKey: 'priv' });
    const res = await request(app).get('/device/security-keys');
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe('pub');
  });
});
