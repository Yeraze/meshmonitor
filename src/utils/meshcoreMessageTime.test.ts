import { describe, it, expect } from 'vitest';
import {
  MESHCORE_CLOCK_OFFSET_MIN_MS,
  formatMeshCoreClockOffset,
  meshcoreClockOffsetMs,
  meshcoreDisplayTimeMs,
  meshcoreMessageClockOffsetMs,
  meshcoreReceiptTimeMs,
} from './meshcoreMessageTime';

// 8:00:00 PM receipt, whole second.
const RECEIPT = 1785628800000;
const SEC = RECEIPT / 1000;

describe('formatMeshCoreClockOffset', () => {
  it('signs a positive offset with + and a negative one with -', () => {
    expect(formatMeshCoreClockOffset(930_000)).toBe('+15m30s');
    expect(formatMeshCoreClockOffset(-930_000)).toBe('-15m30s');
  });

  it('shows hours, minutes and seconds', () => {
    expect(formatMeshCoreClockOffset(3_723_000)).toBe('+1h2m3s');
    expect(formatMeshCoreClockOffset(45_000)).toBe('+45s');
  });

  it('leaves out zero units', () => {
    expect(formatMeshCoreClockOffset(120_000)).toBe('+2m');
    expect(formatMeshCoreClockOffset(-3_600_000)).toBe('-1h');
    expect(formatMeshCoreClockOffset(3_603_000)).toBe('+1h3s');
    expect(formatMeshCoreClockOffset(3_660_000)).toBe('+1h1m');
  });

  it('rounds to the nearest second', () => {
    expect(formatMeshCoreClockOffset(15_400)).toBe('+15s');
    expect(formatMeshCoreClockOffset(-15_600)).toBe('-16s');
  });
});

describe('meshcoreClockOffsetMs', () => {
  it('is receipt time minus sender time', () => {
    // Sender 7:44:30 PM → +15m30s; sender 8:15:30 PM → -15m30s.
    expect(meshcoreClockOffsetMs(RECEIPT, SEC - 930)).toBe(930_000);
    expect(meshcoreClockOffsetMs(RECEIPT, SEC + 930)).toBe(-930_000);
  });

  it('hides an offset under 5 s, on both sides', () => {
    expect(MESHCORE_CLOCK_OFFSET_MIN_MS).toBe(5_000);
    expect(meshcoreClockOffsetMs(RECEIPT + 4_999, SEC)).toBeNull();
    expect(meshcoreClockOffsetMs(RECEIPT - 4_999, SEC)).toBeNull();
    expect(meshcoreClockOffsetMs(RECEIPT, SEC)).toBeNull();
    expect(meshcoreClockOffsetMs(RECEIPT + 5_000, SEC)).toBe(5_000);
    expect(meshcoreClockOffsetMs(RECEIPT - 5_000, SEC)).toBe(-5_000);
  });

  it('shows no offset for an implausible sender time', () => {
    // More than a day behind (no-RTC default) and more than a day ahead.
    expect(meshcoreClockOffsetMs(RECEIPT, SEC - 2 * 86_400)).toBeNull();
    expect(meshcoreClockOffsetMs(RECEIPT, SEC + 2 * 86_400)).toBeNull();
    // Before MeshCore existed.
    expect(meshcoreClockOffsetMs(RECEIPT, 947_894_400)).toBeNull();
    // Just inside the ±24 h window still shows.
    expect(meshcoreClockOffsetMs(RECEIPT, SEC - 86_000)).toBe(86_000_000);
  });

  it('shows no offset when no sender time is stored', () => {
    expect(meshcoreClockOffsetMs(RECEIPT, null)).toBeNull();
    expect(meshcoreClockOffsetMs(RECEIPT, undefined)).toBeNull();
    expect(meshcoreClockOffsetMs(RECEIPT, 0)).toBeNull();
  });
});

describe('meshcoreMessageClockOffsetMs', () => {
  it('reads the stored wire second against the receipt clock', () => {
    expect(meshcoreMessageClockOffsetMs({
      id: '1', timestamp: (SEC - 930) * 1000, senderTimestamp: SEC - 930, receivedAt: RECEIPT,
    })).toBe(930_000);
  });

  it('falls back to a whole-second received timestamp on rows without senderTimestamp', () => {
    expect(meshcoreMessageClockOffsetMs({ id: '1', timestamp: (SEC - 60) * 1000, createdAt: RECEIPT })).toBe(60_000);
  });

  it('shows none when the server stored the receipt clock (sender time rejected)', () => {
    expect(meshcoreMessageClockOffsetMs({ id: '1', timestamp: RECEIPT + 123, receivedAt: RECEIPT + 123 })).toBeNull();
  });

  it('never shows one on a room post', () => {
    expect(meshcoreMessageClockOffsetMs({
      id: '1', timestamp: (SEC - 930) * 1000, senderTimestamp: SEC - 930, receivedAt: RECEIPT, messageType: 'room_post',
    })).toBeNull();
  });
});

describe('meshcoreDisplayTimeMs / meshcoreReceiptTimeMs', () => {
  it('shows receipt time for DMs and channel messages', () => {
    expect(meshcoreDisplayTimeMs({ id: '1', timestamp: RECEIPT - 930_000, receivedAt: RECEIPT })).toBe(RECEIPT);
    expect(meshcoreDisplayTimeMs({ id: '1', timestamp: RECEIPT - 930_000, createdAt: RECEIPT })).toBe(RECEIPT);
  });

  it('shows sender time for room posts', () => {
    expect(meshcoreDisplayTimeMs({
      id: '1', timestamp: RECEIPT - 930_000, receivedAt: RECEIPT, messageType: 'room_post',
    })).toBe(RECEIPT - 930_000);
  });

  it('prefers receivedAt, then createdAt, then timestamp', () => {
    expect(meshcoreReceiptTimeMs({ timestamp: 1, receivedAt: 3, createdAt: 2 })).toBe(3);
    expect(meshcoreReceiptTimeMs({ timestamp: 1, createdAt: 2 })).toBe(2);
    expect(meshcoreReceiptTimeMs({ timestamp: 1 })).toBe(1);
  });
});
