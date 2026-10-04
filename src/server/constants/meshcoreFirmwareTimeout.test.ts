import { describe, it, expect } from 'vitest';
import {
  MESHCORE_FLOOD_WAIT_DEFAULT_MS,
  MESHCORE_FLOOD_WAIT_GRACE_MS,
  MESHCORE_FLOOD_WAIT_MAX_MS,
  MESHCORE_FLOOD_WAIT_MIN_MS,
  MESHCORE_FLOOD_WAIT_MULTIPLIER,
  MESHCORE_RADIO_OP_BACKSTOP_MS,
  MESHCORE_TRACE_BRIDGE_TIMEOUT_MS,
  MESHCORE_TRACE_SOCKET_TIMEOUT_MS,
  meshcoreFloodWaitMs,
  meshcoreSuggestedTimeoutMs,
  meshcoreTraceWaitMs,
} from './meshcoreFirmwareTimeout.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../middleware/requestTimeout.js';

describe('meshcoreFloodWaitMs (#5588)', () => {
  it("pins MeshCore One's flood profile", () => {
    expect(MESHCORE_FLOOD_WAIT_MULTIPLIER).toBe(1.2);
    expect(MESHCORE_FLOOD_WAIT_GRACE_MS).toBe(8_000);
    expect(MESHCORE_FLOOD_WAIT_MIN_MS).toBe(5_000);
    expect(MESHCORE_FLOOD_WAIT_MAX_MS).toBe(60_000);
    expect(MESHCORE_FLOOD_WAIT_DEFAULT_MS).toBe(30_000);
  });

  it('waits 30 s when the hint is 0', () => {
    expect(meshcoreFloodWaitMs(0)).toBe(30_000);
  });

  it('waits 30 s when the hint is absent or garbage', () => {
    expect(meshcoreFloodWaitMs(undefined)).toBe(30_000);
    expect(meshcoreFloodWaitMs(null)).toBe(30_000);
    expect(meshcoreFloodWaitMs(Number.NaN)).toBe(30_000);
    expect(meshcoreFloodWaitMs(-1)).toBe(30_000);
    expect(meshcoreFloodWaitMs('4000')).toBe(30_000);
  });

  it('gives a tiny hint the grace, which already clears the 5 s floor', () => {
    // 1 ms × 1.2 + 8 s. The 8 s grace means no positive hint reaches the
    // 5 s minimum; the clamp still holds the band.
    expect(meshcoreFloodWaitMs(1)).toBe(8_001);
    expect(meshcoreFloodWaitMs(1)).toBeGreaterThanOrEqual(MESHCORE_FLOOD_WAIT_MIN_MS);
  });

  it('caps a large hint at 60 s', () => {
    expect(meshcoreFloodWaitMs(100_000)).toBe(60_000);
    expect(meshcoreFloodWaitMs(0xffffffff)).toBe(60_000);
  });

  it('applies hint × 1.2 + 8 s in the middle of the band', () => {
    expect(meshcoreFloodWaitMs(2_500)).toBe(11_000);
    expect(meshcoreFloodWaitMs(20_000)).toBe(32_000);
  });
});

describe('meshcoreTraceWaitMs (#5588)', () => {
  it('lets an explicit timeout win over the hint', () => {
    expect(meshcoreTraceWaitMs(2_500, 3_000)).toBe(3_000);
    expect(meshcoreTraceWaitMs(0, 90_000)).toBe(90_000);
    expect(meshcoreTraceWaitMs(2_500, '1500')).toBe(1_500);
  });

  it('falls back to the hint when the explicit value is unset or not positive', () => {
    expect(meshcoreTraceWaitMs(2_500)).toBe(11_000);
    expect(meshcoreTraceWaitMs(2_500, undefined)).toBe(11_000);
    expect(meshcoreTraceWaitMs(2_500, 0)).toBe(11_000);
    expect(meshcoreTraceWaitMs(2_500, 'abc')).toBe(11_000);
    expect(meshcoreTraceWaitMs(0)).toBe(30_000);
  });
});

describe('meshcoreSuggestedTimeoutMs', () => {
  it('keeps a positive number and zeroes the rest', () => {
    expect(meshcoreSuggestedTimeoutMs(4_200)).toBe(4_200);
    expect(meshcoreSuggestedTimeoutMs(0)).toBe(0);
    expect(meshcoreSuggestedTimeoutMs(-3)).toBe(0);
    expect(meshcoreSuggestedTimeoutMs(undefined)).toBe(0);
    expect(meshcoreSuggestedTimeoutMs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('trace timeout ladder', () => {
  it('orders wait < radio-op backstop < bridge < HTTP socket', () => {
    // Each layer must outlast the one inside it, so the innermost timer fires
    // first and the HTTP handler always answers before its socket closes.
    expect(MESHCORE_RADIO_OP_BACKSTOP_MS).toBeGreaterThan(MESHCORE_FLOOD_WAIT_MAX_MS);
    expect(MESHCORE_TRACE_BRIDGE_TIMEOUT_MS).toBeGreaterThan(MESHCORE_RADIO_OP_BACKSTOP_MS);
    expect(MESHCORE_TRACE_SOCKET_TIMEOUT_MS).toBeGreaterThan(MESHCORE_TRACE_BRIDGE_TIMEOUT_MS);
    // The longest wait is past the default socket timeout: the route must extend it.
    expect(MESHCORE_FLOOD_WAIT_MAX_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
  });
});
