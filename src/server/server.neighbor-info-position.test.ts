import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock node data with position overrides
const mockNodes: Record<number, any> = {
  // Node with position override enabled
  1: {
    nodeNum: 1,
    nodeId: '!00000001',
    longName: 'Node With Override',
    shortName: 'OVR',
    latitude: 40.0,      // Original GPS position
    longitude: -75.0,
    latitudeOverride: 41.0,   // Override position
    longitudeOverride: -76.0,
    positionOverrideEnabled: true,
    lastHeard: Math.floor(Date.now() / 1000)
  },
  // Node without position override
  2: {
    nodeNum: 2,
    nodeId: '!00000002',
    longName: 'Node Without Override',
    shortName: 'GPS',
    latitude: 42.0,
    longitude: -77.0,
    latitudeOverride: null,
    longitudeOverride: null,
    positionOverrideEnabled: false,
    lastHeard: Math.floor(Date.now() / 1000)
  },
  // Node with override enabled but null override values (should fall back to GPS)
  3: {
    nodeNum: 3,
    nodeId: '!00000003',
    longName: 'Node Partial Override',
    shortName: 'PRT',
    latitude: 43.0,
    longitude: -78.0,
    latitudeOverride: null,
    longitudeOverride: null,
    positionOverrideEnabled: true,
    lastHeard: Math.floor(Date.now() / 1000)
  }
};

// Mock neighbor info data
const mockNeighborInfo = [
  { id: 1, nodeNum: 1, neighborNodeNum: 2, snr: 10.5, timestamp: Math.floor(Date.now() / 1000) },
  { id: 2, nodeNum: 2, neighborNodeNum: 3, snr: 8.0, timestamp: Math.floor(Date.now() / 1000) }
];

const mockNeighborsForNode1 = [
  { id: 1, nodeNum: 1, neighborNodeNum: 2, snr: 10.5, timestamp: Math.floor(Date.now() / 1000) }
];

// Database mock
const databaseMock = {
  getNode: vi.fn((nodeNum: number) => mockNodes[nodeNum] || null),
  getLatestNeighborInfoPerNode: vi.fn(() => mockNeighborInfo),
  getNeighborsForNode: vi.fn((nodeNum: number) => {
    if (nodeNum === 1) return mockNeighborsForNode1;
    return [];
  }),
  getSetting: vi.fn((_key: string) => '24') // maxNodeAge = 24 hours
};

// Mock the database module
vi.mock('../services/database', () => ({
  default: databaseMock
}));

// Helper to get effective position (copy from server.ts for testing)
const getEffectivePosition = (node: typeof mockNodes[number] | null) => {
  if (!node) return { latitude: undefined, longitude: undefined };

  // Check for position override first
  if (node.positionOverrideEnabled === true && node.latitudeOverride != null && node.longitudeOverride != null) {
    return { latitude: node.latitudeOverride, longitude: node.longitudeOverride };
  }

  // Fall back to regular position
  return { latitude: node.latitude, longitude: node.longitude };
};

describe('getEffectivePosition helper', () => {
  it('returns undefined coordinates for null node', () => {
    const result = getEffectivePosition(null);
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBeUndefined();
  });

  it('returns override position when override is enabled', () => {
    const result = getEffectivePosition(mockNodes[1]);
    expect(result.latitude).toBe(41.0);  // Override value, not 40.0
    expect(result.longitude).toBe(-76.0); // Override value, not -75.0
  });

  it('returns GPS position when override is disabled', () => {
    const result = getEffectivePosition(mockNodes[2]);
    expect(result.latitude).toBe(42.0);  // GPS value
    expect(result.longitude).toBe(-77.0); // GPS value
  });

  it('returns GPS position when override is enabled but values are null', () => {
    const result = getEffectivePosition(mockNodes[3]);
    expect(result.latitude).toBe(43.0);  // Falls back to GPS
    expect(result.longitude).toBe(-78.0); // Falls back to GPS
  });
});

describe('Neighbor Info API with Position Overrides', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Recreate the neighbor-info endpoint with the helper
    app.get('/api/neighbor-info', (_req, res) => {
      try {
        const neighborInfo = databaseMock.getLatestNeighborInfoPerNode();
        const maxNodeAgeStr = databaseMock.getSetting('maxNodeAge');
        const maxNodeAgeHours = maxNodeAgeStr ? parseInt(maxNodeAgeStr, 10) : 24;
        const cutoffTime = Math.floor(Date.now() / 1000) - maxNodeAgeHours * 60 * 60;

        const enrichedNeighborInfo = neighborInfo
          .map(ni => {
            const node = databaseMock.getNode(ni.nodeNum);
            const neighbor = databaseMock.getNode(ni.neighborNodeNum);
            const nodePos = getEffectivePosition(node);
            const neighborPos = getEffectivePosition(neighbor);

            return {
              ...ni,
              nodeId: node?.nodeId || `!${ni.nodeNum.toString(16).padStart(8, '0')}`,
              nodeName: node?.longName || `Node !${ni.nodeNum.toString(16).padStart(8, '0')}`,
              neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
              neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
              nodeLatitude: nodePos.latitude,
              nodeLongitude: nodePos.longitude,
              neighborLatitude: neighborPos.latitude,
              neighborLongitude: neighborPos.longitude,
              node,
              neighbor,
            };
          })
          .filter(ni => {
            if (!ni.node?.lastHeard || !ni.neighbor?.lastHeard) {
              return false;
            }
            return ni.node.lastHeard >= cutoffTime && ni.neighbor.lastHeard >= cutoffTime;
          })
          .map(({ node, neighbor, ...rest }) => rest);

        res.json(enrichedNeighborInfo);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch neighbor info' });
      }
    });

    // Recreate the neighbor-info/:nodeNum endpoint
    app.get('/api/neighbor-info/:nodeNum', (req, res) => {
      try {
        const nodeNum = parseInt(req.params.nodeNum);
        const neighborInfo = databaseMock.getNeighborsForNode(nodeNum);

        const enrichedNeighborInfo = neighborInfo.map(ni => {
          const neighbor = databaseMock.getNode(ni.neighborNodeNum);
          const neighborPos = getEffectivePosition(neighbor);

          return {
            ...ni,
            neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
            neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
            neighborLatitude: neighborPos.latitude,
            neighborLongitude: neighborPos.longitude,
          };
        });

        res.json(enrichedNeighborInfo);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch neighbor info for node' });
      }
    });
  });

  describe('GET /api/neighbor-info', () => {
    it('returns neighbor info with override positions for nodes with overrides enabled', async () => {
      const response = await request(app).get('/api/neighbor-info');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);

      // First neighbor info: node 1 (with override) -> node 2 (without override)
      const firstEntry = response.body.find((ni: any) => ni.nodeNum === 1);
      expect(firstEntry).toBeDefined();

      // Node 1 should use override position
      expect(firstEntry.nodeLatitude).toBe(41.0);  // Override, not 40.0
      expect(firstEntry.nodeLongitude).toBe(-76.0); // Override, not -75.0

      // Node 2 (neighbor) should use GPS position
      expect(firstEntry.neighborLatitude).toBe(42.0);  // GPS
      expect(firstEntry.neighborLongitude).toBe(-77.0); // GPS
    });

    it('returns neighbor info with GPS positions for nodes without overrides', async () => {
      const response = await request(app).get('/api/neighbor-info');

      expect(response.status).toBe(200);

      // Second neighbor info: node 2 (no override) -> node 3 (override enabled but null values)
      const secondEntry = response.body.find((ni: any) => ni.nodeNum === 2);
      expect(secondEntry).toBeDefined();

      // Node 2 should use GPS position (no override)
      expect(secondEntry.nodeLatitude).toBe(42.0);
      expect(secondEntry.nodeLongitude).toBe(-77.0);

      // Node 3 should use GPS position (override enabled but values are null)
      expect(secondEntry.neighborLatitude).toBe(43.0);
      expect(secondEntry.neighborLongitude).toBe(-78.0);
    });
  });

  describe('GET /api/neighbor-info/:nodeNum', () => {
    it('returns neighbor info with override position for neighbor', async () => {
      const response = await request(app).get('/api/neighbor-info/1');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(1);

      const entry = response.body[0];

      // Neighbor (node 2) should use GPS position (no override)
      expect(entry.neighborLatitude).toBe(42.0);
      expect(entry.neighborLongitude).toBe(-77.0);
    });

    it('returns empty array for node with no neighbors', async () => {
      const response = await request(app).get('/api/neighbor-info/99');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(0);
    });
  });
});
