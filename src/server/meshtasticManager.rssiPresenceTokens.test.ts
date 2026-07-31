import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshtasticManager } from './meshtasticManager.js';
import databaseService from '../services/database.js';

// Firmware 2.8 gave MeshPacket.rx_rssi explicit presence (`optional int32
// rx_rssi = 12`, firmware PR #11271). An absent field now decodes to null,
// while a genuine 0 dBm reading decodes to 0 and is carried on the wire — 0 dBm
// is a real reading on SX126x/LR11x0/LR20x0 and can even go positive on SX127x.
//
// The pre-2.8 `rxRssi !== 0` guards therefore rendered a real 0 dBm reception as
// "no data". These tests exercise the production token path (not a re-implementation
// of it) so a revert to `!== 0` fails here. See issue #3548.
//
// rx_snr deliberately keeps proto3 implicit presence, so 0 there stays
// indistinguishable from absent and must still render N/A.

vi.mock('../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn().mockResolvedValue(null),
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

describe('{RSSI}/{SNR} token presence semantics (#3548)', () => {
  const SOURCE_ID = 'source-rssi-presence';
  const NODE_ID = '!11223344';
  const FROM_NUM = 0x11223344;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(databaseService.nodes.getNode).mockResolvedValue(null);
    vi.mocked(databaseService.nodes.getActiveNodes).mockResolvedValue([]);
    vi.mocked(databaseService.settings.getSetting).mockResolvedValue(null);
    vi.mocked(databaseService.settings.getSettingForSource).mockResolvedValue(null);
  });

  /** Expand a template through the real replaceAcknowledgementTokens path. */
  const expand = async (template: string, rxSnr?: number, rxRssi?: number) => {
    const manager = new MeshtasticManager(SOURCE_ID);
    return (manager as any).replaceAcknowledgementTokens(
      template,
      NODE_ID,
      FROM_NUM,
      0,          // numberHops
      '2026-07-31',
      '12:00:00',
      0,          // channelIndex
      true,       // isDirectMessage
      rxSnr,
      rxRssi,
      false,      // viaMqtt
    );
  };

  it('renders a present rxRssi of 0 as "0", not "N/A"', async () => {
    await expect(expand('RSSI: {RSSI}', undefined, 0)).resolves.toBe('RSSI: 0');
  });

  it('renders an absent rxRssi as "N/A"', async () => {
    await expect(expand('RSSI: {RSSI}', undefined, undefined)).resolves.toBe('RSSI: N/A');
  });

  it('still renders a normal negative rxRssi', async () => {
    await expect(expand('RSSI: {RSSI}', undefined, -95)).resolves.toBe('RSSI: -95');
  });

  it('renders an rxSnr of 0 as "N/A" (implicit presence keeps 0 ambiguous)', async () => {
    await expect(expand('SNR: {SNR}', 0, undefined)).resolves.toBe('SNR: N/A');
  });

  it('renders a non-zero rxSnr normally', async () => {
    await expect(expand('SNR: {SNR}', 7.5, undefined)).resolves.toBe('SNR: 7.5');
  });
});
