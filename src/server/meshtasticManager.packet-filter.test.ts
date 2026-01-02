/**
 * Tests for packet log filtering logic
 *
 * Verifies that internal packets (ADMIN_APP and ROUTING_APP) to/from the local node
 * are excluded from the packet log, while mesh traffic is logged.
 */

import { describe, it, expect } from 'vitest';
import { shouldExcludeFromPacketLog } from './meshtasticManager.js';

// Port numbers
const ROUTING_APP = 5;
const ADMIN_APP = 6;
const TEXT_MESSAGE_APP = 1;
const POSITION_APP = 3;
const NODEINFO_APP = 4;
const TELEMETRY_APP = 67;

// Test node numbers
const LOCAL_NODE = 123456789;
const REMOTE_NODE_A = 987654321;
const REMOTE_NODE_B = 111222333;
const BROADCAST = 0xffffffff;

describe('shouldExcludeFromPacketLog', () => {
  describe('local internal packets (should be excluded)', () => {
    it('should exclude ADMIN_APP packets FROM local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, ADMIN_APP, LOCAL_NODE)).toBe(true);
    });

    it('should exclude ADMIN_APP packets TO local node', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, LOCAL_NODE, ADMIN_APP, LOCAL_NODE)).toBe(true);
    });

    it('should exclude ROUTING_APP packets FROM local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, ROUTING_APP, LOCAL_NODE)).toBe(true);
    });

    it('should exclude ROUTING_APP packets TO local node', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, LOCAL_NODE, ROUTING_APP, LOCAL_NODE)).toBe(true);
    });

    it('should exclude ADMIN_APP packets from local to local (self)', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, LOCAL_NODE, ADMIN_APP, LOCAL_NODE)).toBe(true);
    });
  });

  describe('remote mesh traffic (should NOT be excluded)', () => {
    it('should NOT exclude ADMIN_APP packets between remote nodes', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, REMOTE_NODE_B, ADMIN_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude ROUTING_APP packets between remote nodes', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, REMOTE_NODE_B, ROUTING_APP, LOCAL_NODE)).toBe(false);
    });
  });

  describe('regular mesh traffic (should NOT be excluded)', () => {
    it('should NOT exclude TEXT_MESSAGE_APP packets from local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, TEXT_MESSAGE_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude TEXT_MESSAGE_APP packets to local node', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, LOCAL_NODE, TEXT_MESSAGE_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude POSITION_APP packets from local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, BROADCAST, POSITION_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude NODEINFO_APP packets from local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, BROADCAST, NODEINFO_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude TELEMETRY_APP packets from local node', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, BROADCAST, TELEMETRY_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude TEXT_MESSAGE_APP packets between remote nodes', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, REMOTE_NODE_B, TEXT_MESSAGE_APP, LOCAL_NODE)).toBe(false);
    });

    it('should NOT exclude broadcast messages from remote nodes', () => {
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, BROADCAST, TEXT_MESSAGE_APP, LOCAL_NODE)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should NOT exclude any packets when localNodeNum is null (not connected)', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, ADMIN_APP, null)).toBe(false);
      expect(shouldExcludeFromPacketLog(REMOTE_NODE_A, LOCAL_NODE, ROUTING_APP, null)).toBe(false);
    });

    it('should exclude ADMIN_APP packets from local node even when toNum is null', () => {
      // Broadcast ADMIN_APP from local node - still excluded since from local
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, null, ADMIN_APP, LOCAL_NODE)).toBe(true);
    });

    it('should handle portnum 0 (UNKNOWN_APP) correctly', () => {
      expect(shouldExcludeFromPacketLog(LOCAL_NODE, REMOTE_NODE_A, 0, LOCAL_NODE)).toBe(false);
    });
  });
});
