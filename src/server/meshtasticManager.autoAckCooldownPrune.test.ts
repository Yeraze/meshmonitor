/**
 * autoAckCooldowns bound + prune (#4399).
 *
 * `autoAckCooldowns` (nodeNum → last-ack ms) was never evicted at all. This
 * proves the fix — an exact-expiry pass first (an entry older than the
 * CURRENT `autoAckCooldownSeconds` window can never suppress anything again,
 * so deleting it is behaviour-neutral), with a high-water trim only as a
 * backstop — is itself behaviour-neutral: a node genuinely still inside its
 * cooldown window stays suppressed even after the map has been driven past
 * its high-water mark and pruned.
 *
 * Harness mirrors meshtasticManager.autoAckTapbackEmoji.test.ts (fresh
 * `new MeshtasticManager(sourceId)` per test, minimal databaseService +
 * messageQueueService mocks). `checkAutoAcknowledge` reads `Date.now()`
 * directly (no injectable clock), so fake timers drive the elapsed time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

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

describe('MeshtasticManager - autoAckCooldowns bound + prune (#4399)', () => {
  const SOURCE_ID = 'source-cooldown-prune';
  const T0 = 1_700_000_000_000;

  // Tapback disabled, channel reply enabled for both cells, matching the
  // default matched channel (isDirectMessage=false, channel 0) below.
  const settingsFor = (overrides: Record<string, string | null> = {}) => {
    const table: Record<string, string | null> = {
      autoAckEnabled: 'true',
      autoAckRegex: null, // default '^(test|ping)'
      autoAckChannels: null,
      autoAckIgnoredNodes: null,
      autoAckSkipIncompleteNodes: null,
      autoAckCooldownSeconds: '60',
      autoAckPreSendDelaySeconds: null,
      autoAckChannelZeroHopTapbackEnabled: 'false',
      autoAckChannelMultiHopTapbackEnabled: 'false',
      autoAckDirectZeroHopTapbackEnabled: 'false',
      autoAckDirectMultiHopTapbackEnabled: 'false',
      autoAckChannelZeroHopReplyEnabled: 'true',
      autoAckChannelMultiHopReplyEnabled: 'true',
      autoAckDirectZeroHopReplyEnabled: 'true',
      autoAckDirectMultiHopReplyEnabled: 'true',
      ...overrides,
    };
    return async (_sourceId: string, key: string) => (key in table ? table[key] : null);
  };

  let packetId = 1;
  let manager: MeshtasticManager;
  let enqueueMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue(null);
    vi.mocked(databaseService.nodes.getActiveNodes).mockResolvedValue([]);
    vi.mocked(databaseService.settings.getSetting).mockResolvedValue(null);
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(settingsFor());
    manager = new MeshtasticManager(SOURCE_ID);
    enqueueMock = (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ack = async (fromNum: number) =>
    (manager as any).checkAutoAcknowledge(
      { hopStart: 0, hopLimit: 0, viaMqtt: false, timestamp: Date.now() },
      'test', // matches default autoAckRegex '^(test|ping)'
      0, // channelIndex
      // DM, not channel: autoAckChannels is null (no allowlist configured), and
      // that gate only applies `if (!isDirectMessage)` — using a DM sidesteps
      // needing a channel allowlist just to exercise the cooldown path
      // (same trick meshtasticManager.autoAckTapbackEmoji.test.ts uses).
      true, // isDirectMessage
      fromNum,
      packetId++,
      undefined,
      undefined,
    );

  it('a node still inside its cooldown window is suppressed (base case, no eviction)', async () => {
    const FROM_NUM = 0xaaaaaaaa;
    await ack(FROM_NUM);
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 5_000); // 5s later, well inside the 60s window
    await ack(FROM_NUM);
    expect(enqueueMock).toHaveBeenCalledTimes(1); // still suppressed

    vi.setSystemTime(T0 + 61_000); // 61s later, past the window
    await ack(FROM_NUM);
    expect(enqueueMock).toHaveBeenCalledTimes(2); // fires again
  });

  it('exact-expiry prune drops only truly-expired entries; a node still inside its window stays suppressed after the map is driven past its high-water mark', async () => {
    // Phase 1: 4000 distinct nodes ack at T0 (< AUTO_ACK_COOLDOWNS_MAX=4096,
    // so no prune fires yet — every one of these gets an entry timestamped T0).
    for (let i = 0; i < 4000; i++) {
      await ack(1_000_000 + i);
    }
    expect(enqueueMock).toHaveBeenCalledTimes(4000);

    // Phase 2: jump 61s forward — the whole T0 batch is now past its 60s window.
    vi.setSystemTime(T0 + 61_000);

    // RECENT_NUM acks first at the new time, then 96 more distinct nodes push
    // the map from 4001 → 4097, crossing AUTO_ACK_COOLDOWNS_MAX and triggering
    // pruneAutoAckCooldowns. At that moment: the 4000 T0 entries are exactly
    // expired (61s >= 60s window) and are deleted; RECENT_NUM and the 96 flood
    // entries are age 0 and survive. Final size (~97) never approaches
    // AUTO_ACK_COOLDOWNS_TRIM_TO (2048), so the high-water backstop never fires
    // — this proves the EXACT pass alone is what's under test here.
    const RECENT_NUM = 0xbbbbbbbb;
    await ack(RECENT_NUM);
    for (let i = 0; i < 96; i++) {
      await ack(2_000_000 + i);
    }
    expect(enqueueMock).toHaveBeenCalledTimes(4000 + 1 + 96);

    // The behaviour that must survive pruning: RECENT_NUM is still within its
    // 60s window (0s old) — it must stay suppressed.
    await ack(RECENT_NUM);
    expect(enqueueMock).toHaveBeenCalledTimes(4000 + 1 + 96); // unchanged — suppressed

    // And a node from the expired T0 batch is free to ack again — proving the
    // expired entries were actually pruned, not just coincidentally ignored
    // (this is also true regardless of pruning, since checkAutoAcknowledge's
    // own elapsed-time check would allow it either way; it's included as a
    // sanity check that pruning didn't somehow wedge state).
    await ack(1_000_000);
    expect(enqueueMock).toHaveBeenCalledTimes(4000 + 1 + 96 + 1);
  });
});
