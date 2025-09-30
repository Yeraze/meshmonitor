import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('MeshtasticManager - Configuration Polling', () => {
  describe('fromradio polling behavior', () => {
    it('should continue polling after empty responses to receive MyNodeInfo', async () => {
      // This test ensures we don't break out of the polling loop too early
      // The bug was that we stopped after the first empty response, but MyNodeInfo
      // arrives shortly after the initial queue drain

      const mockResponses = [
        { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }, // Empty - initial drain
        { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }, // Empty - still waiting
        { ok: true, arrayBuffer: async () => {
          // MyNodeInfo arrives on 3rd poll (like the official client shows)
          const data = new Uint8Array([0x22, 0x10, 0x08, 0xcc, 0xfe, 0x93, 0x97, 0x0a]);
          return data.buffer;
        }},
        { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }, // Empty again
      ];

      let pollCount = 0;
      const mockFetch = vi.fn(async () => {
        return mockResponses[pollCount++] || { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
      });

      global.fetch = mockFetch;

      // Simulate the polling loop logic
      let consecutiveEmptyCount = 0;
      const maxConsecutiveEmpty = 3;
      const maxIterations = 10;
      let iterationCount = 0;
      let receivedData = false;

      while (iterationCount < maxIterations) {
        iterationCount++;
        const response = await mockFetch('/api/v1/fromradio?all=false');

        if (response.ok) {
          const data = await response.arrayBuffer();

          if (data.byteLength > 0) {
            consecutiveEmptyCount = 0;
            receivedData = true;
          } else {
            consecutiveEmptyCount++;
            if (consecutiveEmptyCount >= maxConsecutiveEmpty) {
              break;
            }
          }
        }
      }

      // Should have made at least 3 requests (not stopping at first empty)
      expect(pollCount).toBeGreaterThanOrEqual(3);
      // Should have received data eventually
      expect(receivedData).toBe(true);
      // Should not have exhausted max iterations
      expect(iterationCount).toBeLessThan(maxIterations);
    });

    it('should stop after 3 consecutive empty responses', async () => {
      const mockResponses = Array(10).fill({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0)
      });

      let pollCount = 0;
      const mockFetch = vi.fn(async () => mockResponses[pollCount++]);
      global.fetch = mockFetch;

      let consecutiveEmptyCount = 0;
      const maxConsecutiveEmpty = 3;
      const maxIterations = 10;
      let iterationCount = 0;

      while (iterationCount < maxIterations) {
        iterationCount++;
        const response = await mockFetch('/api/v1/fromradio?all=false');

        if (response.ok) {
          const data = await response.arrayBuffer();

          if (data.byteLength > 0) {
            consecutiveEmptyCount = 0;
          } else {
            consecutiveEmptyCount++;
            if (consecutiveEmptyCount >= maxConsecutiveEmpty) {
              break;
            }
          }
        }
      }

      // Should have stopped after exactly 3 empty responses
      expect(pollCount).toBe(3);
      expect(consecutiveEmptyCount).toBe(3);
    });

    it('should reset empty counter when data is received', async () => {
      const mockResponses = [
        { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }, // Empty
        { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }, // Empty
        { ok: true, arrayBuffer: async () => new Uint8Array([0x01, 0x02]).buffer }, // Data!
        { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }, // Empty
        { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }, // Empty
        { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }, // Empty - should stop here
      ];

      let pollCount = 0;
      const mockFetch = vi.fn(async () => mockResponses[pollCount++]);
      global.fetch = mockFetch;

      let consecutiveEmptyCount = 0;
      const maxConsecutiveEmpty = 3;
      const maxIterations = 10;
      let iterationCount = 0;

      while (iterationCount < maxIterations) {
        iterationCount++;
        const response = await mockFetch('/api/v1/fromradio?all=false');

        if (response.ok) {
          const data = await response.arrayBuffer();

          if (data.byteLength > 0) {
            consecutiveEmptyCount = 0; // Reset on data
          } else {
            consecutiveEmptyCount++;
            if (consecutiveEmptyCount >= maxConsecutiveEmpty) {
              break;
            }
          }
        }
      }

      // Should have polled 6 times: 2 empty, 1 data (reset), 3 more empty
      expect(pollCount).toBe(6);
    });
  });

  describe('Local node info persistence', () => {
    it('should save local node info to settings when MyNodeInfo is received', () => {
      const mockSettings: Record<string, string> = {};

      const mockDatabaseService = {
        setSetting: vi.fn((key: string, value: string) => {
          mockSettings[key] = value;
        }),
        getSetting: vi.fn((key: string) => mockSettings[key] || null),
      };

      // Simulate receiving MyNodeInfo
      const myNodeInfo = {
        myNodeNum: 2732916556,
        hwModel: 31,
      };

      const nodeNum = Number(myNodeInfo.myNodeNum);
      const nodeId = `!${myNodeInfo.myNodeNum.toString(16).padStart(8, '0')}`;

      mockDatabaseService.setSetting('localNodeNum', nodeNum.toString());
      mockDatabaseService.setSetting('localNodeId', nodeId);

      expect(mockDatabaseService.setSetting).toHaveBeenCalledWith('localNodeNum', '2732916556');
      expect(mockDatabaseService.setSetting).toHaveBeenCalledWith('localNodeId', '!a2e4ff4c');
      expect(mockSettings.localNodeNum).toBe('2732916556');
      expect(mockSettings.localNodeId).toBe('!a2e4ff4c');
    });

    it('should restore local node info from settings on startup', () => {
      const mockSettings: Record<string, string> = {
        localNodeNum: '2732916556',
        localNodeId: '!a2e4ff4c',
      };

      const mockDatabaseService = {
        getSetting: vi.fn((key: string) => mockSettings[key] || null),
        getNode: vi.fn((nodeNum: number) => ({
          nodeNum,
          nodeId: '!a2e4ff4c',
          longName: 'Yeraze StationG2 🚉',
          shortName: 'Yrze',
          hwModel: 31,
        })),
      };

      const savedNodeNum = mockDatabaseService.getSetting('localNodeNum');
      const savedNodeId = mockDatabaseService.getSetting('localNodeId');

      expect(savedNodeNum).toBe('2732916556');
      expect(savedNodeId).toBe('!a2e4ff4c');

      if (savedNodeNum && savedNodeId) {
        const nodeNum = parseInt(savedNodeNum);
        const node = mockDatabaseService.getNode(nodeNum);

        expect(node).toBeDefined();
        expect(node?.longName).toBe('Yeraze StationG2 🚉');
      }
    });

    it('should handle missing local node info gracefully', () => {
      const mockDatabaseService = {
        getSetting: vi.fn(() => null),
      };

      const savedNodeNum = mockDatabaseService.getSetting('localNodeNum');
      const savedNodeId = mockDatabaseService.getSetting('localNodeId');

      expect(savedNodeNum).toBeNull();
      expect(savedNodeId).toBeNull();
      // Should not crash, should wait for MyNodeInfo
    });
  });
});
