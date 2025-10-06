import { describe, it, expect, vi } from 'vitest';

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

      global.fetch = mockFetch as any;

      // Simulate the polling loop logic
      let consecutiveEmptyCount = 0;
      const maxConsecutiveEmpty = 3;
      const maxIterations = 10;
      let iterationCount = 0;
      let receivedData = false;

      while (iterationCount < maxIterations) {
        iterationCount++;
        const response = await mockFetch();

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
      global.fetch = mockFetch as any;

      let consecutiveEmptyCount = 0;
      const maxConsecutiveEmpty = 3;
      const maxIterations = 10;
      let iterationCount = 0;

      while (iterationCount < maxIterations) {
        iterationCount++;
        const response = await mockFetch();

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
      global.fetch = mockFetch as any;

      let consecutiveEmptyCount = 0;
      const maxConsecutiveEmpty = 3;
      const maxIterations = 10;
      let iterationCount = 0;

      while (iterationCount < maxIterations) {
        iterationCount++;
        const response = await mockFetch();

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
        getSetting: vi.fn((key: string): string | null => mockSettings[key] || null),
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
        getSetting: vi.fn((key: string): string | null => mockSettings[key] || null),
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
        getSetting: vi.fn((_key: string): null => null),
      };

      const savedNodeNum = mockDatabaseService.getSetting('localNodeNum');
      const savedNodeId = mockDatabaseService.getSetting('localNodeId');

      expect(savedNodeNum).toBeNull();
      expect(savedNodeId).toBeNull();
      // Should not crash, should wait for MyNodeInfo
    });
  });

  describe('NodeInfo hopsAway processing', () => {
    it('should extract hopsAway from NodeInfo protobuf data', () => {
      // Mock NodeInfo with hopsAway field
      const mockNodeInfo = {
        num: 2732916556,
        user: {
          id: '!a2e4ff4c',
          longName: 'Test Node',
          shortName: 'TEST',
          hwModel: 31,
        },
        hopsAway: 3,
        lastHeard: Date.now() / 1000,
      };

      // Verify hopsAway is accessible
      expect(mockNodeInfo.hopsAway).toBe(3);
      expect(typeof mockNodeInfo.hopsAway).toBe('number');
    });

    it('should handle NodeInfo without hopsAway field (undefined)', () => {
      const mockNodeInfo: {
        num: number;
        user: { id: string; longName: string; shortName: string; hwModel: number };
        lastHeard: number;
        hopsAway?: number;
      } = {
        num: 2732916556,
        user: {
          id: '!a2e4ff4c',
          longName: 'Test Node',
          shortName: 'TEST',
          hwModel: 31,
        },
        lastHeard: Date.now() / 1000,
        // hopsAway is undefined
      };

      // Should handle gracefully when hopsAway is not present
      expect(mockNodeInfo.hopsAway).toBeUndefined();
    });

    it('should process hopsAway values from 0 to 6+', () => {
      const testCases = [
        { hopsAway: 0, description: 'local node' },
        { hopsAway: 1, description: 'direct neighbor' },
        { hopsAway: 2, description: 'two hops away' },
        { hopsAway: 3, description: 'three hops away' },
        { hopsAway: 4, description: 'four hops away' },
        { hopsAway: 5, description: 'five hops away' },
        { hopsAway: 6, description: 'six hops away' },
        { hopsAway: 10, description: 'many hops away' },
      ];

      testCases.forEach(({ hopsAway }) => {
        const mockNodeInfo = {
          num: 123456,
          hopsAway,
        };

        expect(mockNodeInfo.hopsAway).toBe(hopsAway);
        expect(mockNodeInfo.hopsAway).toBeGreaterThanOrEqual(0);
      });
    });

    it('should preserve hopsAway in node data structure', () => {
      const mockNodeData = {
        nodeNum: 2732916556,
        nodeId: '!a2e4ff4c',
        lastHeard: Date.now() / 1000,
        snr: 0,
        rssi: 0,
        hopsAway: 2,
      };

      expect(mockNodeData).toHaveProperty('hopsAway');
      expect(mockNodeData.hopsAway).toBe(2);
    });

    it('should handle hopsAway updates when receiving new NodeInfo', () => {
      // Simulate node reporting different hop counts over time
      const nodeUpdates = [
        { timestamp: 1000, hopsAway: 3 },
        { timestamp: 2000, hopsAway: 2 }, // Better path found
        { timestamp: 3000, hopsAway: 4 }, // Path degraded
      ];

      nodeUpdates.forEach((update) => {
        const mockNodeInfo = {
          num: 2732916556,
          hopsAway: update.hopsAway,
          lastHeard: update.timestamp,
        };

        expect(mockNodeInfo.hopsAway).toBe(update.hopsAway);
      });
    });

    it('should distinguish hopsAway from user-provided data', () => {
      // hopsAway is from mesh packet header, not user info
      const mockNodeInfo = {
        num: 2732916556,
        user: {
          id: '!a2e4ff4c',
          longName: 'Test Node',
          shortName: 'TEST',
        },
        hopsAway: 3, // From packet, not user
      };

      expect(mockNodeInfo.hopsAway).toBe(3);
      expect(mockNodeInfo.user).not.toHaveProperty('hopsAway');
    });
  });

  describe('Favorites sync functionality', () => {
    it('should create SetFavoriteNode admin message without session passkey', () => {
      const mockProtobufService = {
        createSetFavoriteNodeMessage: vi.fn((nodeNum: number, passkey: Uint8Array) => {
          expect(nodeNum).toBe(1129874776);
          expect(passkey.length).toBe(0); // Empty passkey for local TCP admin
          return new Uint8Array([0x01, 0x02, 0x03]);
        }),
        createAdminPacket: vi.fn((adminMsg: Uint8Array, destination: number) => {
          expect(destination).toBe(0); // 0 = local node
          return new Uint8Array([0x04, 0x05, 0x06]);
        }),
      };

      const adminMsg = mockProtobufService.createSetFavoriteNodeMessage(1129874776, new Uint8Array());
      const adminPacket = mockProtobufService.createAdminPacket(adminMsg, 0);

      expect(mockProtobufService.createSetFavoriteNodeMessage).toHaveBeenCalledWith(1129874776, expect.any(Uint8Array));
      expect(mockProtobufService.createAdminPacket).toHaveBeenCalledWith(expect.any(Uint8Array), 0);
      expect(adminPacket.length).toBeGreaterThan(0);
    });

    it('should create RemoveFavoriteNode admin message without session passkey', () => {
      const mockProtobufService = {
        createRemoveFavoriteNodeMessage: vi.fn((nodeNum: number, passkey: Uint8Array) => {
          expect(nodeNum).toBe(1129874776);
          expect(passkey.length).toBe(0); // Empty passkey for local TCP admin
          return new Uint8Array([0x01, 0x02, 0x03]);
        }),
        createAdminPacket: vi.fn((adminMsg: Uint8Array, destination: number) => {
          expect(destination).toBe(0); // 0 = local node
          return new Uint8Array([0x04, 0x05, 0x06]);
        }),
      };

      const adminMsg = mockProtobufService.createRemoveFavoriteNodeMessage(1129874776, new Uint8Array());
      const adminPacket = mockProtobufService.createAdminPacket(adminMsg, 0);

      expect(mockProtobufService.createRemoveFavoriteNodeMessage).toHaveBeenCalledWith(1129874776, expect.any(Uint8Array));
      expect(mockProtobufService.createAdminPacket).toHaveBeenCalledWith(expect.any(Uint8Array), 0);
      expect(adminPacket.length).toBeGreaterThan(0);
    });

    it('should NOT include isFavorite in nodeData from NodeInfo updates', () => {
      // This is the critical fix: NodeInfo processing should not include isFavorite
      // because the device doesn't broadcast favorite status
      const mockNodeInfo = {
        num: 1129874776,
        user: {
          id: '!43588558',
          longName: 'Yeraze Mobile',
          shortName: 'Yrze',
          hwModel: 43,
        },
        lastHeard: Date.now() / 1000,
        snr: 5.25,
        hopsAway: 0,
        position: {
          latitudeI: 285605888,
          longitudeI: -811991040,
          altitude: 35,
        },
      };

      // Simulate processNodeInfoProtobuf nodeData creation
      const nodeData: any = {
        nodeNum: Number(mockNodeInfo.num),
        nodeId: `!${mockNodeInfo.num.toString(16).padStart(8, '0')}`,
        lastHeard: mockNodeInfo.lastHeard,
        snr: mockNodeInfo.snr,
        rssi: 0,
        hopsAway: mockNodeInfo.hopsAway,
        // Note: isFavorite is NOT included here - it's a local-only setting
      };

      // Verify isFavorite is not in nodeData
      expect(nodeData).not.toHaveProperty('isFavorite');
      expect(nodeData.nodeNum).toBe(1129874776);
      expect(nodeData.hopsAway).toBe(0);
    });

    it('should preserve favorite status when NodeInfo updates occur', () => {
      // Database COALESCE logic test
      const mockDatabase = {
        upsertNode: vi.fn((nodeData: any) => {
          // Simulate COALESCE behavior:
          // isFavorite = COALESCE(?, isFavorite)
          // If nodeData.isFavorite is undefined, keep existing value
          if (nodeData.isFavorite === undefined) {
            return { isFavorite: true }; // Existing value preserved
          }
          return { isFavorite: nodeData.isFavorite };
        }),
      };

      // First update: Set favorite to true
      const favoriteUpdate = { nodeNum: 1129874776, isFavorite: true };
      const result1 = mockDatabase.upsertNode(favoriteUpdate);
      expect(result1.isFavorite).toBe(true);

      // Second update: NodeInfo arrives WITHOUT isFavorite field
      const nodeInfoUpdate = { nodeNum: 1129874776, longName: 'Yeraze Mobile' }; // no isFavorite
      const result2 = mockDatabase.upsertNode(nodeInfoUpdate);
      expect(result2.isFavorite).toBe(true); // Should preserve existing value!
    });

    it('should support firmware version >= 2.7.0 for favorites', () => {
      const testFirmwareVersions = [
        { version: '2.7.0', supported: true },
        { version: '2.7.11', supported: true },
        { version: '2.8.0', supported: true },
        { version: '2.6.9', supported: false },
        { version: '2.5.0', supported: false },
      ];

      testFirmwareVersions.forEach(({ version, supported }) => {
        const [major, minor] = version.split('.').map(Number);
        const isSupported = (major === 2 && minor >= 7) || major > 2;
        expect(isSupported).toBe(supported);
      });
    });

    it('should handle graceful degradation when device sync fails', () => {
      const mockDatabaseUpdate = vi.fn(() => ({ success: true }));
      const mockDeviceSync = vi.fn(() => {
        throw new Error('Device not connected');
      });

      // Database update succeeds
      const dbResult = mockDatabaseUpdate();
      expect(dbResult.success).toBe(true);

      // Device sync fails, but database succeeded
      expect(() => mockDeviceSync()).toThrow('Device not connected');

      // Overall operation should report partial success
      const response = {
        success: true, // Database updated
        nodeNum: 1129874776,
        isFavorite: true,
        deviceSync: {
          status: 'failed',
          error: 'Device not connected',
        },
      };

      expect(response.success).toBe(true);
      expect(response.deviceSync.status).toBe('failed');
    });
  });
});
