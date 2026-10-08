import { describe, it, expect } from 'vitest';
import {
  TMM_MIRROR_FIRMWARE_VERSION,
  MIN_RATE_LIMIT_WINDOWS,
  PHASE_PERIOD_MS,
  PHASE_STEP_MS,
  SWEEP_PHASE_STEPS,
  POS_TICK_MS,
  RATE_TICK_MS,
  effectivePositionDedup,
  effectiveRateLimit,
  positionFingerprint,
  truncateCoordinate,
  dedupPrecisionForChannel,
  isWellKnownChannel,
  replayOnce,
  simulateTrafficReplay,
  type ReplayChannel,
  type ReplayInput,
  type ReplayPacket,
  type ReplaySettings,
  type RuleOutcome,
} from './trafficManagementReplay';

const LOCAL = 0x0a0a0a0a;
const BROADCAST = 0xffffffff;
const ALICE = 0x11111111;
const BOB = 0x22222222;
const MIN = 60_000;
const HOUR = 60 * MIN;
// A multiple of 30 min, so boot offset 0 puts a dedup tick AND a rate tick at T0.
const T0 = 1_800_000 * 1000;

const OFF: ReplaySettings = { positionMinIntervalSecs: 0, rateLimitWindowSecs: 0, rateLimitMaxPackets: 0 };
const channels = new Map<number, ReplayChannel>([
  [0, { wellKnown: true, positionPrecision: 13 }],
  [1, { wellKnown: false, positionPrecision: 32 }],
]);

const HERE = { latitudeI: 407_000_000, longitudeI: -740_000_000 };
const FAR = { latitudeI: 417_000_000, longitudeI: -750_000_000 };

function pkt(atMs: number, over: Partial<ReplayPacket> = {}): ReplayPacket {
  return {
    timestampMs: T0 + atMs,
    from: ALICE,
    to: BROADCAST,
    channel: 0,
    portnum: 1,
    decodedByNode: true,
    ...over,
  };
}
const pos = (atMs: number, over: Partial<ReplayPacket> = {}): ReplayPacket =>
  pkt(atMs, { portnum: 3, position: HERE, ...over });

const ctx = (packets: ReplayPacket[], roles: Array<[number, number]> = []) => ({
  packets,
  localNodeNum: LOCAL,
  channels,
  senderRoles: new Map(roles),
});

function input(packets: ReplayPacket[], proposed: Partial<ReplaySettings>, over: Partial<ReplayInput> = {}): ReplayInput {
  return {
    loggingEnabled: true,
    truncated: false,
    scanCap: 50_000,
    current: OFF,
    proposed: { ...OFF, ...proposed },
    ...ctx(packets),
    ...over,
  };
}

function est(outcome: RuleOutcome) {
  if (outcome.status !== 'estimate') throw new Error(`expected an estimate, got ${JSON.stringify(outcome)}`);
  return outcome;
}
function refusal(outcome: RuleOutcome) {
  if (outcome.status !== 'cannot_estimate') throw new Error(`expected a refusal, got ${outcome.status}`);
  return outcome.reason;
}

describe('firmware mirror pin', () => {
  // Touch this only after re-reading handleReceived, shouldDropPosition,
  // isRateLimited and runOnce in TrafficManagementModule.cpp at the new tag.
  it('names the firmware tag the rules were copied from', () => {
    expect(TMM_MIRROR_FIRMWARE_VERSION).toBe('v2.8.1.8e6a88d');
  });

  it('reports that tag in every result', () => {
    expect(simulateTrafficReplay(input([], {})).firmwareVersion).toBe('v2.8.1.8e6a88d');
  });
});

describe('position arithmetic', () => {
  it('truncates to the cell centre like truncateCoordinate', () => {
    // 13 bits: keep the top 13, add half a cell (1 << 18).
    expect(truncateCoordinate(0x12345678, 13)).toBe(((0x12345678 & 0xfff80000) + 0x40000) | 0);
    expect(truncateCoordinate(-740_000_000, 13)).toBe((((-740_000_000 >>> 0) & 0xfff80000) + 0x40000) | 0);
    expect(truncateCoordinate(123, 0)).toBe(123);
    expect(truncateCoordinate(123, 32)).toBe(123);
  });

  it('builds the fingerprint from the low 4 significant bits of each coordinate', () => {
    // precision 8: bits 24..31 are significant, the low 4 of those are bits 24..27.
    const lat = 0x5a000000; // significant byte 0x5a -> low nibble 0xa
    const lon = 0x3c000000; // -> 0xc
    expect(positionFingerprint(lat, lon, 8)).toBe(0xac);
  });

  it('remaps a computed 0 to 0xFF (0 means "no position seen")', () => {
    expect(positionFingerprint(0x50000000, 0x30000000, 8)).toBe(0xff);
  });

  it('takes the channel precision, capped at 15 bits, else the 19-bit default', () => {
    expect(dedupPrecisionForChannel({ wellKnown: true, positionPrecision: 13 })).toBe(13);
    expect(dedupPrecisionForChannel({ wellKnown: true, positionPrecision: 32 })).toBe(15);
    expect(dedupPrecisionForChannel({ wellKnown: true, positionPrecision: 0 })).toBe(19);
    expect(dedupPrecisionForChannel(undefined)).toBe(19);
  });
});

describe('well-known channel', () => {
  const ch = (over: Partial<Parameters<typeof isWellKnownChannel>[0]>) =>
    isWellKnownChannel({ index: 0, name: 'LongFast', pskByteLength: 1, usePreset: true, ...over });

  it('needs a PSK of at most one byte and a modem preset name', () => {
    expect(ch({})).toBe(true);
    expect(ch({ pskByteLength: 0, name: 'MediumFast' })).toBe(true);
    expect(ch({ pskByteLength: 32 })).toBe(false);
    expect(ch({ pskByteLength: 16 })).toBe(false);
    expect(ch({ name: 'gauntlet' })).toBe(false);
  });

  it('reads an empty name as the current preset name, or "Custom" without a preset', () => {
    expect(ch({ name: '' })).toBe(true);
    expect(ch({ name: '', usePreset: false })).toBe(false);
    expect(ch({ index: 2, name: 'Channel 2' })).toBe(true);
    expect(ch({ index: 2, name: 'Channel 3' })).toBe(false);
  });
});

describe('effective settings', () => {
  it('quantises the dedup interval to 6 minute ticks, minimum one', () => {
    expect(effectivePositionDedup(0).enabled).toBe(false);
    expect(effectivePositionDedup(5 * 3600)).toMatchObject({ ticks: 50, effectiveMs: 5 * HOUR, sweepReset: false });
    expect(effectivePositionDedup(719)).toMatchObject({ ticks: 1, effectiveMs: POS_TICK_MS });
    expect(effectivePositionDedup(720)).toMatchObject({ ticks: 2 });
    expect(effectivePositionDedup(10_000_000).ticks).toBe(255);
  });

  it('caps trackers at 1 h and lost-and-found at 15 min, and never lengthens', () => {
    expect(effectivePositionDedup(5 * 3600, 5).effectiveMs).toBe(HOUR); // TRACKER
    expect(effectivePositionDedup(5 * 3600, 10).effectiveMs).toBe(HOUR); // TAK_TRACKER
    expect(effectivePositionDedup(5 * 3600, 9).effectiveMs).toBe(12 * MIN); // LOST_AND_FOUND: 15 min = 2 ticks
    expect(effectivePositionDedup(600, 5).effectiveMs).toBe(POS_TICK_MS);
    expect(effectivePositionDedup(0, 9).enabled).toBe(false);
  });

  it('marks a dedup interval under 90 s as reset by the 60 s sweep', () => {
    expect(effectivePositionDedup(89)).toMatchObject({ sweepReset: true, effectiveMs: 60_000 });
    expect(effectivePositionDedup(90)).toMatchObject({ sweepReset: false, effectiveMs: POS_TICK_MS });
  });

  it('quantises the rate window to 5 minute ticks, clamped 1 to 15', () => {
    expect(effectiveRateLimit(0, 10).enabled).toBe(false);
    expect(effectiveRateLimit(300, 0).enabled).toBe(false);
    expect(effectiveRateLimit(300, 10)).toMatchObject({ ticks: 1, effectiveMs: RATE_TICK_MS });
    expect(effectiveRateLimit(599, 10).ticks).toBe(1);
    expect(effectiveRateLimit(600, 10).ticks).toBe(2);
    expect(effectiveRateLimit(100_000, 10).ticks).toBe(15);
  });

  it('caps the threshold at 60', () => {
    expect(effectiveRateLimit(300, 60).threshold).toBe(60);
    expect(effectiveRateLimit(300, 500).threshold).toBe(60);
  });

  it('marks a rate window under 150 s as reset by the 60 s sweep', () => {
    expect(effectiveRateLimit(149, 5)).toMatchObject({ sweepReset: true, effectiveMs: 60_000 });
    expect(effectiveRateLimit(150, 5)).toMatchObject({ sweepReset: false, effectiveMs: RATE_TICK_MS });
  });
});

describe('position dedup, one pass at a known phase', () => {
  const dedup = (secs: number): ReplaySettings => ({ ...OFF, positionMinIntervalSecs: secs });

  it('drops a repeat of the same cell inside the window and passes it after', () => {
    const packets = [pos(0), pos(30 * MIN), pos(59 * MIN), pos(60 * MIN)];
    // 1 h = 10 ticks. The 60 min packet is 10 ticks on: outside.
    expect(replayOnce(ctx(packets), dedup(3600))).toEqual(['pass', 'dedup', 'dedup', 'pass']);
  });

  it('measures the window from the last position that PASSED, not the last seen', () => {
    // 12 min window = 2 ticks. Drops at 6 min must not slide the window.
    const packets = [pos(0), pos(6 * MIN), pos(12 * MIN), pos(18 * MIN)];
    expect(replayOnce(ctx(packets), dedup(720))).toEqual(['pass', 'dedup', 'pass', 'dedup']);
  });

  it('passes a move to another cell and then judges against the new cell', () => {
    const packets = [pos(0), pos(MIN, { position: FAR }), pos(2 * MIN, { position: FAR }), pos(3 * MIN)];
    expect(replayOnce(ctx(packets), dedup(3600))).toEqual(['pass', 'pass', 'dedup', 'pass']);
  });

  it('works in whole ticks: the same gap drops or passes with the tick phase', () => {
    // Window 6 min = 1 tick; packets 2 min apart.
    const packets = [pos(3 * MIN), pos(5 * MIN)];
    expect(replayOnce(ctx(packets), dedup(360), 0)).toEqual(['pass', 'dedup']); // both in tick 0
    expect(replayOnce(ctx(packets), dedup(360), 4 * MIN)).toEqual(['pass', 'pass']); // a boundary at 4 min
  });

  it('keys on the sender', () => {
    const packets = [pos(0), pos(MIN, { from: BOB }), pos(2 * MIN), pos(3 * MIN, { from: BOB })];
    expect(replayOnce(ctx(packets), dedup(3600))).toEqual(['pass', 'pass', 'dedup', 'dedup']);
  });

  it('caps a tracker at 1 h and a lost-and-found node at 15 min', () => {
    const packets = [pos(0), pos(30 * MIN), pos(90 * MIN)];
    const five = dedup(5 * 3600);
    expect(replayOnce(ctx(packets), five)).toEqual(['pass', 'dedup', 'dedup']);
    expect(replayOnce(ctx(packets, [[ALICE, 5]]), five)).toEqual(['pass', 'dedup', 'pass']);
    expect(replayOnce(ctx(packets, [[ALICE, 9]]), five)).toEqual(['pass', 'pass', 'pass']);
  });

  it('only acts on POSITION, on a well-known channel, with both coordinates', () => {
    const packets = [
      pos(0),
      pos(MIN, { channel: 1 }), // private channel
      pos(2 * MIN, { position: null }), // no coordinates
      pkt(3 * MIN, { portnum: 67 }), // telemetry
      pos(4 * MIN),
    ];
    expect(replayOnce(ctx(packets), dedup(3600))).toEqual(['pass', 'pass', 'pass', 'pass', 'dedup']);
  });

  it('never applies to our own packets or packets addressed to us', () => {
    const packets = [
      pos(0),
      pos(MIN, { from: LOCAL }),
      pos(2 * MIN, { isTx: true }),
      pos(3 * MIN, { to: LOCAL }),
      pos(4 * MIN),
    ];
    expect(replayOnce(ctx(packets), dedup(3600))).toEqual(['pass', 'exempt', 'exempt', 'exempt', 'dedup']);
  });

  it('is off at 0', () => {
    expect(replayOnce(ctx([pos(0), pos(MIN)]), dedup(0))).toEqual(['pass', 'pass']);
  });

  it('forgets everything at each 60 s sweep when the interval is under 90 s', () => {
    const packets = [pos(10_000), pos(50_000), pos(70_000)];
    // Sweeps at 0, 60 s, ...: the third packet follows a sweep.
    expect(replayOnce(ctx(packets), dedup(60), 0, 0)).toEqual(['pass', 'dedup', 'pass']);
    // Sweeps at 30 s, 90 s: the second packet follows one, the third does not.
    expect(replayOnce(ctx(packets), dedup(60), 0, 30_000)).toEqual(['pass', 'pass', 'dedup']);
  });
});

describe('rate limit, one pass at a known phase', () => {
  const rate = (windowSecs: number, max: number): ReplaySettings => ({
    ...OFF,
    rateLimitWindowSecs: windowSecs,
    rateLimitMaxPackets: max,
  });
  const burst = (count: number, startMs: number, stepMs: number, over: Partial<ReplayPacket> = {}) =>
    Array.from({ length: count }, (_, i) => pkt(startMs + i * stepMs, over));

  it('passes `max` packets per window and drops the rest', () => {
    const verdicts = replayOnce(ctx(burst(5, 0, 1000)), rate(300, 3));
    expect(verdicts).toEqual(['pass', 'pass', 'pass', 'rate', 'rate']);
  });

  it('uses a fixed window that restarts at the next tick, not a sliding one', () => {
    // 3 packets late in tick 0, 3 early in tick 1: six in 20 s, none dropped.
    const packets = [...burst(3, 5 * MIN - 10_000, 1000), ...burst(3, 5 * MIN, 1000)];
    expect(replayOnce(ctx(packets), rate(300, 3), 0)).not.toContain('rate');
    // Move the boundary away and the same six fall in one window.
    expect(replayOnce(ctx(packets), rate(300, 3), MIN).filter((v) => v === 'rate')).toHaveLength(3);
  });

  it('treats every window under 10 minutes as one 5 minute tick', () => {
    const packets = [...burst(2, 0, 1000), ...burst(2, 5 * MIN + 1000, 1000)];
    for (const windowSecs of [150, 300, 420, 599]) {
      expect(replayOnce(ctx(packets), rate(windowSecs, 2), 0)).toEqual(['pass', 'pass', 'pass', 'pass']);
    }
    // 600 s is two ticks: the second pair lands in the same window.
    expect(replayOnce(ctx(packets), rate(600, 2), 0)).toEqual(['pass', 'pass', 'rate', 'rate']);
  });

  it('counts per sender, across ports', () => {
    const packets = [
      pkt(0, { portnum: 1 }),
      pkt(1000, { portnum: 67 }),
      pkt(2000, { portnum: 4 }),
      pkt(3000, { from: BOB }),
    ];
    expect(replayOnce(ctx(packets), rate(300, 2))).toEqual(['pass', 'pass', 'rate', 'pass']);
  });

  it('never counts or drops ROUTING and ADMIN packets', () => {
    const packets = [
      pkt(0),
      pkt(1000, { portnum: 5 }),
      pkt(2000, { portnum: 6 }),
      pkt(3000),
      pkt(4000, { portnum: 5 }),
      pkt(5000),
    ];
    expect(replayOnce(ctx(packets), rate(300, 2))).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'rate']);
  });

  it('never applies to our own packets or packets addressed to us', () => {
    const packets = [pkt(0), pkt(1000, { from: LOCAL }), pkt(2000, { to: LOCAL }), pkt(3000), pkt(4000)];
    expect(replayOnce(ctx(packets), rate(300, 2))).toEqual(['pass', 'exempt', 'exempt', 'pass', 'rate']);
  });

  it('does not count packets the node could not decode, server-decrypted ones included', () => {
    const packets = [
      pkt(0),
      pkt(1000, { decodedByNode: false }),
      pkt(2000, { decodedByNode: false, serverDecrypted: true }),
      pkt(3000),
      pkt(4000),
    ];
    expect(replayOnce(ctx(packets), rate(300, 2))).toEqual(['pass', 'exempt', 'exempt', 'pass', 'rate']);
  });

  it('caps the threshold at 60: a limit of 500 still drops the 61st packet', () => {
    const verdicts = replayOnce(ctx(burst(62, 0, 100)), rate(300, 500));
    expect(verdicts.slice(0, 60)).not.toContain('rate');
    expect(verdicts.slice(60)).toEqual(['rate', 'rate']);
  });

  it('is off unless both values are non-zero', () => {
    expect(replayOnce(ctx(burst(5, 0, 1000)), rate(300, 0))).not.toContain('rate');
    expect(replayOnce(ctx(burst(5, 0, 1000)), rate(0, 1))).not.toContain('rate');
  });

  it('zeroes the counter at each 60 s sweep when the window is under 150 s', () => {
    const packets = [pkt(10_000), pkt(20_000), pkt(50_000), pkt(70_000), pkt(80_000)];
    expect(replayOnce(ctx(packets), rate(120, 2), 0, 0)).toEqual(['pass', 'pass', 'rate', 'pass', 'pass']);
  });
});

describe('rule order', () => {
  const both: ReplaySettings = { positionMinIntervalSecs: 3600, rateLimitWindowSecs: 300, rateLimitMaxPackets: 2 };

  it('runs dedup first, and a position dedup drops is not counted by the limiter', () => {
    const packets = [
      pos(0), // passes dedup, limiter count 1
      pos(1000), // dedup drop: NOT counted
      pos(2000), // dedup drop: NOT counted
      pkt(3000), // count 2
      pkt(4000), // count 3 > 2
    ];
    expect(replayOnce(ctx(packets), both)).toEqual(['pass', 'dedup', 'dedup', 'pass', 'rate']);
  });

  it('counts a position that passes dedup, and stamps it even when the limiter drops it', () => {
    const packets = [
      pkt(0),
      pkt(1000),
      pos(2000), // passes dedup (first), limiter drops it (count 3)
      pos(6 * MIN), // new limiter window; dedup still remembers the stamp
    ];
    expect(replayOnce(ctx(packets), both)).toEqual(['pass', 'pass', 'rate', 'dedup']);
  });
});

describe('the estimate', () => {
  const steady = (hours: number, everyMs: number, make: (at: number) => ReplayPacket) =>
    Array.from({ length: Math.floor((hours * HOUR) / everyMs) + 1 }, (_, i) => make(i * everyMs));

  it('reports a range over the sampled tick phases, not one number', () => {
    // Four pairs of positions 2 min apart, with a one-tick (6 min) window. A
    // pair shares a tick, and the repeat drops, only when no boundary falls
    // between the two; that depends on when the node booted.
    const pairs = [0, 1, 2, 3].flatMap((k) => [pos(k * HOUR + 3 * MIN), pos(k * HOUR + 5 * MIN)]);
    const result = simulateTrafficReplay(input(pairs, { positionMinIntervalSecs: 360 }));
    const dedup = est(result.positionDedup);
    expect(result.phasesSampled).toBe(PHASE_PERIOD_MS / PHASE_STEP_MS);
    expect(dedup.droppedMin).toBe(0);
    expect(dedup.droppedMax).toBe(4);
    expect(dedup.caveats).toContain('TICK_PHASE_UNKNOWN');
  });

  it('samples sweep offsets too when a setting is short enough for the sweep to reset it', () => {
    const result = simulateTrafficReplay(input(steady(1, 20_000, pos), { positionMinIntervalSecs: 60 }));
    expect(result.phasesSampled).toBe((PHASE_PERIOD_MS / PHASE_STEP_MS) * SWEEP_PHASE_STEPS);
    expect(est(result.positionDedup).caveats).toContain('SWEEP_RESETS_SHORT_WINDOW');
  });

  it('labels rate limit a lower bound and dedup as logged packets only', () => {
    const packets = steady(1, 10_000, pkt).concat(steady(1, 10_000, pos));
    const result = simulateTrafficReplay(
      input(packets, { positionMinIntervalSecs: 360, rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }),
    );
    const rate = est(result.rateLimit);
    expect(rate.bound).toBe('lower_bound');
    expect(rate.caveats).toContain('RELAYED_UNICAST_INVISIBLE');
    expect(rate.droppedMin).toBeGreaterThan(0);
    const dedup = est(result.positionDedup);
    expect(dedup.bound).toBe('logged_only');
    expect(dedup.caveats).toContain('NET_CHANGE_MAY_BE_SMALLER');
    expect(dedup.caveats).toContain('SENDER_ROLE_FROM_MESHMONITOR');
  });

  it('never returns a bare zero: every estimate carries the already-filtered caveat', () => {
    // One packet an hour: nothing would be dropped.
    const result = simulateTrafficReplay(
      input(steady(6, HOUR, pkt), { rateLimitWindowSecs: 300, rateLimitMaxPackets: 50 }),
    );
    const rate = est(result.rateLimit);
    expect(rate.droppedMin).toBe(0);
    expect(rate.droppedMax).toBe(0);
    for (const caveat of ['ALREADY_FILTERED_ABSENT', 'EMPTY_CACHE_AT_START', 'CACHE_LOSS_NOT_MODELLED', 'LOCAL_NODE_ONLY'] as const) {
      expect(rate.caveats).toContain(caveat);
    }
  });

  it('counts only what tightening adds on top of the current settings', () => {
    // 10 packets in every 5 min tick. The node already limits to 8 per window,
    // so the log it left holds at most 8; here the "log" is the raw 10, and the
    // baseline run removes the 2 the current setting drops.
    const packets = steady(2, 30_000, pkt);
    const current: ReplaySettings = { ...OFF, rateLimitWindowSecs: 300, rateLimitMaxPackets: 8 };
    const fromOff = est(simulateTrafficReplay(input(packets, { rateLimitWindowSecs: 300, rateLimitMaxPackets: 6 })).rateLimit);
    const fromEight = est(
      simulateTrafficReplay(input(packets, { rateLimitWindowSecs: 300, rateLimitMaxPackets: 6 }, { current })).rateLimit,
    );
    // 24 full windows: 4 per window from off, 2 per window on top of a limit of 8.
    expect(fromOff.droppedMax).toBeGreaterThanOrEqual(24 * 4 - 4);
    expect(fromEight.droppedMax).toBeLessThanOrEqual(24 * 2);
    expect(fromEight.droppedMax).toBeGreaterThan(0);
    expect(fromEight.droppedMax).toBeLessThan(fromOff.droppedMin);
  });

  it('breaks the drops down by sender and port, and folds hidden ones into "other"', () => {
    const packets = [
      ...steady(1, 10_000, (at) => pkt(at, { from: ALICE, portnum: 1 })),
      ...steady(1, 20_000, (at) => pkt(at + 1, { from: BOB, portnum: 67, senderHidden: true, portHidden: true })),
    ];
    const rate = est(simulateTrafficReplay(input(packets, { rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 })).rateLimit);
    expect(rate.bySender.map((r) => r.key)).toEqual([ALICE, null]);
    expect(rate.byPortnum.map((r) => r.key)).toEqual([1, null]);
    expect(JSON.stringify(rate)).not.toContain(String(BOB));
    const other = rate.bySender[1];
    expect(other.max).toBeGreaterThan(0);
    // Named rows plus "other" add up to the total at the extremes.
    expect(rate.bySender[0].min + other.min).toBeLessThanOrEqual(rate.droppedMax);
    expect(rate.bySender[0].max + other.max).toBeGreaterThanOrEqual(rate.droppedMin);
  });

  it('reports rows it skipped, and flags server-decrypted ones', () => {
    const packets = [
      ...steady(1, 30_000, pkt),
      pkt(1, { from: LOCAL }),
      pkt(2, { to: LOCAL }),
      pkt(3, { decodedByNode: false }),
      pkt(4, { decodedByNode: false, serverDecrypted: true }),
    ];
    const result = simulateTrafficReplay(input(packets, { rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }));
    expect(result.skipped).toEqual({ ownPackets: 1, addressedToNode: 1, encrypted: 1, serverDecrypted: 1 });
    expect(est(result.rateLimit).caveats).toContain('SERVER_DECRYPTED_NOT_COUNTED');
    expect(est(result.rateLimit).consideredPackets).toBe(121);
  });

  it('says so when the scan was cut short', () => {
    const result = simulateTrafficReplay(
      input(steady(1, 30_000, pkt), { rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }, { truncated: true }),
    );
    expect(result.truncated).toBe(true);
    expect(est(result.rateLimit).caveats).toContain('SCAN_TRUNCATED');
  });

  it('sorts rows that arrive out of order', () => {
    const packets = steady(1, 10_000, pkt);
    const forward = simulateTrafficReplay(input(packets, { rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }));
    const reversed = simulateTrafficReplay(input([...packets].reverse(), { rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }));
    expect(reversed.rateLimit).toEqual(forward.rateLimit);
  });
});

describe('refusals', () => {
  const day = Array.from({ length: 24 * 6 + 1 }, (_, i) => pkt(i * 10 * MIN));

  it('refuses both rules when packet logging is off, even with rows in the log', () => {
    const result = simulateTrafficReplay(
      input(day, { positionMinIntervalSecs: 3600, rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }, { loggingEnabled: false }),
    );
    expect(refusal(result.positionDedup)).toBe('PACKET_LOG_DISABLED');
    expect(refusal(result.rateLimit)).toBe('PACKET_LOG_DISABLED');
    expect(result.phasesSampled).toBe(0);
  });

  it('refuses dedup when the log is shorter than the proposed window', () => {
    const twoHours = day.filter((p) => p.timestampMs <= T0 + 2 * HOUR);
    const result = simulateTrafficReplay(input(twoHours, { positionMinIntervalSecs: 5 * 3600 }));
    expect(refusal(result.positionDedup)).toBe('HISTORY_TOO_SHORT');
    expect(result.positionDedup).toMatchObject({ historySpanMs: 2 * HOUR, requiredSpanMs: 5 * HOUR });
  });

  it('estimates dedup once the log covers one window', () => {
    const fiveHours = day.filter((p) => p.timestampMs <= T0 + 5 * HOUR);
    expect(simulateTrafficReplay(input(fiveHours, { positionMinIntervalSecs: 5 * 3600 })).positionDedup.status).toBe('estimate');
  });

  it(`refuses rate limit with fewer than ${MIN_RATE_LIMIT_WINDOWS} windows of history`, () => {
    expect(MIN_RATE_LIMIT_WINDOWS).toBe(6);
    const almost = day.filter((p) => p.timestampMs < T0 + 30 * MIN);
    const result = simulateTrafficReplay(input(almost, { rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }));
    expect(refusal(result.rateLimit)).toBe('HISTORY_TOO_SHORT');
    expect(result.rateLimit.requiredSpanMs).toBe(6 * RATE_TICK_MS);

    const enough = day.filter((p) => p.timestampMs <= T0 + 30 * MIN);
    expect(simulateTrafficReplay(input(enough, { rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 })).rateLimit.status).toBe('estimate');
  });

  it('refuses with an empty log', () => {
    const result = simulateTrafficReplay(input([], { positionMinIntervalSecs: 3600, rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }));
    expect(refusal(result.positionDedup)).toBe('HISTORY_TOO_SHORT');
    expect(refusal(result.rateLimit)).toBe('HISTORY_TOO_SHORT');
  });

  it('refuses a dedup interval shorter than the current one, or turning dedup off', () => {
    const current: ReplaySettings = { ...OFF, positionMinIntervalSecs: 3600 };
    expect(refusal(simulateTrafficReplay(input(day, { positionMinIntervalSecs: 1800 }, { current })).positionDedup)).toBe('LOOSER_THAN_CURRENT');
    expect(refusal(simulateTrafficReplay(input(day, { positionMinIntervalSecs: 0 }, { current })).positionDedup)).toBe('LOOSER_THAN_CURRENT');
  });

  it('refuses a rate limit with a higher threshold, a shorter window, or turned off', () => {
    const current: ReplaySettings = { ...OFF, rateLimitWindowSecs: 600, rateLimitMaxPackets: 10 };
    const run = (proposed: Partial<ReplaySettings>) => simulateTrafficReplay(input(day, proposed, { current })).rateLimit;
    expect(refusal(run({ rateLimitWindowSecs: 600, rateLimitMaxPackets: 11 }))).toBe('LOOSER_THAN_CURRENT');
    expect(refusal(run({ rateLimitWindowSecs: 300, rateLimitMaxPackets: 10 }))).toBe('LOOSER_THAN_CURRENT');
    // Mixed: fewer packets but a shorter window is not a pure tightening.
    expect(refusal(run({ rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }))).toBe('LOOSER_THAN_CURRENT');
    expect(refusal(run({ rateLimitWindowSecs: 0, rateLimitMaxPackets: 0 }))).toBe('LOOSER_THAN_CURRENT');
    expect(run({ rateLimitWindowSecs: 600, rateLimitMaxPackets: 5 }).status).toBe('estimate');
  });

  it('warns that a longer window with the limiter already on may overstate the net change', () => {
    const current: ReplaySettings = { ...OFF, rateLimitWindowSecs: 300, rateLimitMaxPackets: 10 };
    const outcome = est(simulateTrafficReplay(input(day, { rateLimitWindowSecs: 900, rateLimitMaxPackets: 10 }, { current })).rateLimit);
    expect(outcome.caveats).toContain('NET_CHANGE_MAY_BE_SMALLER');
  });

  it('says "unchanged", not zero, when the proposed value acts like the current one', () => {
    const current: ReplaySettings = { positionMinIntervalSecs: 400, rateLimitWindowSecs: 300, rateLimitMaxPackets: 80 };
    // 500 s is still one dedup tick; 420 s is still one rate tick; 70 caps at 60 like 80.
    const result = simulateTrafficReplay(
      input(day, { positionMinIntervalSecs: 500, rateLimitWindowSecs: 420, rateLimitMaxPackets: 70 }, { current }),
    );
    expect(result.positionDedup.status).toBe('unchanged');
    expect(result.rateLimit.status).toBe('unchanged');
    expect(result.phasesSampled).toBe(0);
  });

  it('holds a refused rule at its current value and tells the other rule', () => {
    const current: ReplaySettings = { ...OFF, positionMinIntervalSecs: 3600 };
    const result = simulateTrafficReplay(
      input(day, { positionMinIntervalSecs: 600, rateLimitWindowSecs: 300, rateLimitMaxPackets: 5 }, { current }),
    );
    expect(refusal(result.positionDedup)).toBe('LOOSER_THAN_CURRENT');
    expect(est(result.rateLimit).caveats).toContain('OTHER_RULE_HELD_AT_CURRENT');
  });
});
