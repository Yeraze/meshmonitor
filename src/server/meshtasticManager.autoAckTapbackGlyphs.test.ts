import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// #5890: per-source 0-hop and MQTT tapback glyphs for Auto-Acknowledge.

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

describe('MeshtasticManager - Auto-Ack tapback glyphs (#5890)', () => {
  const FROM_NUM = 0x55667788;
  let packetId = 100;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue(null);
    vi.mocked(databaseService.nodes.getActiveNodes).mockResolvedValue([]);
    vi.mocked(databaseService.settings.getSetting).mockResolvedValue(null);
  });

  /** Tapback emoji for one DM, with every tapback cell on and every reply off. */
  const tapbackFor = async (
    message: { hopStart?: number; hopLimit?: number; viaMqtt?: boolean },
    glyphs: { hopEmojiZeroHop?: string; hopEmojiMqtt?: string } = {},
  ) => {
    const table: Record<string, string | null> = {
      autoAckEnabled: 'true',
      autoAckCooldownSeconds: '0',
      autoAckDirectZeroHopTapbackEnabled: 'true',
      autoAckDirectMultiHopTapbackEnabled: 'true',
      autoAckDirectIpTapbackEnabled: 'true',
      autoAckDirectZeroHopReplyEnabled: 'false',
      autoAckDirectMultiHopReplyEnabled: 'false',
      autoAckDirectIpReplyEnabled: 'false',
      ...glyphs,
    };
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(
      async (_sourceId, key: string) => (key in table ? table[key] : null),
    );
    const manager = new MeshtasticManager('source-glyphs');
    ((manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>).mockClear();
    await (manager as any).checkAutoAcknowledge(
      { ...message, timestamp: Date.now() },
      'test',
      0,
      true,
      FROM_NUM,
      packetId++,
      undefined,
      undefined,
    );
    const enqueue = (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
    expect(enqueue).toHaveBeenCalledTimes(1);
    return enqueue.mock.calls[0][0] as string;
  };

  it('uses *️⃣ for 0 hops when nothing is set', async () => {
    expect(await tapbackFor({ hopStart: 3, hopLimit: 3 })).toBe('*️⃣');
  });

  it('uses the chosen 0-hop glyph, and leaves multi-hop alone', async () => {
    expect(await tapbackFor({ hopStart: 3, hopLimit: 3 }, { hopEmojiZeroHop: '0️⃣' })).toBe('0️⃣');
    expect(await tapbackFor({ hopStart: 3, hopLimit: 1 }, { hopEmojiZeroHop: '0️⃣' })).toBe('2️⃣');
  });

  it('keeps the hop glyph for an IP packet when no MQTT glyph is set', async () => {
    expect(await tapbackFor({ hopStart: 3, hopLimit: 3, viaMqtt: true }, { hopEmojiZeroHop: '0️⃣' })).toBe('0️⃣');
    expect(await tapbackFor({ hopStart: 3, hopLimit: 1, viaMqtt: true })).toBe('2️⃣');
  });

  it('uses the MQTT glyph for an IP packet whatever its hop count', async () => {
    const glyphs = { hopEmojiZeroHop: '0️⃣', hopEmojiMqtt: '*️⃣' };
    expect(await tapbackFor({ hopStart: 3, hopLimit: 3, viaMqtt: true }, glyphs)).toBe('*️⃣');
    expect(await tapbackFor({ hopStart: 3, hopLimit: 1, viaMqtt: true }, glyphs)).toBe('*️⃣');
    // An RF packet is unaffected by the MQTT glyph.
    expect(await tapbackFor({ hopStart: 3, hopLimit: 3 }, glyphs)).toBe('0️⃣');
  });

  it('ignores a stored glyph that is not valid', async () => {
    expect(await tapbackFor({ hopStart: 3, hopLimit: 3 }, { hopEmojiZeroHop: 'not an emoji' })).toBe('*️⃣');
  });
});
