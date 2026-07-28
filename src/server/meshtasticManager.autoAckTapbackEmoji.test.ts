import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// Regression test for #4340 WP1: the AutoAck tapback emoji used to be produced
// by an inline `HOP_COUNT_EMOJIS` table + `Math.min(hopsTraveled, 7)` right at
// the call site. Both were extracted into the shared `src/utils/hopEmoji.ts`
// helper (also used by the Automation Engine's action.tapback emojiMode=hopCount
// and {{ trigger.hopEmoji }}). This test proves the emitted emoji, and the
// enqueue() call shape around it, are byte-identical to before the extraction.

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

describe('MeshtasticManager - Auto-Ack tapback emoji provably unchanged (#4340 WP1)', () => {
  const FROM_NUM = 0x11223344;
  const SOURCE_ID = 'source-tapback';

  // Every test enables the tapback cell and disables the reply cell for BOTH
  // possible cells (zero-hop / multi-hop), so the test doesn't need to predict
  // which cell a given hopStart/hopLimit pair lands in. Cooldown is forced to 0
  // so repeated calls to the same fromNum within one test file never collide.
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
      autoAckChannelZeroHopReplyEnabled: 'false',
      autoAckChannelMultiHopReplyEnabled: 'false',
      autoAckDirectZeroHopReplyEnabled: 'false',
      autoAckDirectMultiHopReplyEnabled: 'false',
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
  });

  const runAndGetEnqueueArgs = async (message: {
    hopStart?: number | null;
    hopLimit?: number | null;
    viaMqtt?: boolean;
  }) => {
    const manager = new MeshtasticManager(SOURCE_ID);
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(settingsFor());

    // Channel message (isDirectMessage=false) on channel 0. autoAckChannels is
    // null so the channel allowlist would normally reject it — but that gate
    // only runs `if (!isDirectMessage)`, so use a DM instead to skip it and
    // exercise the tapback path directly, matching the spec's "hopStart/hopLimit
    // pairs" cases without needing to also stub a channel allowlist.
    await (manager as any).checkAutoAcknowledge(
      { hopStart: message.hopStart, hopLimit: message.hopLimit, viaMqtt: message.viaMqtt, timestamp: Date.now() },
      'test', // matches default autoAckRegex '^(test|ping)'
      0, // channelIndex
      true, // isDirectMessage
      FROM_NUM,
      packetId++,
      undefined,
      undefined,
    );

    const enqueueMock = (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    return enqueueMock.mock.calls[0];
  };

  it('0 hops (hopStart===hopLimit) → *️⃣', async () => {
    const args = await runAndGetEnqueueArgs({ hopStart: 0, hopLimit: 0 });
    expect(args[0]).toBe('*️⃣');
  });

  it('3 hops (hopStart=3, hopLimit=0) → 3️⃣', async () => {
    const args = await runAndGetEnqueueArgs({ hopStart: 3, hopLimit: 0 });
    expect(args[0]).toBe('3️⃣');
  });

  it('9 hops (hopStart=9, hopLimit=0), clamped → 7️⃣', async () => {
    const args = await runAndGetEnqueueArgs({ hopStart: 9, hopLimit: 0 });
    expect(args[0]).toBe('7️⃣');
  });

  it('hopStart < hopLimit (malformed) → *️⃣', async () => {
    const args = await runAndGetEnqueueArgs({ hopStart: 1, hopLimit: 3 });
    expect(args[0]).toBe('*️⃣');
  });

  it('hopStart absent → *️⃣', async () => {
    const args = await runAndGetEnqueueArgs({ hopStart: undefined, hopLimit: 0 });
    expect(args[0]).toBe('*️⃣');
  });

  it('hopLimit absent → *️⃣', async () => {
    const args = await runAndGetEnqueueArgs({ hopStart: 3, hopLimit: undefined });
    expect(args[0]).toBe('*️⃣');
  });

  it('both hopStart/hopLimit absent → *️⃣', async () => {
    const args = await runAndGetEnqueueArgs({});
    expect(args[0]).toBe('*️⃣');
  });

  it('the tapback enqueue call shape (destination/replyId/channel/maxAttempts/emoji-flag) is unchanged', async () => {
    const args = await runAndGetEnqueueArgs({ hopStart: 2, hopLimit: 0 });
    // [0] emoji, [1] destination (fromNum for DM), [2] replyId (packetId),
    // [3] onSuccess, [4] onFailure, [5] channel (undefined for DM),
    // [6] maxAttempts, [7] emoji flag.
    expect(args[0]).toBe('2️⃣');
    expect(args[1]).toBe(FROM_NUM);
    expect(typeof args[2]).toBe('number'); // replyId = the triggering packetId
    expect(typeof args[3]).toBe('function'); // onSuccess
    expect(typeof args[4]).toBe('function'); // onFailure
    expect(args[5]).toBeUndefined(); // channel: undefined for a DM
    expect(args[6]).toBe(1); // maxAttempts — tapbacks are best-effort, don't retry
    expect(args[7]).toBe(1); // emoji flag = 1 for tapback/reaction
  });
});
