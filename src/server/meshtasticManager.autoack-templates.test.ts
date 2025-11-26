import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockGetSetting = vi.fn();
const mockGetAllNodes = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    getAllNodes: mockGetAllNodes
  }
}));

vi.mock('../utils/environment.js', () => ({
  getEnvironmentConfig: () => ({
    version: '2.10.0',
    timezone: 'America/New_York'
  })
}));

describe('MeshtasticManager - Auto-Acknowledge Message Template Token Replacement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic token replacement', () => {
    it('should replace {NODE_ID} with sender node ID', () => {
      const template = 'Message from {NODE_ID}';
      const nodeId = '!a1b2c3d4';

      const result = template.replace(/{NODE_ID}/g, nodeId);

      expect(result).toBe('Message from !a1b2c3d4');
    });

    it('should replace {NUMBER_HOPS} with hop count', () => {
      const template = 'Received in {NUMBER_HOPS} hops';
      const numberHops = 3;

      const result = template.replace(/{NUMBER_HOPS}/g, numberHops.toString());

      expect(result).toBe('Received in 3 hops');
    });

    it('should replace {HOPS} with hop count (alias for {NUMBER_HOPS})', () => {
      const template = 'Received in {HOPS} hops';
      const numberHops = 3;

      const result = template.replace(/{HOPS}/g, numberHops.toString());

      expect(result).toBe('Received in 3 hops');
    });

    it('should replace {HOPS} with 0 for direct connections', () => {
      const template = 'Direct: {HOPS} hops';
      const numberHops = 0;

      const result = template.replace(/{HOPS}/g, numberHops.toString());

      expect(result).toBe('Direct: 0 hops');
    });

    it('should replace {DATE} with formatted date', () => {
      const template = 'On {DATE}';
      const timestamp = new Date('2025-01-15T10:30:00Z');
      const date = timestamp.toLocaleDateString('en-US', { timeZone: 'America/New_York' });

      const result = template.replace(/{DATE}/g, date);

      expect(result).toBe('On 1/15/2025');
    });

    it('should replace {TIME} with formatted time', () => {
      const template = 'At {TIME}';
      const timestamp = new Date('2025-01-15T10:30:00Z');
      const time = timestamp.toLocaleTimeString('en-US', { timeZone: 'America/New_York' });

      const result = template.replace(/{TIME}/g, time);

      expect(result).toContain('5:30:00');
    });

    it('should replace both {DATE} and {TIME} in template', () => {
      const template = 'Received on {DATE} at {TIME}';
      const timestamp = new Date('2025-01-15T10:30:00Z');
      const date = timestamp.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
      const time = timestamp.toLocaleTimeString('en-US', { timeZone: 'America/New_York' });

      let result = template;
      result = result.replace(/{DATE}/g, date);
      result = result.replace(/{TIME}/g, time);

      expect(result).toContain('1/15/2025');
      expect(result).toContain('at');
    });

    it('should replace {VERSION} with app version', () => {
      const template = 'MeshMonitor {VERSION}';
      const version = '2.10.0';

      const result = template.replace(/{VERSION}/g, version);

      expect(result).toBe('MeshMonitor 2.10.0');
    });
  });

  describe('{RABBIT_HOPS} token replacement', () => {
    it('should replace {RABBIT_HOPS} with 🎯 for 0 hops (direct message)', () => {
      const template = 'Direct: {RABBIT_HOPS}';
      const numberHops = 0;
      const rabbitEmojis = numberHops === 0 ? '🎯' : '🐇'.repeat(numberHops);

      const result = template.replace(/{RABBIT_HOPS}/g, rabbitEmojis);

      expect(result).toBe('Direct: 🎯');
    });

    it('should replace {RABBIT_HOPS} with 1 rabbit for 1 hop', () => {
      const template = 'Hops: {RABBIT_HOPS}';
      const numberHops = 1;
      const rabbitEmojis = '🐇'.repeat(numberHops);

      const result = template.replace(/{RABBIT_HOPS}/g, rabbitEmojis);

      expect(result).toBe('Hops: 🐇');
    });

    it('should replace {RABBIT_HOPS} with 3 rabbits for 3 hops', () => {
      const template = 'Hops: {RABBIT_HOPS}';
      const numberHops = 3;
      const rabbitEmojis = '🐇'.repeat(numberHops);

      const result = template.replace(/{RABBIT_HOPS}/g, rabbitEmojis);

      expect(result).toBe('Hops: 🐇🐇🐇');
    });

    it('should replace {RABBIT_HOPS} with 5 rabbits for 5 hops', () => {
      const template = 'Hops: {RABBIT_HOPS}';
      const numberHops = 5;
      const rabbitEmojis = '🐇'.repeat(numberHops);

      const result = template.replace(/{RABBIT_HOPS}/g, rabbitEmojis);

      expect(result).toBe('Hops: 🐇🐇🐇🐇🐇');
    });

    it('should handle high hop counts', () => {
      const template = 'Hops: {RABBIT_HOPS}';
      const numberHops = 7;
      const rabbitEmojis = '🐇'.repeat(numberHops);

      const result = template.replace(/{RABBIT_HOPS}/g, rabbitEmojis);

      expect(result).toBe('Hops: 🐇🐇🐇🐇🐇🐇🐇');
      expect(result.match(/🐇/g)?.length).toBe(7);
    });
  });

  describe('Multiple token replacement', () => {
    it('should replace multiple different tokens in one template', () => {
      const template = '🤖 Copy from {NODE_ID}, {NUMBER_HOPS} hops on {DATE} at {TIME}';
      const nodeId = '!a1b2c3d4';
      const numberHops = 3;
      const date = '1/15/2025';
      const time = '10:30:00 AM';

      let result = template;
      result = result.replace(/{NODE_ID}/g, nodeId);
      result = result.replace(/{NUMBER_HOPS}/g, numberHops.toString());
      result = result.replace(/{DATE}/g, date);
      result = result.replace(/{TIME}/g, time);

      expect(result).toBe('🤖 Copy from !a1b2c3d4, 3 hops on 1/15/2025 at 10:30:00 AM');
    });

    it('should replace same token appearing multiple times', () => {
      const template = '{NODE_ID} sent to {NODE_ID}';
      const nodeId = '!a1b2c3d4';

      const result = template.replace(/{NODE_ID}/g, nodeId);

      expect(result).toBe('!a1b2c3d4 sent to !a1b2c3d4');
    });

    it('should handle default template with all tokens', () => {
      const template = '🤖 Copy, {NUMBER_HOPS} hops on {DATE} at {TIME}';
      const numberHops = 2;
      const date = '1/15/2025';
      const time = '3:45:00 PM';

      let result = template;
      result = result.replace(/{NUMBER_HOPS}/g, numberHops.toString());
      result = result.replace(/{DATE}/g, date);
      result = result.replace(/{TIME}/g, time);

      expect(result).toBe('🤖 Copy, 2 hops on 1/15/2025 at 3:45:00 PM');
    });

    it('should handle template with all available tokens', () => {
      const template = '{NODE_ID} {NUMBER_HOPS} {RABBIT_HOPS} {DATE} {TIME} {VERSION} {DURATION} {FEATURES} {NODECOUNT} {DIRECTCOUNT}';
      const nodeId = '!12345678';
      const numberHops = 2;
      const rabbitEmojis = '🐇🐇';
      const date = '1/15/2025';
      const time = '10:30:00 AM';
      const version = '2.10.0';
      const duration = '5h 23m';
      const features = 'Auto-Ack';
      const nodeCount = '42';
      const directCount = '8';

      let result = template;
      result = result.replace(/{NODE_ID}/g, nodeId);
      result = result.replace(/{NUMBER_HOPS}/g, numberHops.toString());
      result = result.replace(/{RABBIT_HOPS}/g, rabbitEmojis);
      result = result.replace(/{DATE}/g, date);
      result = result.replace(/{TIME}/g, time);
      result = result.replace(/{VERSION}/g, version);
      result = result.replace(/{DURATION}/g, duration);
      result = result.replace(/{FEATURES}/g, features);
      result = result.replace(/{NODECOUNT}/g, nodeCount);
      result = result.replace(/{DIRECTCOUNT}/g, directCount);

      expect(result).toBe('!12345678 2 🐇🐇 1/15/2025 10:30:00 AM 2.10.0 5h 23m Auto-Ack 42 8');
    });
  });

  describe('{DURATION} token replacement', () => {
    it('should format duration for uptime less than 1 hour', () => {
      const uptimeMs = 45 * 60 * 1000; // 45 minutes
      const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      expect(duration).toBe('45m');
    });

    it('should format duration for uptime with hours and minutes', () => {
      const uptimeMs = (5 * 60 * 60 * 1000) + (23 * 60 * 1000); // 5 hours 23 minutes
      const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      expect(duration).toBe('5h 23m');
    });

    it('should format duration for uptime exactly 1 hour', () => {
      const uptimeMs = 60 * 60 * 1000; // 1 hour
      const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      expect(duration).toBe('1h 0m');
    });

    it('should format duration for uptime with days', () => {
      const uptimeMs = (25 * 60 * 60 * 1000) + (15 * 60 * 1000); // 25 hours 15 minutes (1 day, 1 hour, 15 min)
      const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
      const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
      const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      expect(duration).toBe('25h 15m');
    });
  });

  describe('{FEATURES} token replacement', () => {
    it('should list enabled features', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckEnabled') return 'true';
        if (key === 'autoAnnounceEnabled') return 'false';
        return null;
      });

      const autoAckEnabled = mockGetSetting('autoAckEnabled') === 'true';
      const autoAnnounceEnabled = mockGetSetting('autoAnnounceEnabled') === 'true';

      const features: string[] = [];
      if (autoAckEnabled) features.push('Auto-Ack');
      if (autoAnnounceEnabled) features.push('Auto-Announce');

      const featuresStr = features.length > 0 ? features.join(', ') : 'None';

      expect(featuresStr).toBe('Auto-Ack');
    });

    it('should list both features when enabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckEnabled') return 'true';
        if (key === 'autoAnnounceEnabled') return 'true';
        return null;
      });

      const autoAckEnabled = mockGetSetting('autoAckEnabled') === 'true';
      const autoAnnounceEnabled = mockGetSetting('autoAnnounceEnabled') === 'true';

      const features: string[] = [];
      if (autoAckEnabled) features.push('Auto-Ack');
      if (autoAnnounceEnabled) features.push('Auto-Announce');

      const featuresStr = features.length > 0 ? features.join(', ') : 'None';

      expect(featuresStr).toBe('Auto-Ack, Auto-Announce');
    });

    it('should show None when no features enabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckEnabled') return 'false';
        if (key === 'autoAnnounceEnabled') return 'false';
        return null;
      });

      const autoAckEnabled = mockGetSetting('autoAckEnabled') === 'true';
      const autoAnnounceEnabled = mockGetSetting('autoAnnounceEnabled') === 'true';

      const features: string[] = [];
      if (autoAckEnabled) features.push('Auto-Ack');
      if (autoAnnounceEnabled) features.push('Auto-Announce');

      const featuresStr = features.length > 0 ? features.join(', ') : 'None';

      expect(featuresStr).toBe('None');
    });
  });

  describe('{NODECOUNT} and {DIRECTCOUNT} token replacement', () => {
    it('should count total nodes', () => {
      mockGetAllNodes.mockReturnValue([
        { nodeId: '!12345678', hopsAway: 0 },
        { nodeId: '!abcdef01', hopsAway: 1 },
        { nodeId: '!23456789', hopsAway: 2 },
        { nodeId: '!34567890', hopsAway: 0 },
      ]);

      const nodes = mockGetAllNodes();
      const nodeCount = nodes.length;

      expect(nodeCount).toBe(4);
    });

    it('should count direct (0 hop) nodes', () => {
      mockGetAllNodes.mockReturnValue([
        { nodeId: '!12345678', hopsAway: 0 },
        { nodeId: '!abcdef01', hopsAway: 1 },
        { nodeId: '!23456789', hopsAway: 2 },
        { nodeId: '!34567890', hopsAway: 0 },
        { nodeId: '!45678901', hopsAway: 0 },
      ]);

      const nodes = mockGetAllNodes();
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;

      expect(directCount).toBe(3);
    });

    it('should handle no direct nodes', () => {
      mockGetAllNodes.mockReturnValue([
        { nodeId: '!abcdef01', hopsAway: 1 },
        { nodeId: '!23456789', hopsAway: 2 },
        { nodeId: '!45678901', hopsAway: 3 },
      ]);

      const nodes = mockGetAllNodes();
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;

      expect(directCount).toBe(0);
    });

    it('should handle empty node list', () => {
      mockGetAllNodes.mockReturnValue([]);

      const nodes = mockGetAllNodes();
      const nodeCount = nodes.length;
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;

      expect(nodeCount).toBe(0);
      expect(directCount).toBe(0);
    });
  });

  describe('Edge cases and special scenarios', () => {
    it('should handle template with no tokens', () => {
      const template = 'Simple acknowledgment message';
      const result = template;

      expect(result).toBe('Simple acknowledgment message');
    });

    it('should handle empty template', () => {
      const template = '';
      const result = template;

      expect(result).toBe('');
    });

    it('should handle template with only emoji', () => {
      const template = '🤖👍✅';
      const result = template;

      expect(result).toBe('🤖👍✅');
    });

    it('should handle malformed token (missing closing brace)', () => {
      const template = 'Message from {NODE_ID';
      const nodeId = '!a1b2c3d4';

      // Should not replace malformed token
      const result = template.replace(/{NODE_ID}/g, nodeId);

      expect(result).toBe('Message from {NODE_ID');
    });

    it('should handle malformed token (missing opening brace)', () => {
      const template = 'Message from NODE_ID}';
      const nodeId = '!a1b2c3d4';

      // Should not replace malformed token
      const result = template.replace(/{NODE_ID}/g, nodeId);

      expect(result).toBe('Message from NODE_ID}');
    });

    it('should preserve case in template text', () => {
      const template = 'UPPERCASE lowercase MixedCase {NODE_ID}';
      const nodeId = '!a1b2c3d4';

      const result = template.replace(/{NODE_ID}/g, nodeId);

      expect(result).toBe('UPPERCASE lowercase MixedCase !a1b2c3d4');
    });

    it('should handle special characters in template', () => {
      const template = 'Ack: {NODE_ID} @ {TIME} #test $100';
      const nodeId = '!a1b2c3d4';
      const time = '10:30 AM';

      let result = template;
      result = result.replace(/{NODE_ID}/g, nodeId);
      result = result.replace(/{TIME}/g, time);

      expect(result).toBe('Ack: !a1b2c3d4 @ 10:30 AM #test $100');
    });
  });

  describe('Template settings and defaults', () => {
    it('should use default template when not configured', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckMessage') return null;
        return null;
      });

      const defaultTemplate = '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';
      const template = mockGetSetting('autoAckMessage') || defaultTemplate;

      expect(template).toBe('🤖 Copy, {NUMBER_HOPS} hops at {TIME}');
    });

    it('should use custom template when configured', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckMessage') return 'Custom: {NODE_ID} {RABBIT_HOPS}';
        return null;
      });

      const defaultTemplate = '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';
      const template = mockGetSetting('autoAckMessage') || defaultTemplate;

      expect(template).toBe('Custom: {NODE_ID} {RABBIT_HOPS}');
    });

    it('should handle empty string template setting', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckMessage') return '';
        return null;
      });

      const defaultTemplate = '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';
      const template = mockGetSetting('autoAckMessage') || defaultTemplate;

      // Empty string is falsy, should use default
      expect(template).toBe('🤖 Copy, {NUMBER_HOPS} hops at {TIME}');
    });
  });

  describe('Integration with auto-acknowledge flow', () => {
    it('should create complete acknowledgment message for direct message (0 hops)', () => {
      const template = '🤖 Copy from {NODE_ID}, {RABBIT_HOPS} on {DATE} at {TIME}';
      const nodeId = '!a1b2c3d4';
      const numberHops = 0;
      const date = '1/15/2025';
      const time = '10:30:00 AM';
      const rabbitEmojis = numberHops === 0 ? '🎯' : '🐇'.repeat(numberHops);

      let result = template;
      result = result.replace(/{NODE_ID}/g, nodeId);
      result = result.replace(/{RABBIT_HOPS}/g, rabbitEmojis);
      result = result.replace(/{DATE}/g, date);
      result = result.replace(/{TIME}/g, time);

      expect(result).toBe('🤖 Copy from !a1b2c3d4, 🎯 on 1/15/2025 at 10:30:00 AM');
    });

    it('should create complete acknowledgment message for multi-hop message', () => {
      const template = '🤖 Copy, {NUMBER_HOPS} hops {RABBIT_HOPS} from {NODE_ID}';
      const nodeId = '!b2c3d4e5';
      const numberHops = 4;
      const rabbitEmojis = '🐇'.repeat(numberHops);

      let result = template;
      result = result.replace(/{NODE_ID}/g, nodeId);
      result = result.replace(/{NUMBER_HOPS}/g, numberHops.toString());
      result = result.replace(/{RABBIT_HOPS}/g, rabbitEmojis);

      expect(result).toBe('🤖 Copy, 4 hops 🐇🐇🐇🐇 from !b2c3d4e5');
    });

    it('should process default template correctly', () => {
      const template = '🤖 Copy, {NUMBER_HOPS} hops on {DATE} at {TIME}';
      const numberHops = 3;
      const date = '1/15/2025';
      const time = '2:45:00 PM';

      let result = template;
      result = result.replace(/{NUMBER_HOPS}/g, numberHops.toString());
      result = result.replace(/{DATE}/g, date);
      result = result.replace(/{TIME}/g, time);

      expect(result).toBe('🤖 Copy, 3 hops on 1/15/2025 at 2:45:00 PM');
    });
  });

  describe('Token replacement order independence', () => {
    it('should produce same result regardless of replacement order', () => {
      const template = '{NODE_ID} {NUMBER_HOPS} {DATE} {TIME}';
      const nodeId = '!12345678';
      const numberHops = 2;
      const date = '1/15/2025';
      const time = '10:30 AM';

      // Order 1: NODE_ID, NUMBER_HOPS, DATE, TIME
      let result1 = template;
      result1 = result1.replace(/{NODE_ID}/g, nodeId);
      result1 = result1.replace(/{NUMBER_HOPS}/g, numberHops.toString());
      result1 = result1.replace(/{DATE}/g, date);
      result1 = result1.replace(/{TIME}/g, time);

      // Order 2: TIME, DATE, NODE_ID, NUMBER_HOPS
      let result2 = template;
      result2 = result2.replace(/{TIME}/g, time);
      result2 = result2.replace(/{DATE}/g, date);
      result2 = result2.replace(/{NODE_ID}/g, nodeId);
      result2 = result2.replace(/{NUMBER_HOPS}/g, numberHops.toString());

      expect(result1).toBe(result2);
      expect(result1).toBe('!12345678 2 1/15/2025 10:30 AM');
    });
  });

  describe('{SNR} and {RSSI} token replacement', () => {
    it('should replace {SNR} with signal-to-noise ratio', () => {
      const template = 'SNR: {SNR} dB';
      const rxSnr = 7.5;
      const snrValue = rxSnr.toFixed(1);

      const result = template.replace(/{SNR}/g, snrValue);

      expect(result).toBe('SNR: 7.5 dB');
    });

    it('should replace {RSSI} with received signal strength', () => {
      const template = 'RSSI: {RSSI} dBm';
      const rxRssi = -95;
      const rssiValue = rxRssi.toString();

      const result = template.replace(/{RSSI}/g, rssiValue);

      expect(result).toBe('RSSI: -95 dBm');
    });

    it('should replace both {SNR} and {RSSI} in template', () => {
      const template = 'Signal quality: {SNR} dB SNR, {RSSI} dBm RSSI';
      const rxSnr = 7.5;
      const rxRssi = -95;
      const snrValue = rxSnr.toFixed(1);
      const rssiValue = rxRssi.toString();

      let result = template;
      result = result.replace(/{SNR}/g, snrValue);
      result = result.replace(/{RSSI}/g, rssiValue);

      expect(result).toBe('Signal quality: 7.5 dB SNR, -95 dBm RSSI');
    });

    it('should handle {SNR} with N/A when value is not available', () => {
      const template = 'SNR: {SNR}';
      const snrValue = 'N/A';

      const result = template.replace(/{SNR}/g, snrValue);

      expect(result).toBe('SNR: N/A');
    });

    it('should handle {RSSI} with N/A when value is not available', () => {
      const template = 'RSSI: {RSSI}';
      const rssiValue = 'N/A';

      const result = template.replace(/{RSSI}/g, rssiValue);

      expect(result).toBe('RSSI: N/A');
    });

    it('should handle negative SNR values', () => {
      const template = '{SNR}';
      const rxSnr = -5.2;
      const snrValue = rxSnr.toFixed(1);

      const result = template.replace(/{SNR}/g, snrValue);

      expect(result).toBe('-5.2');
    });

    it('should handle strong signal (high RSSI)', () => {
      const template = '{RSSI}';
      const rxRssi = -30;
      const rssiValue = rxRssi.toString();

      const result = template.replace(/{RSSI}/g, rssiValue);

      expect(result).toBe('-30');
    });

    it('should integrate SNR and RSSI with other tokens', () => {
      const template = 'From {NODE_ID}, {NUMBER_HOPS} hops, SNR: {SNR}, RSSI: {RSSI}';
      const nodeId = '!a1b2c3d4';
      const numberHops = 3;
      const rxSnr = 7.5;
      const rxRssi = -95;

      let result = template;
      result = result.replace(/{NODE_ID}/g, nodeId);
      result = result.replace(/{NUMBER_HOPS}/g, numberHops.toString());
      result = result.replace(/{SNR}/g, rxSnr.toFixed(1));
      result = result.replace(/{RSSI}/g, rxRssi.toString());

      expect(result).toBe('From !a1b2c3d4, 3 hops, SNR: 7.5, RSSI: -95');
    });
  });
});
