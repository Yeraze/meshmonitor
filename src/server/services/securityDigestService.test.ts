import { describe, it, expect } from 'vitest';
import { formatDigestSummary, formatDigestDetailed } from './securityDigestService.js';

describe('securityDigestService', () => {
  const baseUrl = 'https://meshmonitor.example.com';

  describe('formatDigestSummary', () => {
    it('formats summary with counts', () => {
      const issues = {
        total: 5,
        lowEntropyCount: 1,
        duplicateKeyCount: 3,
        excessivePacketsCount: 1,
        timeOffsetCount: 0,
        nodes: [],
        topBroadcasters: [],
      };

      const result = formatDigestSummary(issues, baseUrl);
      expect(result).toContain('Security Digest');
      expect(result).toContain('5 nodes');
      expect(result).toContain('Duplicate PSK: 3');
      expect(result).toContain('Low-Entropy Key: 1');
      expect(result).toContain('Excessive Packets: 1');
      expect(result).toContain('Time Offset: 0');
      expect(result).toContain(baseUrl);
    });

    it('returns null when no issues and suppress is true', () => {
      const issues = {
        total: 0,
        lowEntropyCount: 0,
        duplicateKeyCount: 0,
        excessivePacketsCount: 0,
        timeOffsetCount: 0,
        nodes: [],
        topBroadcasters: [],
      };

      const result = formatDigestSummary(issues, baseUrl, true);
      expect(result).toBeNull();
    });

    it('returns message when no issues and suppress is false', () => {
      const issues = {
        total: 0,
        lowEntropyCount: 0,
        duplicateKeyCount: 0,
        excessivePacketsCount: 0,
        timeOffsetCount: 0,
        nodes: [],
        topBroadcasters: [],
      };

      const result = formatDigestSummary(issues, baseUrl, false);
      expect(result).toContain('No security issues');
    });
  });

  describe('formatDigestDetailed', () => {
    it('formats detailed report with node names grouped by issue', () => {
      const issues = {
        total: 3,
        lowEntropyCount: 1,
        duplicateKeyCount: 2,
        excessivePacketsCount: 0,
        timeOffsetCount: 0,
        nodes: [
          { nodeNum: 0x11111111, shortName: 'ALPH', longName: 'NodeAlpha', duplicateKeyDetected: true, publicKey: 'key1', keyIsLowEntropy: false, isExcessivePackets: false, isTimeOffsetIssue: false, keySecurityIssueDetails: null, packetRatePerHour: null, timeOffsetSeconds: null },
          { nodeNum: 0x22222222, shortName: 'BETA', longName: 'NodeBeta', duplicateKeyDetected: true, publicKey: 'key1', keyIsLowEntropy: false, isExcessivePackets: false, isTimeOffsetIssue: false, keySecurityIssueDetails: null, packetRatePerHour: null, timeOffsetSeconds: null },
          { nodeNum: 0x33333333, shortName: 'GAMM', longName: 'NodeGamma', duplicateKeyDetected: false, publicKey: 'key2', keyIsLowEntropy: true, isExcessivePackets: false, isTimeOffsetIssue: false, keySecurityIssueDetails: null, packetRatePerHour: null, timeOffsetSeconds: null },
        ],
        topBroadcasters: [],
      };

      const result = formatDigestDetailed(issues, baseUrl);
      expect(result).not.toBeNull();
      expect(result).toContain('NodeAlpha');
      expect(result).toContain('NodeBeta');
      expect(result).toContain('Group 1');
      expect(result).toContain('NodeGamma');
      expect(result).toContain('Low-Entropy Key');
    });

    it('shows excessive packets with rates', () => {
      const issues = {
        total: 1,
        lowEntropyCount: 0,
        duplicateKeyCount: 0,
        excessivePacketsCount: 1,
        timeOffsetCount: 0,
        nodes: [
          { nodeNum: 0x44444444, shortName: 'SPAM', longName: 'SpamNode', duplicateKeyDetected: false, publicKey: null, keyIsLowEntropy: false, isExcessivePackets: true, isTimeOffsetIssue: false, keySecurityIssueDetails: null, packetRatePerHour: 150, timeOffsetSeconds: null },
        ],
        topBroadcasters: [],
      };

      const result = formatDigestDetailed(issues, baseUrl);
      expect(result).toContain('SpamNode');
      expect(result).toContain('150 pkt/hr');
    });

    it('shows time offset with drift', () => {
      const issues = {
        total: 1,
        lowEntropyCount: 0,
        duplicateKeyCount: 0,
        excessivePacketsCount: 0,
        timeOffsetCount: 1,
        nodes: [
          { nodeNum: 0x55555555, shortName: 'DRFT', longName: 'DriftNode', duplicateKeyDetected: false, publicKey: null, keyIsLowEntropy: false, isExcessivePackets: false, isTimeOffsetIssue: true, keySecurityIssueDetails: null, packetRatePerHour: null, timeOffsetSeconds: -3600 },
        ],
        topBroadcasters: [],
      };

      const result = formatDigestDetailed(issues, baseUrl);
      expect(result).toContain('DriftNode');
      expect(result).toContain('3600s drift');
    });
  });
});
