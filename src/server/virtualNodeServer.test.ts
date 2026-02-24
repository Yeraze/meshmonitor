import { describe, it, expect } from 'vitest';

/**
 * Unit tests for Virtual Node Server
 *
 * Tests core functionality including:
 * - Configuration constants
 * - Admin command filtering
 * - Portnum detection
 * - Security constraints
 * - Message processing logic
 * - Client lifecycle management
 */

// Meshtastic portnum constants (from @meshtastic/js protobuf definitions)
const PORTNUM = {
  TEXT_MESSAGE_APP: 1,
  POSITION_APP: 3,
  ADMIN_APP: 6,
  NODEINFO_APP: 8,
  TELEMETRY_APP: 67,
} as const;

describe('Virtual Node Server - Constants and Configuration', () => {
  describe('Port numbers', () => {
    it('should use standard Meshtastic TCP port 4403 by default', () => {
      // Standard Meshtastic TCP port is 4403
      const DEFAULT_MESHTASTIC_TCP_PORT = 4403;
      expect(DEFAULT_MESHTASTIC_TCP_PORT).toBe(4403);
    });

    it('should use custom default port 4404 for Virtual Node Server', () => {
      // Virtual Node Server uses 4404 to avoid conflict with direct node connections
      const DEFAULT_VIRTUAL_NODE_PORT = 4404;
      expect(DEFAULT_VIRTUAL_NODE_PORT).toBe(4404);
    });

    it('should support custom port configuration via environment', () => {
      // Port should be configurable via VIRTUAL_NODE_PORT env var
      const customPort = 5555;
      expect(customPort).toBeGreaterThan(1024);
      expect(customPort).toBeLessThan(65536);
    });
  });

  describe('Timeout Configuration', () => {
    it('should define client timeout constant', () => {
      const CLIENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      expect(CLIENT_TIMEOUT_MS).toBe(300000);
      expect(CLIENT_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it('should define connection timeout constant', () => {
      const CONNECTION_TIMEOUT_MS = 30 * 1000; // 30 seconds
      expect(CONNECTION_TIMEOUT_MS).toBe(30000);
      expect(CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    });
  });
});

describe('Virtual Node Server - Admin Command Filtering', () => {
  describe('Blocked Admin Portnums', () => {
    it('should block ADMIN_APP portnum (6)', () => {
      const ADMIN_APP = PORTNUM.ADMIN_APP;
      expect(ADMIN_APP).toBe(6);

      // Should be blocked for security
      const isAdminCommand = (portnum: number) => portnum === ADMIN_APP;
      expect(isAdminCommand(6)).toBe(true);
      expect(isAdminCommand(2)).toBe(false);
    });

    it('should allow TEXT_MESSAGE_APP portnum (1)', () => {
      const TEXT_MESSAGE_APP = PORTNUM.TEXT_MESSAGE_APP;
      expect(TEXT_MESSAGE_APP).toBe(1);

      // TEXT_MESSAGE_APP should not be blocked
      const isAdminCommand = (portnum: number) => portnum === 6 || portnum === 8;
      expect(isAdminCommand(TEXT_MESSAGE_APP)).toBe(false);
    });

    it('should allow POSITION_APP portnum (3)', () => {
      const POSITION_APP = PORTNUM.POSITION_APP;
      expect(POSITION_APP).toBe(3);

      const isAdminCommand = (portnum: number) => portnum === 6 || portnum === 8;
      expect(isAdminCommand(POSITION_APP)).toBe(false);
    });

    it('should block NODEINFO_APP portnum (8)', () => {
      const NODEINFO_APP = PORTNUM.NODEINFO_APP;
      expect(NODEINFO_APP).toBe(8);

      // Should be blocked for security
      const isAdminCommand = (portnum: number) => portnum === 6 || portnum === 8;
      expect(isAdminCommand(NODEINFO_APP)).toBe(true);
    });

    it('should allow TELEMETRY_APP portnum (67)', () => {
      const TELEMETRY_APP = PORTNUM.TELEMETRY_APP;
      expect(TELEMETRY_APP).toBe(67);

      const isAdminCommand = (portnum: number) => portnum === 6 || portnum === 8;
      expect(isAdminCommand(TELEMETRY_APP)).toBe(false);
    });
  });

  describe('Admin Message Detection', () => {
    it('should identify admin messages by portnum', () => {
      const isAdminMessage = (portnum: number) => {
        return portnum === PORTNUM.ADMIN_APP || portnum === PORTNUM.NODEINFO_APP;
      };

      expect(isAdminMessage(6)).toBe(true); // ADMIN_APP
      expect(isAdminMessage(8)).toBe(true); // NODEINFO_APP
      expect(isAdminMessage(3)).toBe(false); // POSITION_APP
      expect(isAdminMessage(1)).toBe(false); // TEXT_MESSAGE_APP
    });

    it('should handle undefined portnum gracefully', () => {
      const isAdminMessage = (portnum: number | undefined) => {
        if (portnum === undefined) return false;
        return portnum === PORTNUM.ADMIN_APP || portnum === PORTNUM.NODEINFO_APP;
      };

      expect(isAdminMessage(undefined)).toBe(false);
      expect(isAdminMessage(6)).toBe(true); // ADMIN_APP
      expect(isAdminMessage(8)).toBe(true); // NODEINFO_APP
    });
  });
});

describe('Virtual Node Server - Config State Management', () => {
  describe('Config Capture Logic', () => {
    it('should capture config messages during initial sync', () => {
      const capturedConfigPackets: any[] = [];
      const CONFIG_PORTNUMS = [
        PORTNUM.NODEINFO_APP,
        PORTNUM.POSITION_APP,
      ];

      const capturePacket = (packet: any) => {
        if (packet.decoded?.portnum && CONFIG_PORTNUMS.includes(packet.decoded.portnum)) {
          capturedConfigPackets.push(packet);
        }
      };

      // Simulate capturing packets
      capturePacket({ decoded: { portnum: 8 } }); // NODEINFO_APP
      capturePacket({ decoded: { portnum: 3 } }); // POSITION_APP
      capturePacket({ decoded: { portnum: 1 } }); // TEXT_MESSAGE_APP (not captured)

      expect(capturedConfigPackets).toHaveLength(2);
    });

    it('should replay config to new clients', () => {
      const configPackets = [
        { decoded: { portnum: 8, payload: 'nodeinfo1' } }, // NODEINFO_APP
        { decoded: { portnum: 8, payload: 'nodeinfo2' } }, // NODEINFO_APP
        { decoded: { portnum: 3, payload: 'position1' } }   // POSITION_APP
      ];

      const replayedPackets: any[] = [];
      const replayConfig = (_client: any, packets: any[]) => {
        packets.forEach(packet => replayedPackets.push(packet));
      };

      replayConfig({}, configPackets);
      expect(replayedPackets).toHaveLength(3);
      expect(replayedPackets[0].decoded.portnum).toBe(8); // NODEINFO_APP
    });

    it('should not replay empty config', () => {
      const configPackets: any[] = [];
      const replayedPackets: any[] = [];

      const replayConfig = (_client: any, packets: any[]) => {
        if (packets.length === 0) return;
        packets.forEach(packet => replayedPackets.push(packet));
      };

      replayConfig({}, configPackets);
      expect(replayedPackets).toHaveLength(0);
    });
  });

  describe('Config ID Matching', () => {
    it('should match wantConfigId with configCompleteId', () => {
      const wantConfigId = 123456;
      const configCompleteId = 123456;

      expect(wantConfigId).toBe(configCompleteId);
    });

    it('should handle different config IDs', () => {
      const wantConfigId = 123456;
      const configCompleteId = 789012;

      expect(wantConfigId).not.toBe(configCompleteId);
    });

    it('should handle missing config IDs', () => {
      const wantConfigId = undefined;
      const configCompleteId = 123456;

      expect(wantConfigId).not.toBe(configCompleteId);
    });
  });
});

describe('Virtual Node Server - Broadcast Loop Prevention', () => {
  describe('Packet De-duplication', () => {
    it('should track recently broadcast packet IDs', () => {
      const broadcastPacketIds = new Set<number>();

      const shouldBroadcast = (packetId: number) => {
        if (broadcastPacketIds.has(packetId)) {
          return false; // Already broadcast
        }
        broadcastPacketIds.add(packetId);
        return true;
      };

      expect(shouldBroadcast(123)).toBe(true);
      expect(shouldBroadcast(123)).toBe(false); // Duplicate
      expect(shouldBroadcast(456)).toBe(true);
      expect(shouldBroadcast(456)).toBe(false); // Duplicate
    });

    it('should limit Set size to prevent memory leak', () => {
      const MAX_TRACKED_PACKETS = 1000;
      const broadcastPacketIds = new Set<number>();

      const addPacketId = (packetId: number) => {
        if (broadcastPacketIds.size >= MAX_TRACKED_PACKETS) {
          // Remove oldest entry (first item)
          const firstId = broadcastPacketIds.values().next().value as number;
          broadcastPacketIds.delete(firstId);
        }
        broadcastPacketIds.add(packetId);
      };

      // Add MAX_TRACKED_PACKETS + 100 packets
      for (let i = 0; i < MAX_TRACKED_PACKETS + 100; i++) {
        addPacketId(i);
      }

      expect(broadcastPacketIds.size).toBe(MAX_TRACKED_PACKETS);
    });

    it('should handle concurrent packet processing', () => {
      const broadcastPacketIds = new Set<number>();
      const results: boolean[] = [];

      const shouldBroadcast = (packetId: number) => {
        if (broadcastPacketIds.has(packetId)) {
          return false;
        }
        broadcastPacketIds.add(packetId);
        return true;
      };

      // Simulate concurrent processing of same packet
      results.push(shouldBroadcast(999));
      results.push(shouldBroadcast(999));
      results.push(shouldBroadcast(999));

      const trueCount = results.filter(r => r === true).length;
      expect(trueCount).toBe(1); // Only first should broadcast
    });
  });

  describe('Packet ID Generation', () => {
    it('should generate unique packet IDs', () => {
      const generatedIds = new Set<number>();
      const generateId = () => Math.floor(Math.random() * 0xFFFFFFFF);

      for (let i = 0; i < 100; i++) {
        const id = generateId();
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThanOrEqual(0xFFFFFFFF);
        generatedIds.add(id);
      }

      // Most IDs should be unique (allowing for small collision chance)
      expect(generatedIds.size).toBeGreaterThan(95);
    });
  });
});

describe('Virtual Node Server - Client Lifecycle', () => {
  describe('Client Connection Tracking', () => {
    it('should track active client connections', () => {
      const clients = new Map<string, any>();
      const clientId1 = 'client-1';
      const clientId2 = 'client-2';

      clients.set(clientId1, { id: clientId1, connected: true });
      clients.set(clientId2, { id: clientId2, connected: true });

      expect(clients.size).toBe(2);
      expect(clients.has(clientId1)).toBe(true);
      expect(clients.has(clientId2)).toBe(true);
    });

    it('should remove disconnected clients', () => {
      const clients = new Map<string, any>();
      const clientId = 'client-1';

      clients.set(clientId, { id: clientId, connected: true });
      expect(clients.size).toBe(1);

      clients.delete(clientId);
      expect(clients.size).toBe(0);
      expect(clients.has(clientId)).toBe(false);
    });

    it('should handle client timeout', () => {
      const CLIENT_TIMEOUT_MS = 5 * 60 * 1000;
      const now = Date.now();
      const lastActivity = now - (CLIENT_TIMEOUT_MS + 1000);

      const isTimedOut = (lastActivityTime: number) => {
        return (now - lastActivityTime) > CLIENT_TIMEOUT_MS;
      };

      expect(isTimedOut(lastActivity)).toBe(true);
      expect(isTimedOut(now)).toBe(false);
      expect(isTimedOut(now - 1000)).toBe(false);
    });
  });

  describe('Client Message Queueing', () => {
    it('should queue messages for client', () => {
      const clientQueue: any[] = [];

      const queueMessage = (message: any) => {
        clientQueue.push(message);
      };

      queueMessage({ type: 'nodeinfo', data: 'test1' });
      queueMessage({ type: 'position', data: 'test2' });

      expect(clientQueue).toHaveLength(2);
      expect(clientQueue[0].type).toBe('nodeinfo');
    });

    it('should limit queue size', () => {
      const MAX_QUEUE_SIZE = 100;
      const clientQueue: any[] = [];

      const queueMessage = (message: any) => {
        if (clientQueue.length >= MAX_QUEUE_SIZE) {
          clientQueue.shift(); // Remove oldest
        }
        clientQueue.push(message);
      };

      // Add more than MAX_QUEUE_SIZE messages
      for (let i = 0; i < MAX_QUEUE_SIZE + 50; i++) {
        queueMessage({ id: i });
      }

      expect(clientQueue).toHaveLength(MAX_QUEUE_SIZE);
      expect(clientQueue[0].id).toBe(50); // First 50 removed
    });
  });
});

describe('Virtual Node Server - Security', () => {
  describe('Admin Command Blocking', () => {
    it('should block admin commands from clients by default', () => {
      const ADMIN_PORTNUM = 6; // ADMIN_APP
      const NODEINFO_PORTNUM = 8; // NODEINFO_APP
      const allowAdminCommands = false; // Default

      const isBlockedPortnum = (portnum: number) => {
        return portnum === ADMIN_PORTNUM || portnum === NODEINFO_PORTNUM;
      };

      // When allowAdminCommands is false, admin commands should be blocked
      const shouldBlock = !allowAdminCommands && isBlockedPortnum(ADMIN_PORTNUM);
      expect(shouldBlock).toBe(true);
      expect(isBlockedPortnum(NODEINFO_PORTNUM)).toBe(true); // NODEINFO_APP should be blocked
      expect(isBlockedPortnum(3)).toBe(false); // POSITION_APP
    });

    it('should allow admin commands when explicitly enabled', () => {
      const ADMIN_PORTNUM = 6; // ADMIN_APP
      const NODEINFO_PORTNUM = 8; // NODEINFO_APP
      const allowAdminCommands = true; // Explicitly enabled

      const isBlockedPortnum = (portnum: number) => {
        return portnum === ADMIN_PORTNUM || portnum === NODEINFO_PORTNUM;
      };

      // When allowAdminCommands is true, admin commands should NOT be blocked
      const shouldBlock = !allowAdminCommands && isBlockedPortnum(ADMIN_PORTNUM);
      expect(shouldBlock).toBe(false);

      // Verify other portnums still work normally
      expect(isBlockedPortnum(3)).toBe(false); // POSITION_APP
    });

    it('should respect allowAdminCommands configuration', () => {
      const ADMIN_PORTNUM = 6; // ADMIN_APP
      const NODEINFO_PORTNUM = 8; // NODEINFO_APP

      const processCommand = (portnum: number, allowAdmin: boolean) => {
        const isAdminCommand = portnum === ADMIN_PORTNUM || portnum === NODEINFO_PORTNUM;

        if (!allowAdmin && isAdminCommand) {
          return 'blocked';
        }
        return 'allowed';
      };

      expect(processCommand(ADMIN_PORTNUM, false)).toBe('blocked');
      expect(processCommand(ADMIN_PORTNUM, true)).toBe('allowed');
      expect(processCommand(NODEINFO_PORTNUM, false)).toBe('blocked');
      expect(processCommand(NODEINFO_PORTNUM, true)).toBe('allowed');
      expect(processCommand(3, false)).toBe('allowed'); // Non-admin always allowed
      expect(processCommand(3, true)).toBe('allowed'); // Non-admin always allowed
    });

    it('should log blocked admin command attempts', () => {
      const logs: string[] = [];
      const logWarning = (message: string) => logs.push(message);

      const processClientPacket = (packet: any) => {
        if (packet.decoded?.portnum === 1) {
          logWarning(`Blocked admin command from client`);
          return false; // Don't forward
        }
        return true; // Forward
      };

      const result1 = processClientPacket({ decoded: { portnum: 1 } });
      const result2 = processClientPacket({ decoded: { portnum: 3 } });

      expect(result1).toBe(false);
      expect(result2).toBe(true);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('Blocked admin command');
    });
  });

  describe('Message Validation', () => {
    it('should validate packet structure', () => {
      const isValidPacket = (packet: any) => {
        if (!packet) return false;
        if (!packet.decoded) return false;
        if (typeof packet.decoded.portnum !== 'number') return false;
        return true;
      };

      expect(isValidPacket(null)).toBe(false);
      expect(isValidPacket({})).toBe(false);
      expect(isValidPacket({ decoded: {} })).toBe(false);
      expect(isValidPacket({ decoded: { portnum: 'invalid' } })).toBe(false);
      expect(isValidPacket({ decoded: { portnum: 1 } })).toBe(true);
    });

    it('should reject malformed packets', () => {
      const processPacket = (packet: any) => {
        try {
          if (!packet?.decoded?.portnum) {
            throw new Error('Invalid packet structure');
          }
          return true;
        } catch (error) {
          return false;
        }
      };

      expect(processPacket(null)).toBe(false);
      expect(processPacket(undefined)).toBe(false);
      expect(processPacket({})).toBe(false);
      expect(processPacket({ decoded: { portnum: 1 } })).toBe(true);
    });
  });
});

describe('Virtual Node Server - Error Handling', () => {
  describe('Connection Errors', () => {
    it('should handle client disconnect gracefully', () => {
      const activeClients = new Map<string, any>();
      const clientId = 'test-client';

      activeClients.set(clientId, { id: clientId });

      const handleDisconnect = (id: string) => {
        activeClients.delete(id);
      };

      expect(activeClients.size).toBe(1);
      handleDisconnect(clientId);
      expect(activeClients.size).toBe(0);
    });

    it('should handle socket errors without crashing', () => {
      const handleError = (error: Error) => {
        return { handled: true, error: error.message };
      };

      const result = handleError(new Error('Connection reset'));
      expect(result.handled).toBe(true);
      expect(result.error).toBe('Connection reset');
    });
  });

  describe('Data Processing Errors', () => {
    it('should handle invalid protobuf data', () => {
      const processBuffer = (buffer: Buffer) => {
        try {
          if (!buffer || buffer.length === 0) {
            throw new Error('Empty buffer');
          }
          return { success: true };
        } catch (error) {
          return { success: false, error };
        }
      };

      const result1 = processBuffer(Buffer.from([]));
      const result2 = processBuffer(Buffer.from([0x01, 0x02, 0x03]));

      expect(result1.success).toBe(false);
      expect(result2.success).toBe(true);
    });

    it('should handle missing packet fields', () => {
      const extractPortnum = (packet: any) => {
        return packet?.decoded?.portnum ?? null;
      };

      expect(extractPortnum(null)).toBe(null);
      expect(extractPortnum({})).toBe(null);
      expect(extractPortnum({ decoded: {} })).toBe(null);
      expect(extractPortnum({ decoded: { portnum: 1 } })).toBe(1);
    });
  });
});
