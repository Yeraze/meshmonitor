import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';
import { TransportMechanism } from './constants/meshtastic.js';

// #5796: checkAutoAcknowledge picks the IP row (autoAck{Channel,Direct}Ip*) for a
// message that reached the node over MQTT or multicast UDP, before it looks at
// the hop count. An IP message never lands in ZeroHop or MultiHop.

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

const FROM_NUM = 0x22334455;
const SOURCE_ID = 'source-ip-cell';

type Cell = 'ZeroHop' | 'MultiHop' | 'Ip';

/** Settings with Direct-message tapback on for `enabledCell` only. */
const settingsWithDirectTapback = (enabledCell: Cell | null, extra: Record<string, string | null> = {}) => {
  const table: Record<string, string | null> = {
    autoAckEnabled: 'true',
    autoAckRegex: null, // default '^(test|ping)'
    autoAckCooldownSeconds: '0',
    ...extra,
  };
  for (const cell of ['ZeroHop', 'MultiHop', 'Ip'] as const) {
    table[`autoAckDirect${cell}TapbackEnabled`] = cell === enabledCell ? 'true' : 'false';
    table[`autoAckDirect${cell}ReplyEnabled`] = 'false';
  }
  return async (_sourceId: string, key: string) => (key in table ? table[key] : null);
};

let packetId = 1000;

async function run(
  manager: MeshtasticManager,
  message: { hopStart?: number; hopLimit?: number; viaMqtt?: boolean; transportMechanism?: number },
): Promise<ReturnType<typeof vi.fn>> {
  await (manager as any).checkAutoAcknowledge(
    { ...message, timestamp: Date.now() },
    'test',
    0,
    true, // DM: skips the channel allowlist and the channel wait
    FROM_NUM,
    packetId++,
    undefined,
    undefined,
  );
  return (manager as any).messageQueue.enqueue as ReturnType<typeof vi.fn>;
}

describe('MeshtasticManager - Auto-Ack IP row (#5796)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue(null);
    vi.mocked(databaseService.settings.getSetting).mockResolvedValue(null);
  });

  const cases: Array<{ label: string; msg: Parameters<typeof run>[1]; cell: Cell }> = [
    { label: 'LoRa 0 hops', msg: { hopStart: 3, hopLimit: 3, transportMechanism: TransportMechanism.LORA }, cell: 'ZeroHop' },
    { label: 'LoRa 2 hops', msg: { hopStart: 3, hopLimit: 1, transportMechanism: TransportMechanism.LORA }, cell: 'MultiHop' },
    { label: 'viaMqtt flag, 0 hops', msg: { hopStart: 3, hopLimit: 3, viaMqtt: true }, cell: 'Ip' },
    { label: 'viaMqtt flag, 2 hops', msg: { hopStart: 3, hopLimit: 1, viaMqtt: true }, cell: 'Ip' },
    { label: 'transport MQTT, 0 hops', msg: { hopStart: 3, hopLimit: 3, viaMqtt: false, transportMechanism: TransportMechanism.MQTT }, cell: 'Ip' },
    { label: 'transport UDP, 0 hops', msg: { hopStart: 3, hopLimit: 3, viaMqtt: false, transportMechanism: TransportMechanism.MULTICAST_UDP }, cell: 'Ip' },
    { label: 'transport UDP, 2 hops', msg: { hopStart: 3, hopLimit: 1, viaMqtt: false, transportMechanism: TransportMechanism.MULTICAST_UDP }, cell: 'Ip' },
    { label: 'transport API, 0 hops (not IP)', msg: { hopStart: 3, hopLimit: 3, viaMqtt: false, transportMechanism: TransportMechanism.API }, cell: 'ZeroHop' },
  ];

  for (const { label, msg, cell } of cases) {
    it(`${label} → answers only when the ${cell} cell is on`, async () => {
      for (const enabled of ['ZeroHop', 'MultiHop', 'Ip'] as const) {
        const manager = new MeshtasticManager(SOURCE_ID);
        vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(settingsWithDirectTapback(enabled));
        const enqueue = await run(manager, msg);
        expect(enqueue.mock.calls.length, `enabled=${enabled}`).toBe(enabled === cell ? 1 : 0);
        enqueue.mockClear();
      }
    });
  }

  it('the IP row defaults off: with its keys unset, an MQTT message gets no answer even with MultiHop on', async () => {
    const manager = new MeshtasticManager(SOURCE_ID);
    const table: Record<string, string> = {
      autoAckEnabled: 'true',
      autoAckCooldownSeconds: '0',
      autoAckDirectZeroHopTapbackEnabled: 'true',
      autoAckDirectMultiHopTapbackEnabled: 'true',
      autoAckDirectZeroHopReplyEnabled: 'true',
      autoAckDirectMultiHopReplyEnabled: 'true',
    };
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(
      async (_s: string, key: string) => table[key] ?? null,
    );
    const enqueue = await run(manager, { hopStart: 3, hopLimit: 1, viaMqtt: true });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('an IP reply at 0 hops uses the standard template, not the 0-hop one', async () => {
    const manager = new MeshtasticManager(SOURCE_ID);
    const table: Record<string, string> = {
      autoAckEnabled: 'true',
      autoAckCooldownSeconds: '0',
      autoAckDirectIpReplyEnabled: 'true',
      autoAckMessage: 'standard template',
      autoAckMessageDirect: 'zero-hop template',
    };
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(
      async (_s: string, key: string) => table[key] ?? null,
    );
    const tokens = vi.fn().mockResolvedValue('rendered');
    (manager as any).replaceAcknowledgementTokens = tokens;
    await run(manager, { hopStart: 3, hopLimit: 3, viaMqtt: false, transportMechanism: TransportMechanism.MQTT });
    expect(tokens).toHaveBeenCalledTimes(1);
    expect(tokens.mock.calls[0][0]).toBe('standard template');
  });

  it('a LoRa reply at 0 hops still uses the 0-hop template', async () => {
    const manager = new MeshtasticManager(SOURCE_ID);
    const table: Record<string, string> = {
      autoAckEnabled: 'true',
      autoAckCooldownSeconds: '0',
      autoAckDirectZeroHopReplyEnabled: 'true',
      autoAckMessage: 'standard template',
      autoAckMessageDirect: 'zero-hop template',
    };
    vi.mocked(databaseService.settings.getSettingForSource).mockImplementation(
      async (_s: string, key: string) => table[key] ?? null,
    );
    const tokens = vi.fn().mockResolvedValue('rendered');
    (manager as any).replaceAcknowledgementTokens = tokens;
    await run(manager, { hopStart: 3, hopLimit: 3, transportMechanism: TransportMechanism.LORA });
    expect(tokens).toHaveBeenCalledTimes(1);
    expect(tokens.mock.calls[0][0]).toBe('zero-hop template');
  });
});
