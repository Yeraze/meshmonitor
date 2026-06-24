/**
 * Tests for MeshCoreManager's channel "heard repeaters" self-echo correlation
 * (#3700).
 *
 * When a nearby repeater re-floods one of OUR outgoing channel messages, the
 * device hears it as an inbound GRP_TXT OTA packet whose relay-hash chain names
 * the relaying repeaters. We correlate that echo (best-effort, window-bounded)
 * to the most recent matching outgoing channel send, dedup repeaters by hash,
 * track max SNR, and broadcast the heard-by set.
 *
 * Two layers are covered:
 *  - `findEchoMatch` (pure): matching, window expiry, dedup, type/path gating.
 *  - `handleBridgeEvent('ota_packet')` (integration): records repeaters and
 *    emits `meshcore:channel-heard`, independent of the packet-monitor gate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const recordHeardRepeater = vi.fn();
const getHeardRepeatersForMessage = vi.fn();
const isEnabled = vi.fn().mockResolvedValue(false);
const emitMeshCoreChannelHeard = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      recordHeardRepeater: (...args: unknown[]) => recordHeardRepeater(...args),
      getHeardRepeatersForMessage: (...args: unknown[]) => getHeardRepeatersForMessage(...args),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreChannelHeard: (...args: unknown[]) => emitMeshCoreChannelHeard(...args),
    emitMeshCoreOtaPacket: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreContactUpdated: vi.fn(),
  },
}));

vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: {
    isEnabled: (...args: unknown[]) => isEnabled(...args),
    logPacket: vi.fn().mockResolvedValue(undefined),
  },
}));

import { MeshCoreManager } from './meshcoreManager.js';

const GRP_TXT = 0x05;

function dispatch(m: MeshCoreManager, evt: { event_type: string; data: Record<string, unknown> }): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent(evt);
}

/** Seed a pending channel send on a manager (mirrors performScopedSend). */
function registerSend(m: MeshCoreManager, messageId: string, channelIdx: number): void {
  // @ts-expect-error - exercising private method
  m.registerPendingChannelSend(messageId, channelIdx);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('MeshCoreManager.findEchoMatch (pure)', () => {
  const WINDOW = 30_000;

  it('matches a GRP_TXT packet to the most recent pending send within window', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['msg-old', { channelIdx: 0, sentAt: now - 5_000 }],
      ['msg-new', { channelIdx: 1, sentAt: now - 1_000 }],
    ]);
    const match = MeshCoreManager.findEchoMatch(
      { payload_type: GRP_TXT, path_hops: ['a3', '7f'] },
      pending,
      now,
      WINDOW,
    );
    expect(match).not.toBeNull();
    expect(match!.messageId).toBe('msg-new');
    expect(match!.channelIdx).toBe(1);
    expect(match!.pathHops).toEqual(['a3', '7f']);
  });

  it('returns null when no pending send is within the window', () => {
    const now = 1_000_000;
    const pending = new Map([['msg-stale', { channelIdx: 0, sentAt: now - (WINDOW + 1) }]]);
    const match = MeshCoreManager.findEchoMatch(
      { payload_type: GRP_TXT, path_hops: ['a3'] },
      pending,
      now,
      WINDOW,
    );
    expect(match).toBeNull();
  });

  it('ignores non-GRP_TXT payload types', () => {
    const now = 1_000_000;
    const pending = new Map([['msg', { channelIdx: 0, sentAt: now }]]);
    const match = MeshCoreManager.findEchoMatch(
      { payload_type: 0x02, path_hops: ['a3'] },
      pending,
      now,
      WINDOW,
    );
    expect(match).toBeNull();
  });

  it('ignores direct/zero-hop packets with no relay chain', () => {
    const now = 1_000_000;
    const pending = new Map([['msg', { channelIdx: 0, sentAt: now }]]);
    expect(
      MeshCoreManager.findEchoMatch({ payload_type: GRP_TXT, path_hops: [] }, pending, now, WINDOW),
    ).toBeNull();
    expect(
      MeshCoreManager.findEchoMatch({ payload_type: GRP_TXT }, pending, now, WINDOW),
    ).toBeNull();
  });

  it('returns null when there are no pending sends', () => {
    const match = MeshCoreManager.findEchoMatch(
      { payload_type: GRP_TXT, path_hops: ['a3'] },
      new Map(),
      1_000_000,
      WINDOW,
    );
    expect(match).toBeNull();
  });

  it('dedups repeated relay hashes and normalises to lowercase', () => {
    const now = 1_000_000;
    const pending = new Map([['msg', { channelIdx: 0, sentAt: now }]]);
    const match = MeshCoreManager.findEchoMatch(
      { payload_type: GRP_TXT, path_hops: ['A3', 'a3', '7F', '7f', 'A3'] },
      pending,
      now,
      WINDOW,
    );
    expect(match!.pathHops).toEqual(['a3', '7f']);
  });
});

describe('MeshCoreManager — channel-heard correlation (integration)', () => {
  beforeEach(() => {
    recordHeardRepeater.mockReset();
    getHeardRepeatersForMessage.mockReset();
    emitMeshCoreChannelHeard.mockReset();
    isEnabled.mockResolvedValue(false); // packet monitor OFF — correlation must still run
  });

  it('records repeaters and emits channel-heard for a self-echo (monitor off)', async () => {
    recordHeardRepeater.mockImplementation(async (r: any) => ({
      sourceId: r.sourceId,
      messageId: r.messageId,
      repeaterHash: r.repeaterHash,
      repeaterName: r.repeaterName ?? null,
      snr: r.snr ?? null,
      heardAt: r.heardAt,
      createdAt: r.heardAt,
    }));
    getHeardRepeatersForMessage.mockResolvedValue([
      { repeaterHash: 'a3', repeaterName: null, snr: 6 },
      { repeaterHash: '7f', repeaterName: null, snr: 4 },
    ]);

    const m = new MeshCoreManager('src-a');
    registerSend(m, 'sent-123', 1);

    dispatch(m, {
      event_type: 'ota_packet',
      data: { payload_type: GRP_TXT, path_hops: ['a3', '7f'], snr: 6 },
    });
    await flush();

    expect(recordHeardRepeater).toHaveBeenCalledTimes(2);
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-a', messageId: 'sent-123', repeaterHash: 'a3', snr: 6 }),
    );
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-a', messageId: 'sent-123', repeaterHash: '7f' }),
    );

    expect(emitMeshCoreChannelHeard).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sent-123',
        heardBy: [
          { hash: 'a3', name: null, snr: 6 },
          { hash: '7f', name: null, snr: 4 },
        ],
      }),
      'src-a',
    );
  });

  it('does not record anything when no pending channel send matches', async () => {
    const m = new MeshCoreManager('src-a');
    // No registerSend — nothing pending.
    dispatch(m, {
      event_type: 'ota_packet',
      data: { payload_type: GRP_TXT, path_hops: ['a3'], snr: 5 },
    });
    await flush();
    expect(recordHeardRepeater).not.toHaveBeenCalled();
    expect(emitMeshCoreChannelHeard).not.toHaveBeenCalled();
  });

  it('ignores inbound DM (non-GRP_TXT) packets', async () => {
    const m = new MeshCoreManager('src-a');
    registerSend(m, 'sent-123', 0);
    dispatch(m, {
      event_type: 'ota_packet',
      data: { payload_type: 0x02, path_hops: ['a3'], snr: 5 },
    });
    await flush();
    expect(recordHeardRepeater).not.toHaveBeenCalled();
    expect(emitMeshCoreChannelHeard).not.toHaveBeenCalled();
  });
});
