/**
 * MeshtasticManager - ATAK GeoChat per-source isolation (Phase 1 / WP2, §5c)
 *
 * insertMessage has a single-column PK (`id`), not composite with sourceId —
 * without the sourceId prefix on the row id, two sources receiving the same
 * mesh packet would collide and the second source's insert would be deduped
 * away (see the "Message row-ID format is load-bearing" convention already
 * enforced for text messages). This asserts processTakPacket carries that
 * same guarantee for ATAK GeoChat: two managers with distinct sourceIds,
 * fed the identical packet, produce two distinct row ids and each passes its
 * own sourceId as insertMessage's 2nd argument.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

vi.mock('../services/database.js', () => ({
  default: {
    nodes: {
      getNode: vi.fn().mockResolvedValue({
        nodeNum: 0x1111,
        nodeId: '!00001111',
        longName: 'Test Node',
        shortName: 'TEST',
      }),
    },
    messages: {
      insertMessage: vi.fn().mockResolvedValue(true),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue({ id: 0, name: 'Primary', role: 1 }),
    },
    sources: {
      getSource: vi.fn().mockResolvedValue({ id: 'source-a', name: 'Source A' }),
    },
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitNewMessage: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: {
    checkAndSendNotifications: vi.fn(),
    getServiceStatus: vi.fn(() => ({ anyAvailable: false })),
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

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('MeshtasticManager - ATAK GeoChat is source-isolated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue({
      nodeNum: 0x1111,
      nodeId: '!00001111',
      longName: 'Test Node',
      shortName: 'TEST',
    } as any);
    vi.mocked(databaseService.messages.insertMessage).mockResolvedValue(true);
    vi.mocked(databaseService.channels.getChannelById).mockResolvedValue({ id: 0, name: 'Primary', role: 1 } as any);
  });

  it('produces two distinct row ids for the same packet, each carrying its own sourceId', async () => {
    const managerA = new MeshtasticManager('source-a');
    const managerB = new MeshtasticManager('source-b');

    const packet = {
      from: 0x1111,
      to: 0xffffffff,
      id: 99,
      channel: 0,
      rxTime: Math.floor(Date.now() / 1000),
      decoded: { portnum: 72 },
    };
    const tak = { contact: { callsign: 'ALPHA' }, chat: { message: 'shared packet' } };

    await (managerA as any).processTakPacket(packet, tak);
    await (managerB as any).processTakPacket(packet, tak);

    const insertMessage = vi.mocked(databaseService.messages.insertMessage);
    expect(insertMessage).toHaveBeenCalledTimes(2);

    const [rowA, sourceIdA] = insertMessage.mock.calls[0];
    const [rowB, sourceIdB] = insertMessage.mock.calls[1];

    expect(sourceIdA).toBe('source-a');
    expect(sourceIdB).toBe('source-b');
    expect((rowA as any).id).toBe('source-a_4369_99');
    expect((rowB as any).id).toBe('source-b_4369_99');
    expect((rowA as any).id).not.toBe((rowB as any).id);
  });
});
