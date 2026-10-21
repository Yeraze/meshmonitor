/**
 * #5923: `processMeshPacket` must only stamp `nodes.channel` when our radio
 * decrypted the sender's own traffic with that channel's key. Drives the real
 * ingest on `fallbackManager`, mocking only what that path touches (modelled on
 * meshtasticManager.transportTraffic.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockUpsertNodeAsync = vi.fn().mockResolvedValue(undefined);
const mockGetNode = vi.fn().mockResolvedValue(null);

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: mockUpsertNodeAsync,
    nodes: {
      getNode: mockGetNode,
      upsertNode: vi.fn(),
      getAllNodes: vi.fn().mockResolvedValue([]),
      updateNodeMessageHops: vi.fn().mockResolvedValue(undefined),
    },
    telemetry: { insertTelemetry: vi.fn().mockResolvedValue(undefined) },
    messages: { getDirectMessages: vi.fn().mockResolvedValue([]), getMessage: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('./services/packetLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));

vi.mock('./services/transportTrafficService.js', () => ({
  transportTrafficService: { recordRx: vi.fn() },
}));

const managerModule = await import('./meshtasticManager.js');

const FROM = 0x11111111;
const PRIVATE_SLOT = 1;

describe('MeshtasticManager — node channel membership (#5923)', () => {
  let manager: any;
  const NOW_MS = Date.UTC(2026, 9, 21, 12, 0, 0);
  const nowSec = NOW_MS / 1000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(null);
    manager = managerModule.fallbackManager;
    vi.spyOn(manager, 'trackPKIEncryption').mockResolvedValue(undefined);
    vi.spyOn(manager, 'maybeRecordHeardReflood').mockResolvedValue(undefined);
    manager.localNodeInfo = { nodeNum: 0xaaaaaaaa, nodeId: '!aaaaaaaa', longName: 'Local', shortName: 'LOCL' };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function packet(overrides: Record<string, unknown>) {
    return {
      id: 1001,
      from: FROM,
      to: 0xffffffff,
      channel: PRIVATE_SLOT,
      // Unknown portnum: the generic node stamp runs, no port handler does.
      decoded: { portnum: 999, payload: new Uint8Array() },
      rxTime: nowSec - 5,
      hopStart: 3,
      hopLimit: 3,
      relayNode: FROM & 0xff,
      transportMechanism: 1,
      ...overrides,
    };
  }

  function stampedChannel(): unknown {
    const call = mockUpsertNodeAsync.mock.calls.find(c => c[0]?.nodeNum === FROM);
    expect(call).toBeDefined();
    return call![0].channel;
  }

  it('records the channel for a packet our radio decoded on that channel', async () => {
    await manager.processMeshPacket(packet({}));
    expect(stampedChannel()).toBe(PRIVATE_SLOT);
  });

  it('does not record a PKI packet on slot 0', async () => {
    await manager.processMeshPacket(packet({ channel: 0, to: 0xaaaaaaaa, pkiEncrypted: true }));
    expect(stampedChannel()).toBeUndefined();
  });

  it('does not record a zero-hop reply another node sent in this node\'s name', async () => {
    await manager.processMeshPacket(
      packet({ decoded: { portnum: 4, payload: new Uint8Array(), requestId: 55 }, to: 0xaaaaaaaa, hopStart: 0, hopLimit: 0, relayNode: 0x42 }),
    );
    expect(stampedChannel()).toBeUndefined();
  });

  it('does not record a channel hash leaked into the channel field', async () => {
    await manager.processMeshPacket(packet({ channel: 0xa7 }));
    expect(stampedChannel()).toBeUndefined();
  });

  it('does not record a Virtual Node MQTT-proxy envelope', async () => {
    await manager.processMeshPacket(packet({ viaMqtt: true }), { skipVirtualNodeBroadcast: true, fromMqttProxy: true });
    expect(stampedChannel()).toBeUndefined();
  });
});
