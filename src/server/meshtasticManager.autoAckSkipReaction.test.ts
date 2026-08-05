import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// Regression test for #4569: an incoming tapback/reaction packet (emoji flag
// set) was being fed into checkAutoAcknowledge like any other text message.
// Since firmware/apps never display a reply to a tapback, auto-acking one is
// a pure airtime waste — and it fires regardless of WHO placed the reaction,
// so Auto-Ack ended up "answering" other users' tapbacks on messages
// MeshMonitor never even sent an ack for.

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

describe('MeshtasticManager - Auto-Ack skips incoming tapback/reaction packets (#4569)', () => {
  const FROM_NUM = 0x11223344;
  const SOURCE_ID = 'source-tapback-skip';

  const settingsFor = (overrides: Record<string, string | null> = {}) => {
    const table: Record<string, string | null> = {
      autoAckEnabled: 'true',
      autoAckRegex: null, // default '^(test|ping)'
      autoAckChannels: null,
      autoAckIgnoredNodes: null,
      autoAckSkipIncompleteNodes: null,
      autoAckCooldownSeconds: '0',
      autoAckPreSendDelaySeconds: null,
      autoAckChannelZeroHopTapbackEnabled: 'true',
      autoAckChannelMultiHopTapbackEnabled: 'true',
      autoAckDirectZeroHopTapbackEnabled: 'true',
      autoAckDirectMultiHopTapbackEnabled: 'true',
      autoAckChannelZeroHopReplyEnabled: 'true',
      autoAckChannelMultiHopReplyEnabled: 'true',
      autoAckDirectZeroHopReplyEnabled: 'true',
      autoAckDirectMultiHopReplyEnabled: 'true',
      ...overrides,
    };
    return async (_sourceId: string, key: string) => (key in table ? table[key] : null);
  };

  let packetId = 1;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue(null);
    vi.mocked(databaseService.nodes.getActiveNodes).mockResolvedValue([]);
    vi.mocked(databaseService.settings.getSetting).mockResolvedValue(null);
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(settingsFor());
  });

  it('does not enqueue any ack when the incoming packet is itself a tapback (emoji set)', async () => {
    const manager = new MeshtasticManager(SOURCE_ID);

    await (manager as any).checkAutoAcknowledge(
      { hopStart: 0, hopLimit: 0, timestamp: Date.now(), emoji: 1 },
      '👍', // reaction payload text — would not normally match the regex, but
            // the point of this test is that emoji-flagged packets are
            // rejected BEFORE the text is even matched against the regex
      0,
      true, // isDirectMessage
      FROM_NUM,
      packetId++,
      undefined,
      undefined,
    );

    const enqueueMock = (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('still acks a normal text message with no emoji flag (control case)', async () => {
    const manager = new MeshtasticManager(SOURCE_ID);

    await (manager as any).checkAutoAcknowledge(
      { hopStart: 0, hopLimit: 0, timestamp: Date.now() },
      'test',
      0,
      true,
      FROM_NUM,
      packetId++,
      undefined,
      undefined,
    );

    const enqueueMock = (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
    expect(enqueueMock).toHaveBeenCalled();
  });
});
