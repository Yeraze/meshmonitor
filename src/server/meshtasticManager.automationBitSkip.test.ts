/**
 * Legacy Auto-Acknowledge and Auto-Responder skip a message whose sender set
 * the Meshtastic is_automation bit (Data.bitfield bit 2), unless the operator
 * turned on the per-source "respond to automated messages" setting (#6449).
 * A bot-to-bot loop guard; an absent flag counts as human.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';
import { logger } from '../utils/logger.js';

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn(),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      getActiveNodes: vi.fn().mockResolvedValue([]),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  function MessageQueueService() { return mockInstance as any; }
  return { messageQueueService: mockInstance, MessageQueueService };
});

describe('MeshtasticManager — legacy responders skip automated messages (#6449)', () => {
  const FROM_NUM = 0x11223344;
  const SOURCE_ID = 'source-automation-skip';
  let packetId = 1000;

  const ackSettings = (overrides: Record<string, string | null> = {}) => {
    const table: Record<string, string | null> = {
      autoAckEnabled: 'true',
      autoAckRegex: '.',
      autoAckCooldownSeconds: '0',
      autoAckChannelZeroHopTapbackEnabled: 'true',
      autoAckChannelMultiHopTapbackEnabled: 'true',
      autoAckDirectZeroHopTapbackEnabled: 'true',
      autoAckDirectMultiHopTapbackEnabled: 'true',
      autoAckChannelZeroHopReplyEnabled: 'false',
      autoAckChannelMultiHopReplyEnabled: 'false',
      autoAckDirectZeroHopReplyEnabled: 'false',
      autoAckDirectMultiHopReplyEnabled: 'false',
      ...overrides,
    };
    return async (_sourceId: string | null | undefined, key: string) => (key in table ? table[key] : null);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue(null);
    vi.mocked(databaseService.nodes.getActiveNodes).mockResolvedValue([]);
    vi.mocked(databaseService.settings.getSetting).mockResolvedValue(null);
  });

  describe('Auto-Acknowledge', () => {
    const runAck = async (message: Record<string, unknown>, overrides: Record<string, string | null> = {}) => {
      const manager = new MeshtasticManager(SOURCE_ID);
      vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(ackSettings(overrides));
      await (manager as any).checkAutoAcknowledge(
        { hopStart: 0, hopLimit: 0, timestamp: Date.now(), ...message },
        'hello', 0, true, FROM_NUM, packetId++, undefined, undefined,
      );
      return (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
    };

    it('skips a message flagged as automated by default', async () => {
      expect(await runAck({ isAutomation: true })).not.toHaveBeenCalled();
    });

    it('answers a flagged message when the operator opts in', async () => {
      expect(await runAck({ isAutomation: true }, { autoAckRespondToAutomation: 'true' })).toHaveBeenCalledTimes(1);
    });

    it('answers a message with the bit clear', async () => {
      expect(await runAck({ isAutomation: false })).toHaveBeenCalledTimes(1);
    });

    it('answers a message with no flag (bitfield absent counts as human)', async () => {
      expect(await runAck({})).toHaveBeenCalledTimes(1);
    });
  });

  describe('Auto-Responder', () => {
    const runResponder = async (message: Record<string, unknown>, respondToAutomation: string | null) => {
      const manager = new MeshtasticManager(SOURCE_ID);
      vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(async (_s, key: string) => {
        if (key === 'autoResponderEnabled') return 'true';
        if (key === 'autoResponderRespondToAutomation') return respondToAutomation;
        return null;
      });
      const debug = vi.spyOn(logger, 'debug');
      await (manager as any).checkAutoResponder(
        { fromNodeNum: FROM_NUM, text: 'hello', channel: 0, ...message }, true, packetId++,
      );
      const skipped = debug.mock.calls.some((c) => String(c[0]).includes('sender flagged it as automated'));
      debug.mockRestore();
      return skipped;
    };

    it('skips a message flagged as automated by default', async () => {
      expect(await runResponder({ isAutomation: true }, null)).toBe(true);
    });

    it('does not skip a flagged message when the operator opts in', async () => {
      expect(await runResponder({ isAutomation: true }, 'true')).toBe(false);
    });

    it('does not skip a message without the flag', async () => {
      expect(await runResponder({}, null)).toBe(false);
    });
  });
});
