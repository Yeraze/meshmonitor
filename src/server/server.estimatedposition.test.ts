import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Server /api/nodes endpoint - Estimated Position Integration', () => {
  let databaseService: any;
  let meshtasticManager: any;

  beforeEach(() => {
    // Setup mocks
    databaseService = {
      getTelemetryByNode: vi.fn()
    };

    meshtasticManager = {
      getAllNodes: vi.fn()
    };
  });

  describe('Estimated Position Enhancement', () => {
    it('should include estimated position when node has no regular position', () => {
      // Arrange - Node without regular position
      const nodeWithoutPosition = {
        nodeNum: 1,
        user: {
          id: '!00000001',
          longName: 'Test Node',
          shortName: 'TN'
        },
        position: null
      };

      meshtasticManager.getAllNodes.mockReturnValue([nodeWithoutPosition]);

      // Mock telemetry with estimated position
      databaseService.getTelemetryByNode.mockReturnValue([
        {
          id: 1,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'estimated_latitude',
          value: 26.1,
          unit: '° (est)',
          timestamp: Date.now(),
          createdAt: Date.now()
        },
        {
          id: 2,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'estimated_longitude',
          value: -80.1,
          unit: '° (est)',
          timestamp: Date.now(),
          createdAt: Date.now()
        }
      ]);

      // Act - Simulate the enhancement logic from server.ts
      const nodes = meshtasticManager.getAllNodes();
      const enhancedNodes = nodes.map((node: any) => {
        if (!node.user?.id) return { ...node, isMobile: false };

        const positionTelemetry = databaseService.getTelemetryByNode(node.user.id, 100);
        const estimatedLatitudes = positionTelemetry.filter((t: any) => t.telemetryType === 'estimated_latitude');
        const estimatedLongitudes = positionTelemetry.filter((t: any) => t.telemetryType === 'estimated_longitude');

        let enhancedNode = { ...node, isMobile: false };
        if (!node.position?.latitude && !node.position?.longitude &&
            estimatedLatitudes.length > 0 && estimatedLongitudes.length > 0) {
          enhancedNode.position = {
            latitude: estimatedLatitudes[0].value,
            longitude: estimatedLongitudes[0].value,
            altitude: node.position?.altitude
          };
        }

        return enhancedNode;
      });

      // Assert
      expect(enhancedNodes).toHaveLength(1);
      expect(enhancedNodes[0].position).toBeDefined();
      expect(enhancedNodes[0].position?.latitude).toBe(26.1);
      expect(enhancedNodes[0].position?.longitude).toBe(-80.1);
    });

    it('should NOT override regular position with estimated position', () => {
      // Arrange - Node with regular position
      const nodeWithPosition = {
        nodeNum: 1,
        user: {
          id: '!00000001',
          longName: 'Test Node',
          shortName: 'TN'
        },
        position: {
          latitude: 25.0,
          longitude: -80.0,
          altitude: 10
        }
      };

      meshtasticManager.getAllNodes.mockReturnValue([nodeWithPosition]);

      // Mock telemetry with estimated position
      databaseService.getTelemetryByNode.mockReturnValue([
        {
          id: 1,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'estimated_latitude',
          value: 26.1,
          unit: '° (est)',
          timestamp: Date.now(),
          createdAt: Date.now()
        },
        {
          id: 2,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'estimated_longitude',
          value: -80.1,
          unit: '° (est)',
          timestamp: Date.now(),
          createdAt: Date.now()
        }
      ]);

      // Act - Simulate the enhancement logic
      const nodes = meshtasticManager.getAllNodes();
      const enhancedNodes = nodes.map((node: any) => {
        if (!node.user?.id) return { ...node, isMobile: false };

        const positionTelemetry = databaseService.getTelemetryByNode(node.user.id, 100);
        const estimatedLatitudes = positionTelemetry.filter((t: any) => t.telemetryType === 'estimated_latitude');
        const estimatedLongitudes = positionTelemetry.filter((t: any) => t.telemetryType === 'estimated_longitude');

        let enhancedNode = { ...node, isMobile: false };
        if (!node.position?.latitude && !node.position?.longitude &&
            estimatedLatitudes.length > 0 && estimatedLongitudes.length > 0) {
          enhancedNode.position = {
            latitude: estimatedLatitudes[0].value,
            longitude: estimatedLongitudes[0].value,
            altitude: node.position?.altitude
          };
        }

        return enhancedNode;
      });

      // Assert - Regular position should remain unchanged
      expect(enhancedNodes).toHaveLength(1);
      expect(enhancedNodes[0].position?.latitude).toBe(25.0);
      expect(enhancedNodes[0].position?.longitude).toBe(-80.0);
      expect(enhancedNodes[0].position?.altitude).toBe(10);
    });

    it('should handle node without estimated position gracefully', () => {
      // Arrange - Node without any position data
      const nodeWithoutPosition = {
        nodeNum: 1,
        user: {
          id: '!00000001',
          longName: 'Test Node',
          shortName: 'TN'
        },
        position: null
      };

      meshtasticManager.getAllNodes.mockReturnValue([nodeWithoutPosition]);

      // Mock telemetry without estimated position
      databaseService.getTelemetryByNode.mockReturnValue([
        {
          id: 1,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'battery',
          value: 85.5,
          timestamp: Date.now(),
          createdAt: Date.now()
        }
      ]);

      // Act
      const nodes = meshtasticManager.getAllNodes();
      const enhancedNodes = nodes.map((node: any) => {
        if (!node.user?.id) return { ...node, isMobile: false };

        const positionTelemetry = databaseService.getTelemetryByNode(node.user.id, 100);
        const estimatedLatitudes = positionTelemetry.filter((t: any) => t.telemetryType === 'estimated_latitude');
        const estimatedLongitudes = positionTelemetry.filter((t: any) => t.telemetryType === 'estimated_longitude');

        let enhancedNode = { ...node, isMobile: false };
        if (!node.position?.latitude && !node.position?.longitude &&
            estimatedLatitudes.length > 0 && estimatedLongitudes.length > 0) {
          enhancedNode.position = {
            latitude: estimatedLatitudes[0].value,
            longitude: estimatedLongitudes[0].value,
            altitude: node.position?.altitude
          };
        }

        return enhancedNode;
      });

      // Assert - Position should remain null/undefined
      expect(enhancedNodes).toHaveLength(1);
      expect(enhancedNodes[0].position).toBeNull();
    });

    it('should use most recent estimated position when multiple exist', () => {
      // Arrange
      const nodeWithoutPosition = {
        nodeNum: 1,
        user: {
          id: '!00000001',
          longName: 'Test Node',
          shortName: 'TN'
        },
        position: null
      };

      meshtasticManager.getAllNodes.mockReturnValue([nodeWithoutPosition]);

      // Mock telemetry with multiple estimated positions (most recent first)
      const now = Date.now();
      databaseService.getTelemetryByNode.mockReturnValue([
        {
          id: 3,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'estimated_latitude',
          value: 26.5,  // Most recent
          unit: '° (est)',
          timestamp: now,
          createdAt: now
        },
        {
          id: 1,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'estimated_latitude',
          value: 26.1,  // Older
          unit: '° (est)',
          timestamp: now - 1000,
          createdAt: now - 1000
        },
        {
          id: 4,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'estimated_longitude',
          value: -80.5,  // Most recent
          unit: '° (est)',
          timestamp: now,
          createdAt: now
        },
        {
          id: 2,
          nodeId: '!00000001',
          nodeNum: 1,
          telemetryType: 'estimated_longitude',
          value: -80.1,  // Older
          unit: '° (est)',
          timestamp: now - 1000,
          createdAt: now - 1000
        }
      ]);

      // Act
      const nodes = meshtasticManager.getAllNodes();
      const enhancedNodes = nodes.map((node: any) => {
        if (!node.user?.id) return { ...node, isMobile: false };

        const positionTelemetry = databaseService.getTelemetryByNode(node.user.id, 100);
        const estimatedLatitudes = positionTelemetry.filter((t: any) => t.telemetryType === 'estimated_latitude');
        const estimatedLongitudes = positionTelemetry.filter((t: any) => t.telemetryType === 'estimated_longitude');

        let enhancedNode = { ...node, isMobile: false };
        if (!node.position?.latitude && !node.position?.longitude &&
            estimatedLatitudes.length > 0 && estimatedLongitudes.length > 0) {
          enhancedNode.position = {
            latitude: estimatedLatitudes[0].value,
            longitude: estimatedLongitudes[0].value,
            altitude: node.position?.altitude
          };
        }

        return enhancedNode;
      });

      // Assert - Should use most recent values
      expect(enhancedNodes).toHaveLength(1);
      expect(enhancedNodes[0].position?.latitude).toBe(26.5);
      expect(enhancedNodes[0].position?.longitude).toBe(-80.5);
    });
  });
});
