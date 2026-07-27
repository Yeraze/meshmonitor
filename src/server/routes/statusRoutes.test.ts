import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockManager = vi.hoisted(() => ({
  getAirtimeCutoffStatus: vi.fn(),
}));

const mockRegistry = vi.hoisted(() => ({
  getAllManagers: vi.fn(),
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn().mockReturnValue(mockManager),
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockRegistry,
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requireAuth: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
  requirePermission: () => (req: any, _res: any, next: any) => { req.user = { id: 1, isAdmin: true }; next(); },
}));

import statusRoutes from './statusRoutes.js';

const app = express();
app.use(express.json());
app.use('/', statusRoutes);

beforeEach(() => vi.clearAllMocks());

describe('GET /virtual-node/status', () => {
  it('reports disabled sources with no virtualNodeServer', async () => {
    mockRegistry.getAllManagers.mockReturnValue([
      { sourceId: 's1', getStatus: () => ({ sourceId: 's1', sourceName: 'One' }), virtualNodeServer: null },
    ]);
    const res = await request(app).get('/virtual-node/status');
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0].enabled).toBe(false);
  });

  it('reports running virtual node details', async () => {
    mockRegistry.getAllManagers.mockReturnValue([
      {
        sourceId: 's1',
        getStatus: () => ({ sourceId: 's1', sourceName: 'One' }),
        virtualNodeServer: {
          isRunning: () => true,
          isAdminCommandsAllowed: () => true,
          getClientCount: () => 2,
          getClientDetails: () => [{ id: 'c1' }],
        },
      },
    ]);
    const res = await request(app).get('/virtual-node/status');
    expect(res.body.sources[0].enabled).toBe(true);
    expect(res.body.sources[0].isRunning).toBe(true);
    expect(res.body.sources[0].clientCount).toBe(2);
  });

  // `getAllManagers()` mixes VN implementations, so every method this handler
  // calls has to be treated as optional. A MeshCore VN without
  // `getClientDetails` used to throw here and the catch turned it into a 500 —
  // taking down the status of every *other* source with it.
  it('degrades to an empty client list when a VN lacks getClientDetails', async () => {
    mockRegistry.getAllManagers.mockReturnValue([
      {
        sourceId: 's1',
        getStatus: () => ({ sourceId: 's1', sourceName: 'One' }),
        virtualNodeServer: {
          isRunning: () => true,
          isAdminCommandsAllowed: () => false,
          getClientCount: () => 1,
        },
      },
    ]);
    const res = await request(app).get('/virtual-node/status');
    expect(res.status).toBe(200);
    expect(res.body.sources[0].clientCount).toBe(1);
    expect(res.body.sources[0].clients).toEqual([]);
  });

  // allowPkiExport is MeshCore-only. Meshtastic VNs have no key-export command,
  // so they must report `undefined` (field omitted) — the Info tab keys off that
  // to hide the row entirely rather than show a permanently-"Blocked" toggle.
  it('reports allowPkiExport for a MeshCore VN and omits it for a Meshtastic VN', async () => {
    mockRegistry.getAllManagers.mockReturnValue([
      {
        sourceId: 'mc-on',
        getStatus: () => ({ sourceId: 'mc-on', sourceName: 'MeshCore on' }),
        virtualNodeServer: {
          isRunning: () => true,
          isAdminCommandsAllowed: () => false,
          isPkiExportAllowed: () => true,
          getClientCount: () => 0,
          getClientDetails: () => [],
        },
      },
      {
        sourceId: 'mc-off',
        getStatus: () => ({ sourceId: 'mc-off', sourceName: 'MeshCore off' }),
        virtualNodeServer: {
          isRunning: () => true,
          isAdminCommandsAllowed: () => true,
          isPkiExportAllowed: () => false,
          getClientCount: () => 0,
          getClientDetails: () => [],
        },
      },
      {
        sourceId: 'mt',
        getStatus: () => ({ sourceId: 'mt', sourceName: 'Meshtastic' }),
        virtualNodeServer: {
          isRunning: () => true,
          isAdminCommandsAllowed: () => true,
          getClientCount: () => 0,
          getClientDetails: () => [],
        },
      },
    ]);
    const res = await request(app).get('/virtual-node/status');
    expect(res.status).toBe(200);
    const [mcOn, mcOff, mt] = res.body.sources;
    expect(mcOn.allowPkiExport).toBe(true);
    expect(mcOff.allowPkiExport).toBe(false);
    // JSON drops undefined, so the key is absent for Meshtastic VNs.
    expect(mt).not.toHaveProperty('allowPkiExport');
    // The PKI gate must not bleed into the admin gate.
    expect(mcOn.allowAdminCommands).toBe(false);
    expect(mcOff.allowAdminCommands).toBe(true);
  });
});

describe('GET /automation/airtime-status', () => {
  it('returns the airtime cutoff status', async () => {
    mockManager.getAirtimeCutoffStatus.mockResolvedValue({ paused: false, utilization: 12.5 });
    const res = await request(app).get('/automation/airtime-status');
    expect(res.status).toBe(200);
    expect(res.body.utilization).toBe(12.5);
  });
});
