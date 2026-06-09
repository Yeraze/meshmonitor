import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// Regression test for #3384: {LONG_NAME} / {SHORT_NAME} in Auto-Acknowledge
// messages resolved to 'Unknown' / '????' intermittently. Root cause: the
// auto-ack token replacer called databaseService.nodes.getNode(fromNum) WITHOUT
// a sourceId. Under the composite (nodeNum, sourceId) PK an unscoped lookup
// returns the first row across ANY source — often a different source's node (or
// nothing), even though THIS source has the name on record.

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn().mockResolvedValue(null),
    },
    nodes: {
      getNode: vi.fn(),
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

describe('MeshtasticManager - Auto-Ack {LONG_NAME}/{SHORT_NAME} source scoping (#3384)', () => {
  const FROM_NUM = 0x11223344;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('looks up the sender node scoped to this manager\'s sourceId', async () => {
    const manager = new MeshtasticManager('source-b');
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue({
      nodeNum: FROM_NUM,
      longName: 'Base Station One',
      shortName: 'BS01',
    } as any);

    const result = await (manager as any).replaceAcknowledgementTokens(
      '🤖 Copy {LONG_NAME} ({SHORT_NAME})',
      '!11223344', FROM_NUM, 2, '01/01/2026', '12:00', 0, false,
    );

    expect(result).toBe('🤖 Copy Base Station One (BS01)');
    // The fix: getNode MUST be scoped by sourceId.
    expect(databaseService.nodes.getNode).toHaveBeenCalledWith(FROM_NUM, 'source-b');
  });

  it('resolves real names when the node exists ONLY under this source (not the first cross-source row)', async () => {
    const manager = new MeshtasticManager('source-b');

    // Simulate the multi-source PK: the node row only exists for 'source-b'.
    // An unscoped lookup (old buggy behaviour) would have returned null here,
    // producing 'Unknown' / '????'.
    vi.mocked(databaseService.nodes.getNode).mockImplementation(
      async (_nodeNum: number, sourceId?: string) =>
        sourceId === 'source-b'
          ? ({ nodeNum: FROM_NUM, longName: 'Repeater North', shortName: 'RPTN' } as any)
          : null,
    );

    const result = await (manager as any).replaceAcknowledgementTokens(
      '{LONG_NAME}/{SHORT_NAME}',
      '!11223344', FROM_NUM, 0, '01/01/2026', '12:00', 0, false,
    );

    expect(result).toBe('Repeater North/RPTN');
    expect(result).not.toContain('Unknown');
    expect(result).not.toContain('????');
  });

  it('still falls back to Unknown/???? when the node is genuinely absent for this source', async () => {
    const manager = new MeshtasticManager('source-b');
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue(null);

    const result = await (manager as any).replaceAcknowledgementTokens(
      '{LONG_NAME}/{SHORT_NAME}',
      '!11223344', FROM_NUM, 0, '01/01/2026', '12:00', 0, false,
    );

    expect(result).toBe('Unknown/????');
  });
});
