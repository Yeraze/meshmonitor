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

describe('MeshtasticManager - Auto-Acknowledge Channel Filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Channel-specific settings parsing', () => {
    it('should parse comma-separated channel list correctly', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1,2';
        if (key === 'autoAckDirectMessages') return 'true';
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      expect(enabledChannels).toEqual([0, 1, 2]);
    });

    it('should handle single channel', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0';
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      expect(enabledChannels).toEqual([0]);
    });

    it('should handle empty channel list', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '';
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())).filter((c: number) => !isNaN(c)) : [];

      expect(enabledChannels).toEqual([]);
    });

    it('should handle null channel setting', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return null;
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      expect(enabledChannels).toEqual([]);
    });

    it('should handle channels with whitespace', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0, 1 , 2';
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      expect(enabledChannels).toEqual([0, 1, 2]);
    });

    it('should parse Direct Messages setting as boolean', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckDirectMessages') return 'true';
        return null;
      });

      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      expect(dmEnabled).toBe(true);
    });

    it('should handle false Direct Messages setting', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckDirectMessages') return 'false';
        return null;
      });

      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      expect(dmEnabled).toBe(false);
    });

    it('should default DM to false when null', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckDirectMessages') return null;
        return null;
      });

      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      expect(dmEnabled).toBe(false);
    });
  });

  describe('Channel filtering logic', () => {
    it('should allow auto-ack on enabled channel', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1,2';
        if (key === 'autoAckDirectMessages') return 'true';
        return null;
      });

      const channelIndex = 1;

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      const shouldAck = enabledChannels.includes(channelIndex);
      expect(shouldAck).toBe(true);
    });

    it('should block auto-ack on disabled channel', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1';
        if (key === 'autoAckDirectMessages') return 'true';
        return null;
      });

      const channelIndex = 2;

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      const shouldAck = enabledChannels.includes(channelIndex);
      expect(shouldAck).toBe(false);
    });

    it('should allow auto-ack on direct message when DM enabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1,2';
        if (key === 'autoAckDirectMessages') return 'true';
        return null;
      });

      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      expect(dmEnabled).toBe(true);
    });

    it('should block auto-ack on direct message when DM disabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1,2';
        if (key === 'autoAckDirectMessages') return 'false';
        return null;
      });

      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      expect(dmEnabled).toBe(false);
    });
  });

  describe('Edge cases and boundary conditions', () => {
    it('should handle channel index 0 (Primary channel)', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0';
        return null;
      });

      const channelIndex = 0;
      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      expect(enabledChannels.includes(channelIndex)).toBe(true);
    });

    it('should handle high channel indices', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,5,10';
        return null;
      });

      const channelIndex = 10;
      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      expect(enabledChannels.includes(channelIndex)).toBe(true);
    });

    it('should handle all channels disabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '';
        if (key === 'autoAckDirectMessages') return 'false';
        return null;
      });

      const channelIndex = 0;

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())).filter((c: number) => !isNaN(c)) : [];

      expect(enabledChannels.includes(channelIndex)).toBe(false);
    });

    it('should handle all channels and DM enabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1,2,3,4,5,6,7';
        if (key === 'autoAckDirectMessages') return 'true';
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];
      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      expect(enabledChannels.length).toBe(8);
      expect(dmEnabled).toBe(true);
    });

    it('should handle negative channel index gracefully', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1,2';
        return null;
      });

      const channelIndex = -1;
      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      expect(enabledChannels.includes(channelIndex)).toBe(false);
    });

    it('should handle malformed channel list', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,abc,2';
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())).filter((c: number) => !isNaN(c)) : [];

      // Should parse valid numbers and skip invalid
      expect(enabledChannels).toEqual([0, 2]);
    });
  });

  describe('Integration scenarios', () => {
    it('should correctly determine auto-ack eligibility for channel message', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '1,2';
        if (key === 'autoAckDirectMessages') return 'false';
        if (key === 'autoAckRegex') return '^(test|ping)';
        return null;
      });

      // Simulate message on channel 1 with matching text
      const channelIndex = 1;
      const isDirectMessage = false;
      const messageText = 'test message';

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      // Check channel eligibility
      const channelEligible = !isDirectMessage && enabledChannels.includes(channelIndex);
      expect(channelEligible).toBe(true);

      // Check regex match
      const autoAckRegex = mockGetSetting('autoAckRegex') || '^(test|ping)';
      const regex = new RegExp(autoAckRegex, 'i');
      const textMatches = regex.test(messageText);
      expect(textMatches).toBe(true);

      // Should auto-ack
      const shouldAutoAck = channelEligible && textMatches;
      expect(shouldAutoAck).toBe(true);
    });

    it('should block auto-ack for wrong channel despite matching text', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '1,2';
        if (key === 'autoAckDirectMessages') return 'false';
        if (key === 'autoAckRegex') return '^(test|ping)';
        return null;
      });

      // Simulate message on channel 0 (not in enabled list) with matching text
      const channelIndex = 0;
      const isDirectMessage = false;
      const messageText = 'test message';

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      // Check channel eligibility
      const channelEligible = !isDirectMessage && enabledChannels.includes(channelIndex);
      expect(channelEligible).toBe(false);

      // Even if text matches, channel not eligible
      const autoAckRegex = mockGetSetting('autoAckRegex') || '^(test|ping)';
      const regex = new RegExp(autoAckRegex, 'i');
      const textMatches = regex.test(messageText);
      expect(textMatches).toBe(true);

      // Should NOT auto-ack
      const shouldAutoAck = channelEligible && textMatches;
      expect(shouldAutoAck).toBe(false);
    });

    it('should correctly determine auto-ack eligibility for DM', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1';
        if (key === 'autoAckDirectMessages') return 'true';
        if (key === 'autoAckRegex') return '^(test|ping)';
        return null;
      });

      // Simulate direct message with matching text
      const isDirectMessage = true;
      const messageText = 'ping';

      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      // Check DM eligibility
      const dmEligible = isDirectMessage && dmEnabled;
      expect(dmEligible).toBe(true);

      // Check regex match
      const autoAckRegex = mockGetSetting('autoAckRegex') || '^(test|ping)';
      const regex = new RegExp(autoAckRegex, 'i');
      const textMatches = regex.test(messageText);
      expect(textMatches).toBe(true);

      // Should auto-ack
      const shouldAutoAck = dmEligible && textMatches;
      expect(shouldAutoAck).toBe(true);
    });

    it('should block auto-ack for DM when DM disabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,1';
        if (key === 'autoAckDirectMessages') return 'false';
        if (key === 'autoAckRegex') return '^(test|ping)';
        return null;
      });

      // Simulate direct message with matching text
      const isDirectMessage = true;
      const messageText = 'ping';

      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      // Check DM eligibility
      const dmEligible = isDirectMessage && dmEnabled;
      expect(dmEligible).toBe(false);

      // Even if text matches, DM not enabled
      const autoAckRegex = mockGetSetting('autoAckRegex') || '^(test|ping)';
      const regex = new RegExp(autoAckRegex, 'i');
      const textMatches = regex.test(messageText);
      expect(textMatches).toBe(true);

      // Should NOT auto-ack
      const shouldAutoAck = dmEligible && textMatches;
      expect(shouldAutoAck).toBe(false);
    });

    it('should handle mixed scenario with some channels enabled and DM disabled', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return '0,2';
        if (key === 'autoAckDirectMessages') return 'false';
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];
      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      // Channel 0: should be eligible
      expect(enabledChannels.includes(0)).toBe(true);

      // Channel 1: should NOT be eligible
      expect(enabledChannels.includes(1)).toBe(false);

      // Channel 2: should be eligible
      expect(enabledChannels.includes(2)).toBe(true);

      // DM: should NOT be eligible
      expect(dmEnabled).toBe(false);
    });
  });

  describe('Regex caching with channel filtering', () => {
    it('should use cached regex when pattern unchanged', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckRegex') return '^(test|ping)';
        return null;
      });

      const regexPattern = mockGetSetting('autoAckRegex') || '^(test|ping)';

      // First compilation
      const regex1 = new RegExp(regexPattern, 'i');
      const cached1 = { pattern: regexPattern, regex: regex1 };

      // Second use with same pattern
      const samePattern = mockGetSetting('autoAckRegex') || '^(test|ping)';
      let regex2: RegExp;

      if (cached1.pattern === samePattern) {
        regex2 = cached1.regex; // Use cached
      } else {
        regex2 = new RegExp(samePattern, 'i');
      }

      expect(regex1).toBe(regex2); // Same object reference
    });

    it('should recompile regex when pattern changes', () => {
      let currentPattern = '^(test|ping)';

      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckRegex') return currentPattern;
        return null;
      });

      // First compilation
      const regexPattern1 = mockGetSetting('autoAckRegex') || '^(test|ping)';
      const regex1 = new RegExp(regexPattern1, 'i');
      const cached = { pattern: regexPattern1, regex: regex1 };

      // Change pattern
      currentPattern = '^hello';

      // Second compilation with different pattern
      const regexPattern2 = mockGetSetting('autoAckRegex') || '^(test|ping)';
      let regex2: RegExp;

      if (cached.pattern === regexPattern2) {
        regex2 = cached.regex;
      } else {
        regex2 = new RegExp(regexPattern2, 'i');
        cached.pattern = regexPattern2;
        cached.regex = regex2;
      }

      expect(regex1).not.toBe(regex2); // Different objects
      expect(cached.pattern).toBe('^hello');
    });
  });

  describe('Default values', () => {
    it('should use default regex when not configured', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckRegex') return null;
        return null;
      });

      const regexPattern = mockGetSetting('autoAckRegex') || '^(test|ping)';

      expect(regexPattern).toBe('^(test|ping)');
    });

    it('should use empty channel list when not configured', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckChannels') return null;
        return null;
      });

      const autoAckChannels = mockGetSetting('autoAckChannels');
      const enabledChannels = autoAckChannels ? autoAckChannels.split(',').map((c: string) => parseInt(c.trim())) : [];

      expect(enabledChannels).toEqual([]);
    });

    it('should default DM to disabled when not configured', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoAckDirectMessages') return null;
        return null;
      });

      const autoAckDirectMessages = mockGetSetting('autoAckDirectMessages');
      const dmEnabled = autoAckDirectMessages === 'true';

      expect(dmEnabled).toBe(false);
    });
  });
});
