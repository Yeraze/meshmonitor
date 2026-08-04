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

// #4547 Phase 1 WP5: a MeshCore sourceId is resolved via the registry +
// isMeshCoreManager directly (resolveSourceManager() is Meshtastic-only by
// design and would silently fall back to the wrong manager, see the
// doc comment on that helper and deviceStatusRoutes.ts).
const mockGetManager = vi.hoisted(() => vi.fn());
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: mockGetManager },
}));

import deviceStatusRoutes from './deviceStatusRoutes.js';

const app = express();
app.use(express.json());
app.use('/', deviceStatusRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetManager.mockReturnValue(null);
});

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

  // #4547 Phase 1 WP5: an explicit MeshCore ?sourceId= reports THAT source's
  // receive-only state, not the Meshtastic resolveSourceManager() fallback's.
  describe('MeshCore source (#4547)', () => {
    it('reports the receive-only source as unable to transmit', async () => {
      mockGetManager.mockReturnValue({
        sourceType: 'meshcore',
        canTransmit: () => false,
      });

      const res = await request(app).get('/device/tx-status?sourceId=meshcore-a');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ txEnabled: false, udpRelayEnabled: false, canTransmit: false });
      // The Meshtastic fallback path must not have been consulted.
      expect(mockManager.getDeviceConfig).not.toHaveBeenCalled();
    });

    it('reports a transmit-capable MeshCore source as canTransmit: true', async () => {
      mockGetManager.mockReturnValue({
        sourceType: 'meshcore',
        canTransmit: () => true,
      });

      const res = await request(app).get('/device/tx-status?sourceId=meshcore-b');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ txEnabled: true, udpRelayEnabled: false, canTransmit: true });
    });

    it('falls back to the Meshtastic resolveSourceManager() path when the sourceId is not a registered MeshCore manager', async () => {
      mockGetManager.mockReturnValue(null); // not registered as MeshCore
      mockManager.getDeviceConfig.mockResolvedValue({ lora: {} });

      const res = await request(app).get('/device/tx-status?sourceId=meshtastic-a');

      expect(res.status).toBe(200);
      expect(res.body.txEnabled).toBe(true);
      expect(mockManager.getDeviceConfig).toHaveBeenCalled();
    });
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
