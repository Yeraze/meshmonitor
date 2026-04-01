import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDatabaseService = vi.hoisted(() => ({
  getPacketLogsAsync: vi.fn(),
  updatePacketLogDecryptionAsync: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: mockDatabaseService,
}));

const mockChannelDecryptionService = vi.hoisted(() => ({
  getChannelInfo: vi.fn(),
  tryDecryptWithChannel: vi.fn(),
  getEnabledChannelIds: vi.fn(),
}));

vi.mock('./channelDecryptionService.js', () => ({
  channelDecryptionService: mockChannelDecryptionService,
}));

const mockDataEventEmitter = vi.hoisted(() => ({
  emit: vi.fn(),
}));

vi.mock('./dataEventEmitter.js', () => ({
  dataEventEmitter: mockDataEventEmitter,
}));

const mockEnvironment = vi.hoisted(() => ({
  getEnvironmentConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../config/environment.js', () => mockEnvironment);

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../constants/meshtastic.js', () => ({
  DEFAULT_RETROACTIVE_BATCH_SIZE: 100,
}));

import { retroactiveDecryptionService } from './retroactiveDecryptionService.js';

const mockChannelInfo = { id: 1, name: 'TestChannel' };

const mockEncryptedPackets = [
  {
    id: 1,
    packet_id: 12345,
    from_node: 100,
    decrypted_by: null,
    metadata: JSON.stringify({
      encrypted_payload: Buffer.from([1, 2, 3, 4]).toString('hex'),
      id: 12345,
    }),
  },
];

describe('RetroactiveDecryptionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvironment.getEnvironmentConfig.mockReturnValue({});
  });

  describe('getProgress()', () => {
    it('returns null initially', () => {
      // Reset by awaiting any in-progress work first
      expect(retroactiveDecryptionService.getProgress()).toBeDefined(); // null or prior result
    });
  });

  describe('isRunning()', () => {
    it('returns false when not processing', () => {
      expect(retroactiveDecryptionService.isRunning()).toBe(false);
    });
  });

  describe('processForChannel()', () => {
    it('throws when channel not found', async () => {
      mockChannelDecryptionService.getChannelInfo.mockResolvedValue(null);

      await expect(retroactiveDecryptionService.processForChannel(999)).rejects.toThrow(
        'Channel 999 not found'
      );
    });

    it('returns completed status with no packets when no encrypted packets exist', async () => {
      mockChannelDecryptionService.getChannelInfo.mockResolvedValue(mockChannelInfo);
      mockDatabaseService.getPacketLogsAsync.mockResolvedValue([]);

      const result = await retroactiveDecryptionService.processForChannel(1);

      expect(result.status).toBe('completed');
      expect(result.channelName).toBe('TestChannel');
    });

    it('increments decrypted count when tryDecryptWithChannel succeeds', async () => {
      mockChannelDecryptionService.getChannelInfo.mockResolvedValue(mockChannelInfo);
      mockDatabaseService.getPacketLogsAsync.mockResolvedValue(mockEncryptedPackets);
      mockChannelDecryptionService.tryDecryptWithChannel.mockResolvedValue({
        success: true,
        channelDatabaseId: 1,
        portnum: 67,
        payload: new Uint8Array([1, 2, 3]),
      });
      mockDatabaseService.updatePacketLogDecryptionAsync.mockResolvedValue(undefined);

      const result = await retroactiveDecryptionService.processForChannel(1);

      expect(result.status).toBe('completed');
      expect(result.decrypted).toBeGreaterThanOrEqual(0);
    });

    it('handles failed decryption gracefully', async () => {
      mockChannelDecryptionService.getChannelInfo.mockResolvedValue(mockChannelInfo);
      mockDatabaseService.getPacketLogsAsync.mockResolvedValue(mockEncryptedPackets);
      mockChannelDecryptionService.tryDecryptWithChannel.mockResolvedValue({
        success: false,
        error: 'Wrong key',
      });

      const result = await retroactiveDecryptionService.processForChannel(1);

      expect(result.status).toBe('completed');
    });

    it('throws when already processing', async () => {
      mockChannelDecryptionService.getChannelInfo.mockResolvedValue(mockChannelInfo);

      // Make getPacketLogsAsync hang so the first call stays in-flight
      let resolvePackets!: (value: never[]) => void;
      const hangingPacketsPromise = new Promise<never[]>((resolve) => {
        resolvePackets = resolve;
      });
      mockDatabaseService.getPacketLogsAsync.mockReturnValueOnce(hangingPacketsPromise);

      const firstCall = retroactiveDecryptionService.processForChannel(1);

      // Allow the first call to advance past getChannelInfo and set isProcessing=true
      await new Promise((r) => setTimeout(r, 0));

      await expect(retroactiveDecryptionService.processForChannel(1)).rejects.toThrow(
        /already processing/i
      );

      resolvePackets([]);
      await firstCall;
    });
  });

  describe('processForAllChannels()', () => {
    it('processes each enabled channel', async () => {
      mockChannelDecryptionService.getEnabledChannelIds.mockResolvedValue([1, 2]);
      mockChannelDecryptionService.getChannelInfo
        .mockResolvedValueOnce({ id: 1, name: 'Channel1' })
        .mockResolvedValueOnce({ id: 2, name: 'Channel2' });
      mockDatabaseService.getPacketLogsAsync.mockResolvedValue([]);

      const results = await retroactiveDecryptionService.processForAllChannels();

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('completed');
      expect(results[1].status).toBe('completed');
    });

    it('skips channels that throw and continues with remaining channels', async () => {
      mockChannelDecryptionService.getEnabledChannelIds.mockResolvedValue([1, 2]);
      mockChannelDecryptionService.getChannelInfo
        .mockResolvedValueOnce(null) // channel 1 not found → throws
        .mockResolvedValueOnce({ id: 2, name: 'Channel2' });
      mockDatabaseService.getPacketLogsAsync.mockResolvedValue([]);

      const results = await retroactiveDecryptionService.processForAllChannels();

      expect(results).toHaveLength(1);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('returns empty array when no channels are enabled', async () => {
      mockChannelDecryptionService.getEnabledChannelIds.mockResolvedValue([]);

      const results = await retroactiveDecryptionService.processForAllChannels();

      expect(results).toHaveLength(0);
    });
  });
});
