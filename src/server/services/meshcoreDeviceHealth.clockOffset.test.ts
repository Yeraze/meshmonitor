/**
 * detectClockOffset (#6273): passive clock samples for trigger.clockOutOfSync.
 * Reads and writes the DB only; sends nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dataEventEmitter } from './dataEventEmitter.js';
import {
  detectClockOffset,
  resetClockOffsetThrottleForTests,
  CLOCK_OFFSET_TELEMETRY_TYPE,
  CLOCK_SAMPLE_MIN_INTERVAL_MS,
} from './meshcoreDeviceHealth.js';

const KEY = 'ab'.repeat(32);
const SRC = 'src-a';
const T0 = 1_800_000_000_000; // receipt time, ms

type Row = { value: number; timestamp: number };

function fakeTelemetry(rows: Row[] = []) {
  const stored = [...rows];
  return {
    stored,
    getTelemetryByNode: vi.fn(async () => [...stored].sort((a, b) => b.timestamp - a.timestamp)),
    insertTelemetry: vi.fn(async (r: { value: number; timestamp: number }) => {
      stored.push({ value: r.value, timestamp: r.timestamp });
      return true;
    }),
  };
}

/** A stored row for an advert sent at `senderSec`, received at `atMs`. */
const rowFor = (senderSec: number, atMs: number): Row => ({
  value: Math.floor(atMs / 1000) - senderSec,
  timestamp: atMs,
});

describe('detectClockOffset (#6273)', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetClockOffsetThrottleForTests();
    emitSpy = vi.spyOn(dataEventEmitter, 'emitNodeClockOffset').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('stores an advert sample and emits it with the two prior offsets, newest first', async () => {
    const t = fakeTelemetry([
      rowFor(1_700_000_000, T0 - 3 * CLOCK_SAMPLE_MIN_INTERVAL_MS),
      rowFor(1_700_000_100, T0 - 2 * CLOCK_SAMPLE_MIN_INTERVAL_MS),
      rowFor(1_700_000_200, T0 - CLOCK_SAMPLE_MIN_INTERVAL_MS),
    ]);
    const sender = 1_700_000_300;
    const offset = Math.floor(T0 / 1000) - sender;
    expect(await detectClockOffset(t, KEY, offset, 'advert', sender, SRC, T0)).toBe(true);
    expect(t.insertTelemetry).toHaveBeenCalledTimes(1);
    const inserted = t.insertTelemetry.mock.calls[0][0] as any;
    expect(inserted).toMatchObject({ nodeId: KEY, telemetryType: CLOCK_OFFSET_TELEMETRY_TYPE, value: offset, timestamp: T0 });
    expect(t.insertTelemetry.mock.calls[0][1]).toBe(SRC);
    expect(emitSpy).toHaveBeenCalledWith(
      { publicKey: KEY, offsetSeconds: offset, previousOffsets: [t.stored[2].value, t.stored[1].value], sampleSource: 'advert' },
      SRC,
    );
  });

  it('reads the history with the clock-drift type, scoped to the source', async () => {
    const t = fakeTelemetry();
    await detectClockOffset(t, KEY, 10, 'advert', 1_700_000_000, SRC, T0);
    expect(t.getTelemetryByNode).toHaveBeenCalledWith(KEY, 3, undefined, undefined, 0, CLOCK_OFFSET_TELEMETRY_TYPE, SRC);
  });

  it('drops a replay: a sender time that is not newer than the last sample', async () => {
    const t = fakeTelemetry([rowFor(1_700_000_500, T0 - 2 * CLOCK_SAMPLE_MIN_INTERVAL_MS)]);
    const at = T0;
    // Same sender time (a duplicate copy) and an older one (a replay).
    expect(await detectClockOffset(t, KEY, 5, 'advert', 1_700_000_500, SRC, at)).toBe(false);
    expect(await detectClockOffset(t, KEY, 5, 'advert', 1_700_000_400, SRC, at)).toBe(false);
    expect(t.insertTelemetry).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    // A newer sender time passes.
    expect(await detectClockOffset(t, KEY, 5, 'advert', 1_700_000_501, SRC, at)).toBe(true);
  });

  it('stores at most one advert sample an hour per node', async () => {
    const t = fakeTelemetry();
    expect(await detectClockOffset(t, KEY, 400, 'advert', 1_799_999_000, SRC, T0)).toBe(true);
    expect(await detectClockOffset(t, KEY, 400, 'advert', 1_700_000_100, SRC, T0 + 59 * 60_000)).toBe(false);
    expect(await detectClockOffset(t, KEY, 400, 'advert', 1_800_003_700, SRC, T0 + CLOCK_SAMPLE_MIN_INTERVAL_MS)).toBe(true);
    expect(t.insertTelemetry).toHaveBeenCalledTimes(2);
    // A different node or source has its own budget.
    expect(await detectClockOffset(fakeTelemetry(), 'cd'.repeat(32), 400, 'advert', 1_700_000_000, SRC, T0 + 60_000)).toBe(true);
    expect(await detectClockOffset(fakeTelemetry(), KEY, 400, 'advert', 1_700_000_200, 'src-b', T0 + 60_000)).toBe(true);
  });

  it('ignores a zero sender time', async () => {
    const t = fakeTelemetry();
    expect(await detectClockOffset(t, KEY, 1_800_000_000, 'advert', 0, SRC, T0)).toBe(false);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('device samples emit but never insert, and skip the replay and hourly rules', async () => {
    const t = fakeTelemetry([{ value: 600, timestamp: T0 - 1000 }]);
    expect(await detectClockOffset(t, KEY, 610, 'device', 1_700_000_000, SRC, T0)).toBe(true);
    expect(await detectClockOffset(t, KEY, 610, 'device', 1_700_000_000, SRC, T0 + 1000)).toBe(true);
    expect(t.insertTelemetry).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenLastCalledWith(
      { publicKey: KEY, offsetSeconds: 610, previousOffsets: [600], sampleSource: 'device' },
      SRC,
    );
  });

  it('records nothing when the telemetry store lacks the methods, and never throws', async () => {
    expect(await detectClockOffset({}, KEY, 5, 'advert', 1_700_000_000, SRC, T0)).toBe(false);
    const broken = { getTelemetryByNode: vi.fn().mockRejectedValue(new Error('db down')) };
    expect(await detectClockOffset(broken, KEY, 5, 'advert', 1_700_000_000, SRC, T0)).toBe(false);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
