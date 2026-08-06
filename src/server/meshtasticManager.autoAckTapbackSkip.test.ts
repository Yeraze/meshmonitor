/**
 * Auto-Ack must never reply to a tapback (#4569).
 *
 * A tapback is a TEXT_MESSAGE_APP packet whose Data carries `emoji > 0` — its
 * text payload is the reaction character itself. `checkAutoAcknowledge` read
 * `hopStart`/`hopLimit`/`viaMqtt`/`text` off the message but never `emoji`, so
 * an inbound reaction flowed through the normal path and drew a reply.
 *
 * The default `^(test|ping)` regex hides this (a bare emoji can't match it),
 * which is why it went unreported for so long. Operators running a permissive
 * pattern to ack everything saw every reaction on the channel draw a response —
 * wasted airtime, since clients don't render a reaction to a reaction.
 *
 * These tests therefore use a permissive regex: with the default pattern they
 * would pass whether or not the guard exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('MeshtasticManager — Auto-Ack skips tapbacks (#4569)', () => {
  const FROM_NUM = 0x11223344;
  const SOURCE_ID = 'source-tapback-skip';

  // Permissive regex ('.' matches any single character, so a bare emoji
  // qualifies) — the configuration under which the bug was reported; the
  // default '^(test|ping)' would make these tests pass with or without the
  // guard. Cooldown 0 so repeated calls with the same fromNum never collide.
  const settingsFor = (overrides: Record<string, string | null> = {}) => {
    const table: Record<string, string | null> = {
      autoAckEnabled: 'true',
      autoAckRegex: '.',
      autoAckChannels: null,
      autoAckIgnoredNodes: null,
      autoAckSkipIncompleteNodes: null,
      autoAckCooldownSeconds: '0',
      autoAckPreSendDelaySeconds: null,
      autoAckChannelZeroHopTapbackEnabled: 'true',
      autoAckChannelMultiHopTapbackEnabled: 'true',
      autoAckDirectZeroHopTapbackEnabled: 'true',
      autoAckDirectMultiHopTapbackEnabled: 'true',
      // Tapback cells only, reply cells off — matching the sibling
      // autoAckTapbackEmoji suite. The reply path needs channel/token plumbing
      // this harness doesn't stub; the tapback path alone is enough to prove
      // the guard, since it is the response an ordinary message produces here.
      autoAckChannelZeroHopReplyEnabled: 'false',
      autoAckChannelMultiHopReplyEnabled: 'false',
      autoAckDirectZeroHopReplyEnabled: 'false',
      autoAckDirectMultiHopReplyEnabled: 'false',
      ...overrides,
    };
    return async (_sourceId: string | null | undefined, key: string) =>
      (key in table ? table[key] : null);
  };

  let packetId = 1;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue(null);
    vi.mocked(databaseService.nodes.getActiveNodes).mockResolvedValue([]);
    vi.mocked(databaseService.settings.getSetting).mockResolvedValue(null);
  });

  /** Drives one inbound DM through the auto-ack path; returns the enqueue mock. */
  const run = async (
    message: Record<string, unknown>,
    text: string,
    explicitPacketId?: number,
  ) => {
    const manager = new MeshtasticManager(SOURCE_ID);
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(settingsFor());

    // isDirectMessage=true skips the channel allowlist gate (which only runs
    // for channel messages), matching the sibling tapback-emoji suite.
    await (manager as any).checkAutoAcknowledge(
      { hopStart: 0, hopLimit: 0, timestamp: Date.now(), ...message },
      text,
      0,
      true,
      FROM_NUM,
      explicitPacketId ?? packetId++,
      undefined,
      undefined,
    );

    return (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
  };

  it('does not respond to a tapback, even under a match-everything regex', async () => {
    // The reported case: emoji=1 marks the packet as a reaction, and its text
    // payload is the reaction character.
    const enqueue = await run({ emoji: 1 }, '👍');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still responds to an ordinary message under the same settings', async () => {
    // Guards against the fix being over-broad — without this, a guard that
    // rejected everything would pass the test above.
    const enqueue = await run({}, 'hello');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('treats any non-zero emoji value as a tapback, not just 1', async () => {
    const enqueue = await run({ emoji: 2 }, '🎉');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not skip a message whose emoji field is explicitly null', async () => {
    // The decode path normalizes absent/zero emoji to `undefined`, but rows
    // rebuilt from other transports can carry an explicit null. That is an
    // ordinary message and must still be acked.
    const enqueue = await run({ emoji: null }, 'hello');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not skip a message whose emoji flag is 0', async () => {
    // `emoji` is a flag: 0 means "not a reaction". The decode upstream happens
    // to normalize 0 to undefined today, so this cannot arrive on the live TCP
    // path — but the guard must not depend on that. An earlier `!= null`
    // version treated 0 as a tapback, which would have silently stopped acking
    // ordinary messages had the normalization moved or a new ingestion path
    // skipped it. Ported from #4571.
    const enqueue = await run({ emoji: 0 }, 'hello');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not burn a dedup slot: a tapback does not suppress a later packet reusing its id', async () => {
    // The guard runs BEFORE the per-packet dedup guard, so a skipped tapback
    // never lands in `autoAckProcessedPackets`. Were the order reversed, the
    // tapback would register its id and this second call — same manager, same
    // id — would be silently dropped as a duplicate.
    const manager = new MeshtasticManager(SOURCE_ID);
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(settingsFor());
    const enqueue = (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
    const sharedId = 987654;

    await (manager as any).checkAutoAcknowledge(
      { hopStart: 0, hopLimit: 0, timestamp: Date.now(), emoji: 1 },
      '👍', 0, true, FROM_NUM, sharedId, undefined, undefined,
    );
    expect(enqueue).not.toHaveBeenCalled();

    await (manager as any).checkAutoAcknowledge(
      { hopStart: 0, hopLimit: 0, timestamp: Date.now() },
      'hello', 0, true, FROM_NUM, sharedId, undefined, undefined,
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
