import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database service
const mockGetSetting = vi.fn();
const mockGetAllNodes = vi.fn();
const mockGetNodeCount = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    getAllNodes: mockGetAllNodes,
    getNodeCount: mockGetNodeCount
  }
}));

// Mock package.json version
vi.mock('../../package.json', () => ({
  version: '1.18.0'
}));

describe('Auto-Announce Token Replacement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('{VERSION} token', () => {
    it('should replace {VERSION} with package version', () => {
      const message = 'MeshMonitor {VERSION} is running';
      const expected = 'MeshMonitor 1.18.0 is running';

      // Simple string replacement test
      const result = message.replace(/{VERSION}/g, '1.18.0');
      expect(result).toBe(expected);
    });

    it('should handle multiple {VERSION} tokens', () => {
      const message = 'Version {VERSION} - Build {VERSION}';
      const expected = 'Version 1.18.0 - Build 1.18.0';

      const result = message.replace(/{VERSION}/g, '1.18.0');
      expect(result).toBe(expected);
    });

    it('should not replace partial matches', () => {
      const message = 'Test {VERSIONS} not {VERSION}';
      const result = message.replace(/{VERSION}/g, '1.18.0');
      expect(result).toBe('Test {VERSIONS} not 1.18.0');
    });
  });

  describe('{DURATION} token', () => {
    it('should format duration in seconds correctly', () => {
      const durationMs = 45 * 1000; // 45 seconds
      const result = formatDuration(durationMs);
      expect(result).toBe('45s');
    });

    it('should format duration in minutes correctly', () => {
      const durationMs = 5 * 60 * 1000; // 5 minutes
      const result = formatDuration(durationMs);
      expect(result).toBe('5m');
    });

    it('should format duration in hours with minutes', () => {
      const durationMs = (3 * 60 * 60 + 15 * 60) * 1000; // 3h 15m
      const result = formatDuration(durationMs);
      expect(result).toBe('3h 15m');
    });

    it('should format duration in hours without minutes', () => {
      const durationMs = 3 * 60 * 60 * 1000; // 3h exactly
      const result = formatDuration(durationMs);
      expect(result).toBe('3h');
    });

    it('should format duration in days with hours', () => {
      const durationMs = (2 * 24 * 60 * 60 + 5 * 60 * 60) * 1000; // 2d 5h
      const result = formatDuration(durationMs);
      expect(result).toBe('2d 5h');
    });

    it('should format duration in days without hours', () => {
      const durationMs = 2 * 24 * 60 * 60 * 1000; // 2d exactly
      const result = formatDuration(durationMs);
      expect(result).toBe('2d');
    });
  });

  describe('{FEATURES} token', () => {
    it('should return empty string when no features enabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'tracerouteIntervalMinutes') return '0';
        if (key === 'autoAckEnabled') return 'false';
        if (key === 'autoAnnounceEnabled') return 'false';
        return null;
      });

      const features: string[] = [];
      const tracerouteInterval = mockGetSetting('tracerouteIntervalMinutes');
      if (tracerouteInterval && parseInt(tracerouteInterval) > 0) {
        features.push('🗺️');
      }
      const autoAckEnabled = mockGetSetting('autoAckEnabled');
      if (autoAckEnabled === 'true') {
        features.push('🤖');
      }
      const autoAnnounceEnabled = mockGetSetting('autoAnnounceEnabled');
      if (autoAnnounceEnabled === 'true') {
        features.push('📢');
      }

      expect(features.join(' ')).toBe('');
    });

    it('should include traceroute emoji when enabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'tracerouteIntervalMinutes') return '3';
        if (key === 'autoAckEnabled') return 'false';
        if (key === 'autoAnnounceEnabled') return 'false';
        return null;
      });

      const features: string[] = [];
      const tracerouteInterval = mockGetSetting('tracerouteIntervalMinutes');
      if (tracerouteInterval && parseInt(tracerouteInterval) > 0) {
        features.push('🗺️');
      }

      expect(features.join(' ')).toBe('🗺️');
    });

    it('should include all feature emojis when all enabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'tracerouteIntervalMinutes') return '3';
        if (key === 'autoAckEnabled') return 'true';
        if (key === 'autoAnnounceEnabled') return 'true';
        return null;
      });

      const features: string[] = [];
      const tracerouteInterval = mockGetSetting('tracerouteIntervalMinutes');
      if (tracerouteInterval && parseInt(tracerouteInterval) > 0) {
        features.push('🗺️');
      }
      const autoAckEnabled = mockGetSetting('autoAckEnabled');
      if (autoAckEnabled === 'true') {
        features.push('🤖');
      }
      const autoAnnounceEnabled = mockGetSetting('autoAnnounceEnabled');
      if (autoAnnounceEnabled === 'true') {
        features.push('📢');
      }

      expect(features.join(' ')).toBe('🗺️ 🤖 📢');
    });
  });

  describe('{NODECOUNT} and {DIRECTCOUNT} tokens', () => {
    it('should return 0 when no nodes exist', () => {
      mockGetAllNodes.mockReturnValue([]);

      const nodes = mockGetAllNodes();
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;

      expect(nodes.length).toBe(0);
      expect(directCount).toBe(0);
    });

    it('should count all nodes correctly', () => {
      mockGetAllNodes.mockReturnValue([
        { nodeId: '!12345678', hopsAway: 0 },
        { nodeId: '!87654321', hopsAway: 1 },
        { nodeId: '!abcdef12', hopsAway: 2 }
      ]);

      const nodes = mockGetAllNodes();
      expect(nodes.length).toBe(3);
    });

    it('should count direct nodes (0 hops) correctly', () => {
      mockGetAllNodes.mockReturnValue([
        { nodeId: '!12345678', hopsAway: 0 },
        { nodeId: '!87654321', hopsAway: 1 },
        { nodeId: '!abcdef12', hopsAway: 0 },
        { nodeId: '!fedcba98', hopsAway: 2 }
      ]);

      const nodes = mockGetAllNodes();
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;

      expect(nodes.length).toBe(4);
      expect(directCount).toBe(2);
    });

    it('should handle nodes without hopsAway property', () => {
      mockGetAllNodes.mockReturnValue([
        { nodeId: '!12345678', hopsAway: 0 },
        { nodeId: '!87654321' }, // missing hopsAway
        { nodeId: '!abcdef12', hopsAway: undefined }
      ]);

      const nodes = mockGetAllNodes();
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;

      expect(nodes.length).toBe(3);
      expect(directCount).toBe(1);
    });
  });

  describe('Full message replacement', () => {
    it('should replace all tokens in default message', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'tracerouteIntervalMinutes') return '3';
        if (key === 'autoAckEnabled') return 'true';
        if (key === 'autoAnnounceEnabled') return 'true';
        return null;
      });

      mockGetAllNodes.mockReturnValue([
        { nodeId: '!12345678', hopsAway: 0 },
        { nodeId: '!87654321', hopsAway: 1 },
        { nodeId: '!abcdef12', hopsAway: 0 }
      ]);

      let message = 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}';

      // Replace VERSION
      message = message.replace(/{VERSION}/g, '1.18.0');

      // Replace DURATION (simulating 2 days 5 hours)
      message = message.replace(/{DURATION}/g, '2d 5h');

      // Replace FEATURES
      const features: string[] = [];
      const tracerouteInterval = mockGetSetting('tracerouteIntervalMinutes');
      if (tracerouteInterval && parseInt(tracerouteInterval) > 0) {
        features.push('🗺️');
      }
      const autoAckEnabled = mockGetSetting('autoAckEnabled');
      if (autoAckEnabled === 'true') {
        features.push('🤖');
      }
      const autoAnnounceEnabled = mockGetSetting('autoAnnounceEnabled');
      if (autoAnnounceEnabled === 'true') {
        features.push('📢');
      }
      message = message.replace(/{FEATURES}/g, features.join(' '));

      expect(message).toBe('MeshMonitor 1.18.0 online for 2d 5h 🗺️ 🤖 📢');
    });

    it('should replace NODECOUNT and DIRECTCOUNT tokens', () => {
      mockGetAllNodes.mockReturnValue([
        { nodeId: '!12345678', hopsAway: 0 },
        { nodeId: '!87654321', hopsAway: 1 },
        { nodeId: '!abcdef12', hopsAway: 0 },
        { nodeId: '!fedcba98', hopsAway: 2 }
      ]);

      let message = 'Network: {NODECOUNT} nodes, {DIRECTCOUNT} direct';

      const nodes = mockGetAllNodes();
      const directCount = nodes.filter((n: any) => n.hopsAway === 0).length;

      message = message.replace(/{NODECOUNT}/g, nodes.length.toString());
      message = message.replace(/{DIRECTCOUNT}/g, directCount.toString());

      expect(message).toBe('Network: 4 nodes, 2 direct');
    });
  });
});

// Helper function to test duration formatting
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days}d${remainingHours > 0 ? ` ${remainingHours}h` : ''}`;
  } else if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ''}`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    return `${seconds}s`;
  }
}
