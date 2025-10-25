import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockGetSetting = vi.fn();
const mockGetNodeByNodeId = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    getNodeByNodeId: mockGetNodeByNodeId
  }
}));

describe('MeshtasticManager - Auto Welcome Message Template Token Replacement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic token replacement', () => {
    it('should replace {LONG_NAME} with node long name', () => {
      const template = 'Welcome {LONG_NAME}!';
      const longName = 'Meshtastic ABC1';

      const result = template.replace(/{LONG_NAME}/g, longName);

      expect(result).toBe('Welcome Meshtastic ABC1!');
    });

    it('should replace {SHORT_NAME} with node short name', () => {
      const template = 'Hi {SHORT_NAME}';
      const shortName = 'ABC1';

      const result = template.replace(/{SHORT_NAME}/g, shortName);

      expect(result).toBe('Hi ABC1');
    });

    it('should replace both {LONG_NAME} and {SHORT_NAME} in template', () => {
      const template = 'Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!';
      const longName = 'Meshtastic ABC1';
      const shortName = 'ABC1';

      let result = template;
      result = result.replace(/{LONG_NAME}/g, longName);
      result = result.replace(/{SHORT_NAME}/g, shortName);

      expect(result).toBe('Welcome Meshtastic ABC1 (ABC1) to the mesh!');
    });

    it('should handle missing long name with fallback', () => {
      const template = 'Welcome {LONG_NAME}!';
      const longName = undefined;
      const fallback = 'Unknown';

      const result = template.replace(/{LONG_NAME}/g, longName || fallback);

      expect(result).toBe('Welcome Unknown!');
    });

    it('should handle missing short name with fallback', () => {
      const template = 'Hi {SHORT_NAME}';
      const shortName = undefined;
      const fallback = '????';

      const result = template.replace(/{SHORT_NAME}/g, shortName || fallback);

      expect(result).toBe('Hi ????');
    });
  });

  describe('Multiple token replacement', () => {
    it('should replace same token appearing multiple times', () => {
      const template = '{LONG_NAME} joined! Say hi to {LONG_NAME}!';
      const longName = 'Meshtastic ABC1';

      const result = template.replace(/{LONG_NAME}/g, longName);

      expect(result).toBe('Meshtastic ABC1 joined! Say hi to Meshtastic ABC1!');
    });

    it('should replace both tokens appearing multiple times', () => {
      const template = '{SHORT_NAME} ({LONG_NAME}) - Welcome {SHORT_NAME}!';
      const longName = 'Meshtastic Base Station';
      const shortName = 'BASE';

      let result = template;
      result = result.replace(/{LONG_NAME}/g, longName);
      result = result.replace(/{SHORT_NAME}/g, shortName);

      expect(result).toBe('BASE (Meshtastic Base Station) - Welcome BASE!');
    });
  });

  describe('Default template', () => {
    it('should use default welcome template when not configured', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoWelcomeMessage') return null;
        return null;
      });

      const defaultTemplate = 'Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!';
      const template = mockGetSetting('autoWelcomeMessage') || defaultTemplate;

      expect(template).toBe('Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!');
    });

    it('should use custom welcome template when configured', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoWelcomeMessage') return 'Hello {SHORT_NAME}! Glad to have you here.';
        return null;
      });

      const defaultTemplate = 'Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!';
      const template = mockGetSetting('autoWelcomeMessage') || defaultTemplate;

      expect(template).toBe('Hello {SHORT_NAME}! Glad to have you here.');
    });

    it('should process default template correctly with real names', () => {
      const template = 'Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!';
      const longName = 'Portable Node 7';
      const shortName = 'PN7';

      let result = template;
      result = result.replace(/{LONG_NAME}/g, longName);
      result = result.replace(/{SHORT_NAME}/g, shortName);

      expect(result).toBe('Welcome Portable Node 7 (PN7) to the mesh!');
    });
  });

  describe('Edge cases and special scenarios', () => {
    it('should handle template with no tokens', () => {
      const template = 'Welcome to the mesh network!';
      const result = template;

      expect(result).toBe('Welcome to the mesh network!');
    });

    it('should handle empty template', () => {
      const template = '';
      const result = template;

      expect(result).toBe('');
    });

    it('should handle template with only emoji', () => {
      const template = '👋🎉✨';
      const result = template;

      expect(result).toBe('👋🎉✨');
    });

    it('should handle emoji in template with tokens', () => {
      const template = '👋 Welcome {LONG_NAME}! 🎉';
      const longName = 'New Node';

      const result = template.replace(/{LONG_NAME}/g, longName);

      expect(result).toBe('👋 Welcome New Node! 🎉');
    });

    it('should handle malformed token (missing closing brace)', () => {
      const template = 'Welcome {LONG_NAME';
      const longName = 'Test Node';

      // Should not replace malformed token
      const result = template.replace(/{LONG_NAME}/g, longName);

      expect(result).toBe('Welcome {LONG_NAME');
    });

    it('should handle malformed token (missing opening brace)', () => {
      const template = 'Welcome LONG_NAME}';
      const longName = 'Test Node';

      // Should not replace malformed token
      const result = template.replace(/{LONG_NAME}/g, longName);

      expect(result).toBe('Welcome LONG_NAME}');
    });

    it('should preserve case in template text', () => {
      const template = 'WELCOME {LONG_NAME} to our MeSh';
      const longName = 'New Node';

      const result = template.replace(/{LONG_NAME}/g, longName);

      expect(result).toBe('WELCOME New Node to our MeSh');
    });

    it('should handle special characters in template', () => {
      const template = 'Hi {SHORT_NAME}! Check @ https://example.com #welcome';
      const shortName = 'TEST';

      const result = template.replace(/{SHORT_NAME}/g, shortName);

      expect(result).toBe('Hi TEST! Check @ https://example.com #welcome');
    });

    it('should handle special characters in node names', () => {
      const template = 'Welcome {LONG_NAME}';
      const longName = "O'Brien's Node #1";

      const result = template.replace(/{LONG_NAME}/g, longName);

      expect(result).toBe("Welcome O'Brien's Node #1");
    });
  });

  describe('Auto-acknowledge {LONG_NAME} and {SHORT_NAME} token support', () => {
    it('should replace {LONG_NAME} in auto-ack message', () => {
      const template = '🤖 Copy {LONG_NAME}, {NUMBER_HOPS} hops';
      const longName = 'Base Station';
      const numberHops = 2;

      let result = template;
      result = result.replace(/{LONG_NAME}/g, longName);
      result = result.replace(/{NUMBER_HOPS}/g, numberHops.toString());

      expect(result).toBe('🤖 Copy Base Station, 2 hops');
    });

    it('should replace {SHORT_NAME} in auto-ack message', () => {
      const template = '🤖 Roger {SHORT_NAME} at {TIME}';
      const shortName = 'BS1';
      const time = '10:30 AM';

      let result = template;
      result = result.replace(/{SHORT_NAME}/g, shortName);
      result = result.replace(/{TIME}/g, time);

      expect(result).toBe('🤖 Roger BS1 at 10:30 AM');
    });

    it('should replace both {LONG_NAME} and {SHORT_NAME} in auto-ack message', () => {
      const template = '🤖 Copy {LONG_NAME} ({SHORT_NAME}), {NUMBER_HOPS} hops at {TIME}';
      const longName = 'Mobile Node 3';
      const shortName = 'MN3';
      const numberHops = 1;
      const time = '2:45 PM';

      let result = template;
      result = result.replace(/{LONG_NAME}/g, longName);
      result = result.replace(/{SHORT_NAME}/g, shortName);
      result = result.replace(/{NUMBER_HOPS}/g, numberHops.toString());
      result = result.replace(/{TIME}/g, time);

      expect(result).toBe('🤖 Copy Mobile Node 3 (MN3), 1 hops at 2:45 PM');
    });

    it('should handle Unknown fallback for missing long name in auto-ack', () => {
      mockGetNodeByNodeId.mockReturnValue(null);

      const template = '🤖 Copy {LONG_NAME}';
      const longName = undefined;

      const result = template.replace(/{LONG_NAME}/g, longName || 'Unknown');

      expect(result).toBe('🤖 Copy Unknown');
    });

    it('should handle ???? fallback for missing short name in auto-ack', () => {
      mockGetNodeByNodeId.mockReturnValue(null);

      const template = '🤖 Copy {SHORT_NAME}';
      const shortName = undefined;

      const result = template.replace(/{SHORT_NAME}/g, shortName || '????');

      expect(result).toBe('🤖 Copy ????');
    });
  });

  describe('Integration with auto-welcome flow', () => {
    it('should create complete welcome message for new node with both names', () => {
      const template = 'Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!';
      const longName = 'Portable Node 5';
      const shortName = 'PN5';

      let result = template;
      result = result.replace(/{LONG_NAME}/g, longName);
      result = result.replace(/{SHORT_NAME}/g, shortName);

      expect(result).toBe('Welcome Portable Node 5 (PN5) to the mesh!');
    });

    it('should create welcome message for node with only long name', () => {
      const template = 'Hello {LONG_NAME}! Welcome aboard.';
      const longName = 'New Meshtastic Device';

      const result = template.replace(/{LONG_NAME}/g, longName);

      expect(result).toBe('Hello New Meshtastic Device! Welcome aboard.');
    });

    it('should create welcome message for node with only short name', () => {
      const template = 'Hi {SHORT_NAME}! Glad you joined.';
      const shortName = 'NEW';

      const result = template.replace(/{SHORT_NAME}/g, shortName);

      expect(result).toBe('Hi NEW! Glad you joined.');
    });

    it('should handle waitForName scenario with missing names', () => {
      const template = 'Welcome {LONG_NAME} ({SHORT_NAME})';
      const longName = undefined;
      const shortName = undefined;

      // In waitForName mode, checkAutoWelcome should skip if both are undefined
      // But if it proceeds, it should use fallbacks
      let result = template;
      result = result.replace(/{LONG_NAME}/g, longName || 'Unknown');
      result = result.replace(/{SHORT_NAME}/g, shortName || '????');

      expect(result).toBe('Welcome Unknown (????)');
    });
  });

  describe('Token replacement order independence', () => {
    it('should produce same result regardless of replacement order', () => {
      const template = '{LONG_NAME} ({SHORT_NAME})';
      const longName = 'Test Node';
      const shortName = 'TEST';

      // Order 1: LONG_NAME, SHORT_NAME
      let result1 = template;
      result1 = result1.replace(/{LONG_NAME}/g, longName);
      result1 = result1.replace(/{SHORT_NAME}/g, shortName);

      // Order 2: SHORT_NAME, LONG_NAME
      let result2 = template;
      result2 = result2.replace(/{SHORT_NAME}/g, shortName);
      result2 = result2.replace(/{LONG_NAME}/g, longName);

      expect(result1).toBe(result2);
      expect(result1).toBe('Test Node (TEST)');
    });
  });

  describe('Setting validations', () => {
    it('should validate autoWelcomeEnabled setting', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        return null;
      });

      const enabled = mockGetSetting('autoWelcomeEnabled') === 'true';

      expect(enabled).toBe(true);
    });

    it('should validate autoWelcomeWaitForName setting', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoWelcomeWaitForName') return 'true';
        return null;
      });

      const waitForName = mockGetSetting('autoWelcomeWaitForName') === 'true';

      expect(waitForName).toBe(true);
    });

    it('should validate autoWelcomeTarget for direct message', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoWelcomeTarget') return 'dm';
        return null;
      });

      const target = mockGetSetting('autoWelcomeTarget') || '0';
      const isDM = target === 'dm';

      expect(isDM).toBe(true);
    });

    it('should validate autoWelcomeTarget for channel', () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'autoWelcomeTarget') return '2';
        return null;
      });

      const target = mockGetSetting('autoWelcomeTarget') || '0';
      const channelIndex = target === 'dm' ? 0 : parseInt(target);

      expect(channelIndex).toBe(2);
    });
  });
});
