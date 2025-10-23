/**
 * Packet Log Service Tests
 *
 * Tests packet logging, filtering, and cleanup functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import packetLogService from './packetLogService.js';
import databaseService from '../../services/database.js';

describe('PacketLogService', () => {
  beforeEach(() => {
    // Clear packet logs and reset settings before each test
    packetLogService.clearPackets();
    databaseService.setSetting('packet_log_enabled', '0');
    databaseService.setSetting('packet_log_max_count', '1000');
    databaseService.setSetting('packet_log_max_age_hours', '24');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Service Configuration', () => {
    it('should be disabled by default', () => {
      expect(packetLogService.isEnabled()).toBe(false);
    });

    it('should return correct max count', () => {
      expect(packetLogService.getMaxCount()).toBeGreaterThan(0);
    });

    it('should return correct max age hours', () => {
      expect(packetLogService.getMaxAgeHours()).toBeGreaterThan(0);
    });
  });

  describe('Packet Logging', () => {
    it('should log a basic packet', () => {
      databaseService.setSetting('packet_log_enabled', '1');

      packetLogService.logPacket({
        packet_id: 12345,
        timestamp: Math.floor(Date.now() / 1000),
        from_node: 123456789,
        from_node_id: '!075bcd15',
        to_node: 987654321,
        to_node_id: '!3ade68b1',
        channel: 0,
        portnum: 1,
        portnum_name: 'TEXT_MESSAGE_APP',
        encrypted: false,
        payload_preview: 'Hello World',
        metadata: JSON.stringify({ test: true })
      });

      const packets = packetLogService.getPackets({ limit: 10 });
      expect(packets.length).toBe(1);
      expect(packets[0].portnum).toBe(1);
      expect(packets[0].portnum_name).toBe('TEXT_MESSAGE_APP');
    });

    it('should log encrypted packet', () => {
      databaseService.setSetting('packet_log_enabled', '1');

      packetLogService.logPacket({
        packet_id: 12346,
        timestamp: Math.floor(Date.now() / 1000),
        from_node: 123456789,
        to_node: 987654321,
        channel: 0,
        portnum: 0,
        encrypted: true,
        payload_preview: '🔒 <ENCRYPTED>',
        metadata: '{}'
      });

      const packets = packetLogService.getPackets({ encrypted: true });
      expect(packets.length).toBe(1);
      expect(packets[0].encrypted).toBe(1); // SQLite stores booleans as integers
      expect(packets[0].payload_preview).toContain('ENCRYPTED');
    });

    it('should not log when disabled', () => {
      databaseService.setSetting('packet_log_enabled', '0');

      packetLogService.logPacket({
        packet_id: 12347,
        timestamp: Math.floor(Date.now() / 1000),
        from_node: 123456789,
        channel: 0,
        portnum: 1,
        encrypted: false,
        metadata: '{}'
      });

      const packets = packetLogService.getPackets({ limit: 10 });
      expect(packets.length).toBe(0);
    });

    it('should handle packets with all optional fields', () => {
      databaseService.setSetting('packet_log_enabled', '1');

      packetLogService.logPacket({
        packet_id: 12348,
        timestamp: Math.floor(Date.now() / 1000),
        from_node: 123456789,
        from_node_id: '!075bcd15',
        to_node: 987654321,
        to_node_id: '!3ade68b1',
        channel: 2,
        portnum: 67,
        portnum_name: 'TELEMETRY_APP',
        encrypted: false,
        snr: 8.5,
        rssi: -45,
        hop_limit: 3,
        hop_start: 3,
        payload_size: 128,
        want_ack: true,
        priority: 64,
        payload_preview: '[Telemetry: Device]',
        metadata: JSON.stringify({ deviceMetrics: { batteryLevel: 95 } })
      });

      const packets = packetLogService.getPackets({ limit: 10 });
      expect(packets.length).toBe(1);
      expect(packets[0].snr).toBe(8.5);
      expect(packets[0].rssi).toBe(-45);
      expect(packets[0].want_ack).toBe(1); // SQLite stores booleans as integers
    });
  });

  describe('Packet Filtering', () => {
    beforeEach(() => {
      databaseService.setSetting('packet_log_enabled', '1');

      // Add test data
      const baseTime = Math.floor(Date.now() / 1000);

      packetLogService.logPacket({
        packet_id: 1,
        timestamp: baseTime - 100,
        from_node: 111,
        channel: 0,
        portnum: 1,
        portnum_name: 'TEXT_MESSAGE_APP',
        encrypted: false,
        metadata: '{}'
      });

      packetLogService.logPacket({
        packet_id: 2,
        timestamp: baseTime - 50,
        from_node: 222,
        to_node: 333,
        channel: 1,
        portnum: 3,
        portnum_name: 'POSITION_APP',
        encrypted: true,
        metadata: '{}'
      });

      packetLogService.logPacket({
        packet_id: 3,
        timestamp: baseTime,
        from_node: 111,
        channel: 0,
        portnum: 67,
        portnum_name: 'TELEMETRY_APP',
        encrypted: false,
        metadata: '{}'
      });
    });

    it('should filter by portnum', () => {
      const packets = packetLogService.getPackets({ portnum: 1 });
      expect(packets.length).toBe(1);
      expect(packets[0].portnum).toBe(1);
    });

    it('should filter by from_node', () => {
      const packets = packetLogService.getPackets({ from_node: 111 });
      expect(packets.length).toBe(2);
      packets.forEach(p => expect(p.from_node).toBe(111));
    });

    it('should filter by to_node', () => {
      const packets = packetLogService.getPackets({ to_node: 333 });
      expect(packets.length).toBe(1);
      expect(packets[0].to_node).toBe(333);
    });

    it('should filter by channel', () => {
      const packets = packetLogService.getPackets({ channel: 0 });
      expect(packets.length).toBe(2);
      packets.forEach(p => expect(p.channel).toBe(0));
    });

    it('should filter by encrypted status', () => {
      const encryptedPackets = packetLogService.getPackets({ encrypted: true });
      expect(encryptedPackets.length).toBe(1);
      expect(encryptedPackets[0].encrypted).toBe(1); // SQLite stores booleans as integers

      const decryptedPackets = packetLogService.getPackets({ encrypted: false });
      expect(decryptedPackets.length).toBe(2);
      decryptedPackets.forEach(p => expect(p.encrypted).toBe(0)); // SQLite stores booleans as integers
    });

    it('should filter by since timestamp', () => {
      const baseTime = Math.floor(Date.now() / 1000);
      const packets = packetLogService.getPackets({ since: baseTime - 60 });
      expect(packets.length).toBe(2); // Should only get packets from last 60s
    });

    it('should support multiple filters combined', () => {
      const packets = packetLogService.getPackets({
        from_node: 111,
        channel: 0,
        encrypted: false
      });
      expect(packets.length).toBe(2);
      packets.forEach(p => {
        expect(p.from_node).toBe(111);
        expect(p.channel).toBe(0);
        expect(p.encrypted).toBe(0); // SQLite stores booleans as integers
      });
    });

    it('should respect offset and limit', () => {
      const page1 = packetLogService.getPackets({ offset: 0, limit: 2 });
      expect(page1.length).toBe(2);

      const page2 = packetLogService.getPackets({ offset: 2, limit: 2 });
      expect(page2.length).toBe(1);
    });
  });

  describe('Packet Count', () => {
    beforeEach(() => {
      databaseService.setSetting('packet_log_enabled', '1');

      // Add test data
      const baseTime = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 5; i++) {
        packetLogService.logPacket({
          packet_id: i,
          timestamp: baseTime - i,
          from_node: 111,
          channel: 0,
          portnum: i % 2 === 0 ? 1 : 3,
          encrypted: i % 2 === 0,
          metadata: '{}'
        });
      }
    });

    it('should count all packets', () => {
      const count = packetLogService.getPacketCount();
      expect(count).toBe(5);
    });

    it('should count packets matching filter', () => {
      const encryptedCount = packetLogService.getPacketCount({ encrypted: true });
      expect(encryptedCount).toBe(3);

      const portnumCount = packetLogService.getPacketCount({ portnum: 1 });
      expect(portnumCount).toBe(3);
    });
  });

  describe('Packet Retrieval', () => {
    it('should get packet by ID', () => {
      databaseService.setSetting('packet_log_enabled', '1');

      packetLogService.logPacket({
        packet_id: 99999,
        timestamp: Math.floor(Date.now() / 1000),
        from_node: 111,
        channel: 0,
        portnum: 1,
        encrypted: false,
        metadata: '{}'
      });

      const packets = packetLogService.getPackets({ limit: 10 });
      expect(packets.length).toBeGreaterThan(0);
      const id = packets[0]!.id!; // Non-null assertions for both array element and id property

      const packet = packetLogService.getPacketById(id);
      expect(packet).toBeDefined();
      expect(packet?.packet_id).toBe(99999);
    });

    it('should return null for non-existent packet ID', () => {
      const packet = packetLogService.getPacketById(999999);
      expect(packet).toBeNull();
    });
  });

  describe('Packet Cleanup', () => {
    it('should clear all packets', () => {
      databaseService.setSetting('packet_log_enabled', '1');

      // Add packets
      for (let i = 0; i < 10; i++) {
        packetLogService.logPacket({
          packet_id: i,
          timestamp: Math.floor(Date.now() / 1000),
          from_node: 111,
          channel: 0,
          portnum: 1,
          encrypted: false,
          metadata: '{}'
        });
      }

      expect(packetLogService.getPacketCount()).toBe(10);

      const deletedCount = packetLogService.clearPackets();
      expect(deletedCount).toBe(10);
      expect(packetLogService.getPacketCount()).toBe(0);
    });

    it('should cleanup old packets automatically', () => {
      databaseService.setSetting('packet_log_enabled', '1');

      const oldTime = Math.floor(Date.now() / 1000) - (25 * 60 * 60); // 25 hours ago
      const newTime = Math.floor(Date.now() / 1000);

      // Add old packet
      packetLogService.logPacket({
        packet_id: 1,
        timestamp: oldTime,
        from_node: 111,
        channel: 0,
        portnum: 1,
        encrypted: false,
        metadata: '{}'
      });

      // Add new packet
      packetLogService.logPacket({
        packet_id: 2,
        timestamp: newTime,
        from_node: 111,
        channel: 0,
        portnum: 1,
        encrypted: false,
        metadata: '{}'
      });

      // Run cleanup
      const deletedCount = databaseService.cleanupOldPacketLogs();
      expect(deletedCount).toBeGreaterThanOrEqual(0);

      // Verify old packets are gone but new ones remain
      const remainingPackets = packetLogService.getPackets({ limit: 100 });
      expect(remainingPackets.every(p => p.packet_id !== 1)).toBe(true);
    });
  });

  describe('Service State Management', () => {
    it('should toggle enabled state', () => {
      expect(packetLogService.isEnabled()).toBe(false);

      databaseService.setSetting('packet_log_enabled', '1');
      expect(packetLogService.isEnabled()).toBe(true);

      databaseService.setSetting('packet_log_enabled', '0');
      expect(packetLogService.isEnabled()).toBe(false);
    });

    it('should maintain state across multiple calls', () => {
      databaseService.setSetting('packet_log_enabled', '1');
      expect(packetLogService.isEnabled()).toBe(true);

      // Multiple enable calls should not change state
      databaseService.setSetting('packet_log_enabled', '1');
      expect(packetLogService.isEnabled()).toBe(true);
    });
  });
});
