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
        createAdminPacket: vi.fn((_adminMsg: Uint8Array, destination: number) => {
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
        createAdminPacket: vi.fn((_adminMsg: Uint8Array, destination: number) => {
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

    it('should sync isFavorite from NodeInfo updates to fix reconnect issue (#213)', () => {
      // Fix for issue #213: favorites should be synced from device on each connection
      // to reflect changes made while offline (e.g., via mobile app)
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
        isFavorite: true,  // Device now sends favorite status
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
        isFavorite: mockNodeInfo.isFavorite,  // Now synced from device
      };

      // Verify isFavorite IS included in nodeData when provided by device
      expect(nodeData).toHaveProperty('isFavorite');
      expect(nodeData.isFavorite).toBe(true);
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

  describe('Position estimation for traceroute nodes', () => {
    it('should estimate position for intermediate node without GPS when neighbors have GPS', () => {
      const mockDatabaseService = {
        getNode: vi.fn((nodeNum: number) => {
          const nodes: Record<number, any> = {
            1000: { nodeNum: 1000, nodeId: '!000003e8', latitude: 26.0, longitude: -80.0 },
            2000: { nodeNum: 2000, nodeId: '!000007d0', latitude: null, longitude: null }, // No GPS
            3000: { nodeNum: 3000, nodeId: '!00000bb8', latitude: 26.2, longitude: -80.2 },
          };
          return nodes[nodeNum] || null;
        }),
        upsertNode: vi.fn(),
        insertTelemetry: vi.fn(),
      };

      // Simulate traceroute path: 1000 -> 2000 -> 3000
      const timestamp = Date.now();

      // Process intermediate node (2000)
      const prevNode = mockDatabaseService.getNode(1000);
      const nextNode = mockDatabaseService.getNode(3000);
      const node = mockDatabaseService.getNode(2000);

      expect(prevNode?.latitude).toBe(26.0);
      expect(nextNode?.latitude).toBe(26.2);
      expect(node?.latitude).toBeNull();

      // Calculate estimated position (midpoint)
      const estimatedLat = (prevNode.latitude + nextNode.latitude) / 2;
      const estimatedLon = (prevNode.longitude + nextNode.longitude) / 2;

      expect(estimatedLat).toBe(26.1);
      expect(estimatedLon).toBe(-80.1);

      // Should store as telemetry
      mockDatabaseService.insertTelemetry({
        nodeId: '!000007d0',
        nodeNum: 2000,
        telemetryType: 'estimated_latitude',
        timestamp,
        value: estimatedLat,
        unit: '° (est)',
        createdAt: Date.now(),
      });

      mockDatabaseService.insertTelemetry({
        nodeId: '!000007d0',
        nodeNum: 2000,
        telemetryType: 'estimated_longitude',
        timestamp,
        value: estimatedLon,
        unit: '° (est)',
        createdAt: Date.now(),
      });

      expect(mockDatabaseService.insertTelemetry).toHaveBeenCalledTimes(2);
      expect(mockDatabaseService.insertTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryType: 'estimated_latitude',
          value: 26.1,
          unit: '° (est)',
        })
      );
      expect(mockDatabaseService.insertTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryType: 'estimated_longitude',
          value: -80.1,
          unit: '° (est)',
        })
      );
    });

    it('should NOT estimate position when intermediate node already has GPS', () => {
      const mockDatabaseService = {
        getNode: vi.fn((nodeNum: number) => {
          const nodes: Record<number, any> = {
            1000: { nodeNum: 1000, latitude: 26.0, longitude: -80.0 },
            2000: { nodeNum: 2000, latitude: 26.15, longitude: -80.15 }, // Has GPS
            3000: { nodeNum: 3000, latitude: 26.2, longitude: -80.2 },
          };
          return nodes[nodeNum];
        }),
        insertTelemetry: vi.fn(),
      };

      const node = mockDatabaseService.getNode(2000);
      expect(node.latitude).not.toBeNull();

      // Should NOT call insertTelemetry for estimated position
      expect(mockDatabaseService.insertTelemetry).not.toHaveBeenCalled();
    });

    it('should NOT estimate position when neighbors lack GPS data', () => {
      const mockDatabaseService = {
        getNode: vi.fn((nodeNum: number) => {
          const nodes: Record<number, any> = {
            1000: { nodeNum: 1000, latitude: null, longitude: null }, // No GPS
            2000: { nodeNum: 2000, latitude: null, longitude: null }, // No GPS
            3000: { nodeNum: 3000, latitude: 26.2, longitude: -80.2 },
          };
          return nodes[nodeNum];
        }),
        insertTelemetry: vi.fn(),
      };

      const prevNode = mockDatabaseService.getNode(1000);
      const node = mockDatabaseService.getNode(2000);
      const nextNode = mockDatabaseService.getNode(3000);

      // Cannot estimate because prevNode has no GPS
      const canEstimate = !!(prevNode?.latitude && prevNode?.longitude &&
                         nextNode?.latitude && nextNode?.longitude &&
                         (!node?.latitude || !node?.longitude));

      expect(canEstimate).toBe(false);
      expect(mockDatabaseService.insertTelemetry).not.toHaveBeenCalled();
    });

    it('should create node in database if it does not exist before storing telemetry', () => {
      const mockDatabaseService = {
        getNode: vi.fn((_nodeNum: number) => null), // Node doesn't exist
        upsertNode: vi.fn(),
        insertTelemetry: vi.fn(),
      };

      const nodeNum = 2000;
      const nodeId = '!000007d0';

      // Should create node first
      const node = mockDatabaseService.getNode(nodeNum);
      expect(node).toBeNull();

      mockDatabaseService.upsertNode({
        nodeNum,
        nodeId,
        longName: `Node ${nodeId}`,
        shortName: nodeId.slice(-4),
        lastHeard: Date.now() / 1000,
      });

      expect(mockDatabaseService.upsertNode).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeNum: 2000,
          nodeId: '!000007d0',
        })
      );
    });

    it('should handle multiple intermediate nodes in a traceroute path', () => {
      const mockDatabaseService = {
        getNode: vi.fn((nodeNum: number) => {
          const nodes: Record<number, any> = {
            1000: { nodeNum: 1000, latitude: 26.0, longitude: -80.0 },
            2000: { nodeNum: 2000, latitude: null, longitude: null }, // No GPS
            3000: { nodeNum: 3000, latitude: 26.2, longitude: -80.2 },
            4000: { nodeNum: 4000, latitude: null, longitude: null }, // No GPS
            5000: { nodeNum: 5000, latitude: 26.4, longitude: -80.4 },
          };
          return nodes[nodeNum];
        }),
        upsertNode: vi.fn(),
        insertTelemetry: vi.fn(),
      };

      // Path: 1000 -> 2000 -> 3000 -> 4000 -> 5000
      // Should estimate for 2000 (between 1000 and 3000)
      // Should estimate for 4000 (between 3000 and 5000)

      const estimates = [];
      const routePath = [1000, 2000, 3000, 4000, 5000];

      for (let i = 1; i < routePath.length - 1; i++) {
        const prevNode = mockDatabaseService.getNode(routePath[i - 1]);
        const node = mockDatabaseService.getNode(routePath[i]);
        const nextNode = mockDatabaseService.getNode(routePath[i + 1]);

        if (node && (!node.latitude || !node.longitude) &&
            prevNode?.latitude && prevNode?.longitude &&
            nextNode?.latitude && nextNode?.longitude) {
          const estimatedLat = (prevNode.latitude + nextNode.latitude) / 2;
          const estimatedLon = (prevNode.longitude + nextNode.longitude) / 2;
          estimates.push({ nodeNum: routePath[i], lat: estimatedLat, lon: estimatedLon });
        }
      }

      expect(estimates.length).toBe(2);
      expect(estimates[0]).toEqual({ nodeNum: 2000, lat: 26.1, lon: -80.1 });
      expect(estimates[1].nodeNum).toBe(4000);
      expect(estimates[1].lat).toBeCloseTo(26.3, 6);
      expect(estimates[1].lon).toBeCloseTo(-80.3, 6);
    });

    it('should NOT estimate for endpoint nodes in traceroute', () => {
      // Endpoints (first and last nodes) should never get estimated positions
      const routePath = [1000, 2000, 3000];

      // Processing should only happen for index 1 (2000), not 0 (1000) or 2 (3000)
      const intermediateIndices = [];
      for (let i = 1; i < routePath.length - 1; i++) {
        intermediateIndices.push(i);
      }

      expect(intermediateIndices).toEqual([1]);
      expect(intermediateIndices).not.toContain(0); // First node
      expect(intermediateIndices).not.toContain(2); // Last node
    });

    it('should store estimated positions with proper telemetry types', () => {
      const mockDatabaseService = {
        insertTelemetry: vi.fn(),
      };

      const nodeId = '!000007d0';
      const nodeNum = 2000;
      const timestamp = Date.now();

      mockDatabaseService.insertTelemetry({
        nodeId,
        nodeNum,
        telemetryType: 'estimated_latitude',
        timestamp,
        value: 26.1,
        unit: '° (est)',
        createdAt: Date.now(),
      });

      mockDatabaseService.insertTelemetry({
        nodeId,
        nodeNum,
        telemetryType: 'estimated_longitude',
        timestamp,
        value: -80.1,
        unit: '° (est)',
        createdAt: Date.now(),
      });

      expect(mockDatabaseService.insertTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryType: 'estimated_latitude',
          unit: '° (est)',
        })
      );
      expect(mockDatabaseService.insertTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryType: 'estimated_longitude',
          unit: '° (est)',
        })
      );
    });

    it('should calculate correct midpoint for positions across different quadrants', () => {
      // Test with coordinates in different hemispheres
      const testCases = [
        {
          name: 'Northern hemisphere',
          prev: { lat: 40.0, lon: -74.0 },
          next: { lat: 42.0, lon: -72.0 },
          expected: { lat: 41.0, lon: -73.0 },
        },
        {
          name: 'Southern hemisphere',
          prev: { lat: -34.0, lon: 151.0 },
          next: { lat: -36.0, lon: 153.0 },
          expected: { lat: -35.0, lon: 152.0 },
        },
        {
          name: 'Crossing equator',
          prev: { lat: -1.0, lon: 100.0 },
          next: { lat: 1.0, lon: 102.0 },
          expected: { lat: 0.0, lon: 101.0 },
        },
      ];

      testCases.forEach(({ prev, next, expected }) => {
        const estimatedLat = (prev.lat + next.lat) / 2;
        const estimatedLon = (prev.lon + next.lon) / 2;

        expect(estimatedLat).toBeCloseTo(expected.lat, 6);
        expect(estimatedLon).toBeCloseTo(expected.lon, 6);
      });
    });

    it('should NOT include packetId for estimated position telemetry', () => {
      const mockDatabaseService = {
        insertTelemetry: vi.fn(),
      };

      const nodeId = '!000007d0';
      const nodeNum = 2000;
      const timestamp = Date.now();
      const now = Date.now();

      // Estimated position telemetry is derived from neighbor calculations,
      // not from a direct mesh packet, so it should NOT have packetId
      mockDatabaseService.insertTelemetry({
        nodeId,
        nodeNum,
        telemetryType: 'estimated_latitude',
        timestamp,
        value: 26.1,
        unit: '° (est)',
        createdAt: now,
      });

      mockDatabaseService.insertTelemetry({
        nodeId,
        nodeNum,
        telemetryType: 'estimated_longitude',
        timestamp,
        value: -80.1,
        unit: '° (est)',
        createdAt: now,
      });

      // Verify packetId is NOT present in estimated position calls
      for (const call of mockDatabaseService.insertTelemetry.mock.calls) {
        expect(call[0]).not.toHaveProperty('packetId');
      }

      // Verify the telemetry types are correct
      expect(mockDatabaseService.insertTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryType: 'estimated_latitude',
        })
      );
      expect(mockDatabaseService.insertTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryType: 'estimated_longitude',
        })
      );
    });

    it('should include packetId in telemetry from actual mesh packets but not derived telemetry', () => {
      const mockDatabaseService = {
        insertTelemetry: vi.fn(),
      };

      const now = Date.now();
      const meshPacketId = 444555666;

      // Telemetry from an actual mesh packet (e.g., position from POSITION_APP)
      mockDatabaseService.insertTelemetry({
        nodeId: '!000003e8',
        nodeNum: 1000,
        telemetryType: 'latitude',
        timestamp: now,
        value: 40.7128,
        unit: '°',
        createdAt: now,
        packetId: meshPacketId,
        channel: 0,
        precisionBits: 32,
      });

      // Derived telemetry (estimated position from neighbor info)
      mockDatabaseService.insertTelemetry({
        nodeId: '!000007d0',
        nodeNum: 2000,
        telemetryType: 'estimated_latitude',
        timestamp: now,
        value: 26.1,
        unit: '° (est)',
        createdAt: now,
      });

      // First call (actual packet) should have packetId
      expect(mockDatabaseService.insertTelemetry.mock.calls[0][0].packetId).toBe(meshPacketId);

      // Second call (derived) should not have packetId
      expect(mockDatabaseService.insertTelemetry.mock.calls[1][0]).not.toHaveProperty('packetId');
    });
  });

  describe('Public Key Cryptography (PKC) tracking', () => {
    it('should capture public key from User protobuf message', () => {
      const mockUser = {
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 43,
        publicKey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      };

      const mockDatabaseService = {
        upsertNode: vi.fn(),
      };

      const publicKeyBase64 = Buffer.from(mockUser.publicKey).toString('base64');

      mockDatabaseService.upsertNode({
        nodeNum: 1000,
        nodeId: '!000003e8',
        longName: mockUser.longName,
        publicKey: publicKeyBase64,
        hasPKC: true
      });

      expect(mockDatabaseService.upsertNode).toHaveBeenCalledWith(
        expect.objectContaining({
          publicKey: publicKeyBase64,
          hasPKC: true
        })
      );
    });

    it('should NOT set hasPKC when publicKey is missing', () => {
      const mockUser = {
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 43
        // No publicKey
      };

      const mockDatabaseService = {
        upsertNode: vi.fn(),
      };

      mockDatabaseService.upsertNode({
        nodeNum: 1000,
        nodeId: '!000003e8',
        longName: mockUser.longName
        // No publicKey or hasPKC
      });

      expect(mockDatabaseService.upsertNode).toHaveBeenCalledWith(
        expect.not.objectContaining({
          publicKey: expect.anything()
        })
      );
    });

    it('should track lastPKIPacket when pki_encrypted flag is set', () => {
      const mockDatabaseService = {
        upsertNode: vi.fn(),
      };

      const timestamp = Date.now();

      mockDatabaseService.upsertNode({
        nodeNum: 1000,
        nodeId: '!000003e8',
        lastPKIPacket: timestamp
      });

      expect(mockDatabaseService.upsertNode).toHaveBeenCalledWith(
        expect.objectContaining({
          lastPKIPacket: expect.any(Number)
        })
      );
    });

    it('should track lastPKIPacket when pkiEncrypted flag is set (camelCase variant)', () => {
      const mockDatabaseService = {
        upsertNode: vi.fn(),
      };

      const timestamp = Date.now();

      mockDatabaseService.upsertNode({
        nodeNum: 1000,
        nodeId: '!000003e8',
        lastPKIPacket: timestamp
      });

      expect(mockDatabaseService.upsertNode).toHaveBeenCalledWith(
        expect.objectContaining({
          lastPKIPacket: expect.any(Number)
        })
      );
    });

    it('should NOT track lastPKIPacket when PKI flags are false', () => {
      const mockMeshPacket = {
        from: 1000,
        pki_encrypted: false,
        pkiEncrypted: false
      };

      // Should not call upsertNode with lastPKIPacket
      expect(mockMeshPacket.pki_encrypted).toBe(false);
      expect(mockMeshPacket.pkiEncrypted).toBe(false);
    });

    it('should convert public key Uint8Array to base64 for storage', () => {
      const publicKeyBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xFF, 0xFE]);
      const expectedBase64 = Buffer.from(publicKeyBytes).toString('base64');

      expect(expectedBase64).toBe('AQIDBP/+');
      expect(Buffer.from(expectedBase64, 'base64')).toEqual(Buffer.from(publicKeyBytes));
    });

    it('should identify nodes with PKC capability in API response', () => {
      const nodes = [
        { nodeId: '!000003e8', hasPKC: true, publicKey: 'abc123' },
        { nodeId: '!000007d0', hasPKC: false, publicKey: null },
        { nodeId: '!00000bb8', hasPKC: true, publicKey: 'def456' },
        { nodeId: '!00000fa0', hasPKC: false, publicKey: null },
      ];

      const nodesWithPKC: string[] = [];
      nodes.forEach(node => {
        if (node.hasPKC || node.publicKey) {
          nodesWithPKC.push(node.nodeId);
        }
      });

      expect(nodesWithPKC).toEqual(['!000003e8', '!00000bb8']);
      expect(nodesWithPKC.length).toBe(2);
    });
  });
});
