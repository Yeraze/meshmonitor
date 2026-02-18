import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// Mock the database service
vi.mock('../services/database.js', () => ({
  default: {
    getSetting: vi.fn(),
    getNode: vi.fn(),
    getActiveNodes: vi.fn(),
    upsertNode: vi.fn(),
    setSetting: vi.fn(),
    markNodeAsWelcomedIfNotAlready: vi.fn(),
  },
}));

// Mock the meshtasticProtobufService
vi.mock('../services/meshtasticProtobufService.js', () => ({
  default: {
    createTextMessage: vi.fn(() => ({
      data: new Uint8Array([1, 2, 3]),
      messageId: 12345,
    })),
  },
}));

describe('MeshtasticManager - Auto Welcome Integration', () => {
  let manager: MeshtasticManager;
  let mockTransport: any;

  beforeEach(() => {
    vi.clearAllMocks();

    manager = new MeshtasticManager();

    // Mock transport
    mockTransport = {
      send: vi.fn().mockResolvedValue(undefined),
      isConnected: true,
    };

    // Set up the manager with mock transport and local node info
    (manager as any).transport = mockTransport;
    (manager as any).isConnected = true;
    (manager as any).localNodeInfo = {
      nodeNum: 123456,
      nodeId: '!0001e240',
      longName: 'Local Node',
      shortName: 'LOCAL',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkAutoWelcome', () => {
    it('should not send welcome when auto-welcome is disabled', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'false';
        return null;
      });

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      expect(mockTransport.send).not.toHaveBeenCalled();
    });

    it('should skip welcoming local node', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        return null;
      });

      await (manager as any).checkAutoWelcome(123456, '!0001e240');

      expect(mockTransport.send).not.toHaveBeenCalled();
    });

    it('should skip node if not found in database', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        return null;
      });
      vi.mocked(databaseService.getNode).mockReturnValue(null);

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      expect(mockTransport.send).not.toHaveBeenCalled();
    });

    it('should skip node that has already been welcomed', async () => {
      const previouslyWelcomedTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        welcomedAt: previouslyWelcomedTime, // Node has been welcomed before
        createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        updatedAt: Date.now(),
      });

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      // Should not send welcome again - nodes are only welcomed once
      expect(mockTransport.send).not.toHaveBeenCalled();
    });

    it('should skip node with default name when waitForName is enabled', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        if (key === 'autoWelcomeWaitForName') return 'true';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Node !000f423f',
        shortName: '0f42',
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      expect(mockTransport.send).not.toHaveBeenCalled();
    });

    it('should skip node with default short name when waitForName is enabled', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        if (key === 'autoWelcomeWaitForName') return 'true';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: '423f', // Default short name (last 4 chars of nodeId)
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      expect(mockTransport.send).not.toHaveBeenCalled();
    });

    it('should send welcome message to new node with proper name', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        if (key === 'autoWelcomeMessage') return 'Welcome {LONG_NAME} ({SHORT_NAME})!';
        if (key === 'autoWelcomeTarget') return 'dm';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      expect(mockTransport.send).toHaveBeenCalledTimes(1);
      expect(databaseService.markNodeAsWelcomedIfNotAlready).toHaveBeenCalledWith(999999, '!000f423f');
    });

    it('should send welcome as DM when target is dm', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        if (key === 'autoWelcomeMessage') return 'Welcome!';
        if (key === 'autoWelcomeTarget') return 'dm';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const sendTextMessageSpy = vi.spyOn(manager as any, 'sendTextMessage');

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      expect(sendTextMessageSpy).toHaveBeenCalledWith('Welcome!', 0, 999999);
    });

    it('should send welcome to channel when target is channel number', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        if (key === 'autoWelcomeMessage') return 'Welcome!';
        if (key === 'autoWelcomeTarget') return '2';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const sendTextMessageSpy = vi.spyOn(manager as any, 'sendTextMessage');

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      expect(sendTextMessageSpy).toHaveBeenCalledWith('Welcome!', 2, undefined);
    });

    it('should use default welcome message when not configured', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        if (key === 'autoWelcomeTarget') return 'dm';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const sendTextMessageSpy = vi.spyOn(manager as any, 'sendTextMessage');

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      expect(sendTextMessageSpy).toHaveBeenCalledWith('Welcome Test Node (TEST) to the mesh!', 0, 999999);
    });

    it('should handle errors gracefully without crashing', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        throw new Error('Database error');
      });

      // Should not throw
      await expect((manager as any).checkAutoWelcome(999999, '!000f423f')).resolves.not.toThrow();
    });

    it('should prevent duplicate welcomes when called in parallel (race condition protection)', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        if (key === 'autoWelcomeMessage') return 'Welcome!';
        if (key === 'autoWelcomeTarget') return 'dm';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      vi.mocked(databaseService.markNodeAsWelcomedIfNotAlready).mockReturnValue(true);

      // Call checkAutoWelcome twice in parallel (simulating race condition)
      const promise1 = (manager as any).checkAutoWelcome(999999, '!000f423f');
      const promise2 = (manager as any).checkAutoWelcome(999999, '!000f423f');

      await Promise.all([promise1, promise2]);

      // Should only send welcome message once due to in-memory tracking
      expect(mockTransport.send).toHaveBeenCalledTimes(1);
      expect(databaseService.markNodeAsWelcomedIfNotAlready).toHaveBeenCalledTimes(1);
    });

    it('should handle atomic database operation correctly when node already marked by another process', async () => {
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'autoWelcomeEnabled') return 'true';
        if (key === 'localNodeNum') return '123456';
        if (key === 'autoWelcomeMessage') return 'Welcome!';
        if (key === 'autoWelcomeTarget') return 'dm';
        return null;
      });

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Simulate that another process already marked the node
      vi.mocked(databaseService.markNodeAsWelcomedIfNotAlready).mockReturnValue(false);

      await (manager as any).checkAutoWelcome(999999, '!000f423f');

      // Should still send the message but log a warning
      expect(mockTransport.send).toHaveBeenCalledTimes(1);
      expect(databaseService.markNodeAsWelcomedIfNotAlready).toHaveBeenCalledWith(999999, '!000f423f');
    });
  });

  describe('replaceWelcomeTokens', () => {
    it('should replace all token types correctly', async () => {
      const mockNode = {
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        firmwareVersion: '2.3.1',
        createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
        updatedAt: Date.now(),
      };

      vi.mocked(databaseService.getNode).mockReturnValue(mockNode);
      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'maxNodeAgeHours') return '24';
        return null;
      });
      vi.mocked(databaseService.getActiveNodes).mockReturnValue([
        mockNode,
        { ...mockNode, nodeNum: 888888, hopsAway: 0 },
        { ...mockNode, nodeNum: 777777, hopsAway: 1 },
      ]);

      const template =
        'Welcome {LONG_NAME} ({SHORT_NAME})! Version: {VERSION}, Active for: {DURATION}. Nodes: {NODECOUNT}, Direct: {DIRECTCOUNT}';

      const result = await (manager as any).replaceWelcomeTokens(template, 999999, '!000f423f');

      expect(result).toContain('Test Node');
      expect(result).toContain('TEST');
      expect(result).toContain('2.3.1');
      expect(result).toContain('3'); // NODECOUNT
      expect(result).toContain('1'); // DIRECTCOUNT (only one node with hopsAway: 0)
    });

    it('should handle missing node gracefully with fallbacks', async () => {
      vi.mocked(databaseService.getNode).mockReturnValue(null);

      const template = 'Welcome {LONG_NAME} ({SHORT_NAME})!';

      const result = await (manager as any).replaceWelcomeTokens(template, 999999, '!000f423f');

      expect(result).toBe('Welcome Unknown (????)!');
    });

    it('should format duration correctly', async () => {
      const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000); // 2 days, 5 hours ago

      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: twoDaysAgo,
        updatedAt: Date.now(),
      });

      const template = 'Active for {DURATION}';

      const result = await (manager as any).replaceWelcomeTokens(template, 999999, '!000f423f');

      expect(result).toMatch(/2d.*5h/); // Should contain "2d" and "5h"
    });

    it('should handle node without createdAt for duration', async () => {
      const now = Date.now();
      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: undefined, // Testing the case where createdAt is missing
        updatedAt: now,
      } as any);

      const template = 'Active for {DURATION}';

      const result = await (manager as any).replaceWelcomeTokens(template, 999999, '!000f423f');

      expect(result).toBe('Active for just now');
    });

    it('should replace FEATURES token with enabled automation features', async () => {
      vi.mocked(databaseService.getNode).mockReturnValue({
        nodeNum: 999999,
        nodeId: '!000f423f',
        longName: 'Test Node',
        shortName: 'TEST',
        hwModel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      vi.mocked(databaseService.getSetting).mockImplementation((key: string) => {
        if (key === 'tracerouteIntervalMinutes') return '5';
        if (key === 'autoAckEnabled') return 'true';
        if (key === 'autoAnnounceEnabled') return 'true';
        return null;
      });

      const template = 'Features: {FEATURES}';

      const result = await (manager as any).replaceWelcomeTokens(template, 999999, '!000f423f');

      expect(result).toBe('Features: 🗺️ 🤖 📢');
    });
  });
});
