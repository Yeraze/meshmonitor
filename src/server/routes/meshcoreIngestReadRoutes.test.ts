/**
 * MeshCore ingest read routes + the data/device guard split (#5096).
 *
 * Two behaviours are under test, and the first is the actual bug:
 *
 * 1. `/packets` must be reachable for a `meshcore_mqtt` source. The barrel
 *    mounted the packet routes behind `meshcoreRouteGuard`, which refuses
 *    ingest sources by design, so the ingest packet monitor built in #5040
 *    Phase 2b could never be reached by any request.
 * 2. Device routes must STILL refuse an ingest source. Opening the data routes
 *    must not open the device surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const managers = new Map<string, Record<string, unknown>>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => managers.get(id),
    getAllManagers: () => [...managers.values()],
  },
}));

// Packet log service — the /packets handler's only data dependency.
vi.mock('../services/meshcorePacketLogService.js', () => ({
  default: {
    getPackets: vi.fn().mockResolvedValue([]),
    getPacketCount: vi.fn().mockResolvedValue(0),
    getGroupedPackets: vi.fn().mockResolvedValue([]),
    getGroupedPacketCount: vi.fn().mockResolvedValue(0),
    isEnabled: vi.fn().mockResolvedValue(true),
    getMaxCount: vi.fn().mockResolvedValue(1000),
    getIngestMaxCount: vi.fn().mockResolvedValue(50000),
    getMaxAgeHours: vi.fn().mockResolvedValue(24),
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  optionalAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    sources: { getSource: vi.fn().mockResolvedValue({ id: 'ingest-1', type: 'meshcore_mqtt' }) },
    getSettingAsync: vi.fn().mockResolvedValue(null),
    meshcore: {},
  },
}));

const INGEST_NODE = { publicKey: 'c'.repeat(64), name: 'Observed', latitude: 1, longitude: 2, lastHeard: Date.now() };
const INGEST_MESSAGE = { id: 'm1', channelIdx: 0, text: 'hello region', timestamp: Date.now() };

function makeIngestManager(sourceId: string) {
  return {
    sourceId,
    sourceType: 'meshcore_mqtt',
    isConnected: () => true,
    getStatus: () => ({ connected: true, region: 'MCO', brokerUrl: 'wss://broker' }),
    getAllNodes: async () => [INGEST_NODE],
    getRecentMessagesAsync: async () => [INGEST_MESSAGE],
    getObserverStatuses: () =>
      new Map([
        ['d'.repeat(64), { online: true, at: 1000, batteryMv: 4100, uptimeSecs: 60, noiseFloor: -95 }],
        ['e'.repeat(64), { online: true, at: 5000, batteryMv: null, uptimeSecs: null, noiseFloor: null }],
      ]),
  };
}

function makeDeviceManager(sourceId: string) {
  return {
    sourceId,
    sourceType: 'meshcore',
    isConnected: () => true,
    getStatus: () => ({ connected: true }),
    getRecentMessages: () => [],
  };
}

let app: express.Express;

beforeEach(async () => {
  managers.clear();
  managers.set('ingest-1', makeIngestManager('ingest-1'));
  managers.set('device-1', makeDeviceManager('device-1'));
  managers.set('meshtastic-1', { sourceId: 'meshtastic-1', sourceType: 'meshtastic_tcp' });

  const { default: meshcoreRoutes } = await import('./meshcoreRoutes.js');
  app = express();
  app.use(express.json());
  app.use('/api/sources/:id/meshcore', meshcoreRoutes);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('data routes reach an ingest source (#5096)', () => {
  it('serves /packets for a meshcore_mqtt source', async () => {
    // THE BUG: this was a 404 from meshcoreRouteGuard, making the Phase 2b
    // ingest packet monitor unreachable by any request.
    const res = await request(app).get('/api/sources/ingest-1/meshcore/packets');
    expect(res.status).toBe(200);
  });

  it('still serves /packets for a device-backed source', async () => {
    const res = await request(app).get('/api/sources/device-1/meshcore/packets');
    expect(res.status).toBe(200);
  });

  it('404s /packets for a non-MeshCore source', async () => {
    // Moving the packet routes out from behind the device guard must not make
    // them answer for a Meshtastic source.
    const res = await request(app).get('/api/sources/meshtastic-1/meshcore/packets');
    expect(res.status).toBe(404);
  });
});

describe('device routes still refuse an ingest source (#5096)', () => {
  it('404s a device config route with the ingest-specific message', async () => {
    const res = await request(app).get('/api/sources/ingest-1/meshcore/config/radio');
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toContain('has no device');
  });

  it('404s the device contacts route', async () => {
    const res = await request(app).get('/api/sources/ingest-1/meshcore/contacts');
    expect(res.status).toBe(404);
  });
});

describe('GET /ingest/overview', () => {
  it('returns broker, region, node count and observers', async () => {
    const res = await request(app).get('/api/sources/ingest-1/meshcore/ingest/overview');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.connected).toBe(true);
    expect(res.body.data.nodeCount).toBe(1);
    expect(res.body.data.observers).toHaveLength(2);
  });

  it('sorts observers by most recent heartbeat', async () => {
    const res = await request(app).get('/api/sources/ingest-1/meshcore/ingest/overview');
    const [first, second] = res.body.data.observers;
    expect(first.lastSeenMs).toBe(5000);
    expect(second.lastSeenMs).toBe(1000);
  });

  it('passes the observer noise floor through as a number, not a string', async () => {
    const res = await request(app).get('/api/sources/ingest-1/meshcore/ingest/overview');
    const withStats = res.body.data.observers.find((o: { batteryMv: number | null }) => o.batteryMv !== null);
    expect(withStats.noiseFloor).toBe(-95);
  });

  it('nulls absent stats rather than omitting the fields', async () => {
    // The table renders a dash for null; an absent key would render undefined.
    const res = await request(app).get('/api/sources/ingest-1/meshcore/ingest/overview');
    const bare = res.body.data.observers.find((o: { lastSeenMs: number }) => o.lastSeenMs === 5000);
    expect(bare).toHaveProperty('noiseFloor');
    expect(bare.noiseFloor).toBeNull();
  });

  it('refuses a device-backed source', async () => {
    const res = await request(app).get('/api/sources/device-1/meshcore/ingest/overview');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_AN_INGEST_SOURCE');
  });
});

describe('GET /ingest/nodes and /ingest/messages', () => {
  it('returns adverts-discovered nodes', async () => {
    const res = await request(app).get('/api/sources/ingest-1/meshcore/ingest/nodes');
    expect(res.status).toBe(200);
    expect(res.body.data.nodes).toHaveLength(1);
    expect(res.body.data.nodes[0].name).toBe('Observed');
  });

  it('returns decrypted channel messages', async () => {
    const res = await request(app).get('/api/sources/ingest-1/meshcore/ingest/messages');
    expect(res.status).toBe(200);
    expect(res.body.data.messages[0].text).toBe('hello region');
  });

  it('clamps an oversized limit rather than passing it through', async () => {
    const mgr = managers.get('ingest-1') as { getRecentMessagesAsync: (n: number) => Promise<unknown[]> };
    const spy = vi.fn().mockResolvedValue([]);
    mgr.getRecentMessagesAsync = spy;

    await request(app).get('/api/sources/ingest-1/meshcore/ingest/messages?limit=99999');
    expect(spy).toHaveBeenCalledWith(500);
  });

  it('falls back to the default limit for junk input', async () => {
    const mgr = managers.get('ingest-1') as { getRecentMessagesAsync: (n: number) => Promise<unknown[]> };
    const spy = vi.fn().mockResolvedValue([]);
    mgr.getRecentMessagesAsync = spy;

    await request(app).get('/api/sources/ingest-1/meshcore/ingest/messages?limit=abc');
    expect(spy).toHaveBeenCalledWith(100);
  });

  it('refuses a device-backed source on both routes', async () => {
    expect((await request(app).get('/api/sources/device-1/meshcore/ingest/nodes')).status).toBe(404);
    expect((await request(app).get('/api/sources/device-1/meshcore/ingest/messages')).status).toBe(404);
  });
});
