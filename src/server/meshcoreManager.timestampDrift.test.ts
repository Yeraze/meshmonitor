/**
 * Regression for issue #5339: a MeshCore node with an unsynced/drifted RTC
 * stamps its outgoing messages with `sender_timestamp` values that aren't
 * real receive times at all — years in the past or future. Storing that
 * verbatim as `message.timestamp` doesn't just display wrong; it's the field
 * `messageOrder.ts` sorts channel/DM streams on, so a message from a
 * drifted-clock node gets pinned at a bogus position (e.g. the very bottom,
 * behind a "2038" timestamp) indefinitely.
 *
 * `timestamp` must fall back to MeshMonitor's own receipt clock whenever the
 * device's stated time is missing or implausible, mirroring the fix already
 * applied to the Meshtastic ingestion paths (`utils/messageTime.ts`, #4206).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const insertMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      insertMessage: (...args: unknown[]) => insertMessage(...args),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      updateLastRoomPostAt: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
  },
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

interface BridgeEvent {
  event_type: string;
  data: Record<string, unknown>;
}

function dispatchBridgeEvent(m: MeshCoreManager, evt: BridgeEvent): void {
  // handleBridgeEvent is private; invoking it directly exercises the
  // message-ingestion path without standing up the native backend.
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent(evt);
}

function makeManager(): MeshCoreManager {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).localNode = { publicKey: 'a'.repeat(64) };
  return m;
}

function lastMessage(m: MeshCoreManager): { timestamp: number; receivedAt?: number } {
  const messages = (m as any).messages as Array<{ timestamp: number; receivedAt?: number }>;
  return messages[messages.length - 1];
}

describe('MeshCoreManager — message timestamp falls back on a drifted sender clock (#5339)', () => {
  const SENDER_PUBKEY = 'c'.repeat(64);
  const fixedNow = 1_800_000_000_000; // ms

  beforeEach(() => {
    insertMessage.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  it('uses the plausible sender_timestamp verbatim for a channel message', () => {
    const m = makeManager();
    dispatchBridgeEvent(m, {
      event_type: 'channel_message',
      data: { channel_idx: 0, text: 'Alice: hi', sender_timestamp: Math.floor(fixedNow / 1000) - 60 },
    });

    expect(lastMessage(m).timestamp).toBe((Math.floor(fixedNow / 1000) - 60) * 1000);
  });

  it('falls back to receipt time for a channel message from a clock stuck in the past (year 2000)', () => {
    const m = makeManager();
    dispatchBridgeEvent(m, {
      event_type: 'channel_message',
      data: { channel_idx: 0, text: 'Bob: hi', sender_timestamp: 946_684_800 }, // 2000-01-01
    });

    expect(lastMessage(m).timestamp).toBe(fixedNow);
  });

  it('falls back to receipt time for a channel message from a clock drifted into the future (year 2087)', () => {
    const m = makeManager();
    dispatchBridgeEvent(m, {
      event_type: 'channel_message',
      data: { channel_idx: 0, text: 'Carol: hi', sender_timestamp: 3_700_000_000 }, // ~2087
    });

    expect(lastMessage(m).timestamp).toBe(fixedNow);
  });

  it('falls back to receipt time for a direct message with an implausible sender clock', () => {
    const m = makeManager();
    dispatchBridgeEvent(m, {
      event_type: 'contact_message',
      data: { pubkey_prefix: SENDER_PUBKEY, text: 'dm', sender_timestamp: 946_684_800 },
    });

    expect(lastMessage(m).timestamp).toBe(fixedNow);
  });

  it('falls back to receipt time for a room post with an implausible sender clock', () => {
    const m = makeManager();
    dispatchBridgeEvent(m, {
      event_type: 'room_message',
      data: {
        room_pubkey_prefix: 'room1',
        author_pubkey_prefix: 'author1',
        text: 'post',
        sender_timestamp: 3_700_000_000,
      },
    });

    expect(lastMessage(m).timestamp).toBe(fixedNow);
  });

  it('falls back to receipt time when sender_timestamp is missing entirely', () => {
    const m = makeManager();
    dispatchBridgeEvent(m, {
      event_type: 'channel_message',
      data: { channel_idx: 0, text: 'Dave: hi' },
    });

    expect(lastMessage(m).timestamp).toBe(fixedNow);
  });
});
