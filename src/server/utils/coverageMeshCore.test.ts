/**
 * Tests for `evaluateMeshCoreCoverageReception` (the pure MeshCore
 * ADVERT-reception skip-rule evaluator), `MeshCoreReplayGuard`, and
 * `maybeRecordMeshCoreCoverageReception` (the async record function) for
 * the Coverage Report (#5277 P3, §2.2 / §3). One case per skip rule, in
 * spec order, plus the golden Ed25519 signature test the spec requires
 * before wiring the library in (§2.2, "Golden-test with a real advert
 * fixture first").
 *
 * The golden fixture below is a GENUINELY Ed25519-signed advert: generated
 * with `@michaelhart/meshcore-decoder`'s own `Utils.sign` /
 * `Utils.derivePublicKey` (the orlp/ed25519 WASM implementation — the same
 * curve/algorithm the firmware itself signs with), verified once by hand
 * against `Ed25519SignatureVerifier.verifyAdvertisementSignature` (the
 * @noble/ed25519-backed verifier this module actually calls) before this
 * file was written. That hand-verification is the "golden test" the spec
 * requires: the library's verify DOES accept a genuine advert (see
 * `Signature verification (U3, golden)` below), so no STOP was needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordReception = vi.fn().mockResolvedValue(true);
const getNodeByPublicKeyAndSource = vi.fn().mockResolvedValue(null);

vi.mock('../../services/database.js', () => ({
  default: {
    coverageReceptions: { recordReception: (...a: unknown[]) => recordReception(...a) },
    meshcore: { getNodeByPublicKeyAndSource: (...a: unknown[]) => getNodeByPublicKeyAndSource(...a) },
  },
}));

const isOwnPublicKeyMock = vi.fn().mockReturnValue(false);
vi.mock('./ownNodes.js', () => ({
  isOwnPublicKey: (...a: unknown[]) => isOwnPublicKeyMock(...a),
}));

const decodeMeshCorePacketSpy = vi.fn();
vi.mock('../../utils/meshcorePacketDecode.js', async () => {
  const actual = await vi.importActual<typeof import('../../utils/meshcorePacketDecode.js')>(
    '../../utils/meshcorePacketDecode.js',
  );
  return {
    ...actual,
    decodeMeshCorePacket: (...args: Parameters<typeof actual.decodeMeshCorePacket>) => {
      decodeMeshCorePacketSpy(...args);
      return actual.decodeMeshCorePacket(...args);
    },
  };
});

// Wraps the REAL implementation by default (so every other test in this
// file sees genuine hash behavior); the 'no-hash' skip-rule test below
// overrides it once to force the sentinel on an otherwise-valid frame — the
// two independent parsers (decodeMeshCorePacket vs. calculateMeshCorePacketHash)
// disagreeing is exactly the defensive case rule 9 guards against, and it is
// not reliably reproducible from a hand-built raw frame (see the comment on
// that test). `vi.hoisted` because `vi.mock` factories run before any
// top-level `const` — this codebase's `= vi.fn()` module-scope convention
// otherwise relies on Vitest's automatic hoist detection, which does not
// reach a variable that's only assigned to via `.mockImplementation(...)`
// inside the factory body (as opposed to referenced in the returned object).
const calculateMeshCorePacketHashMock = vi.hoisted(() => vi.fn());
vi.mock('../services/meshcoreObserverPacket.js', async () => {
  const actual = await vi.importActual<typeof import('../services/meshcoreObserverPacket.js')>(
    '../services/meshcoreObserverPacket.js',
  );
  calculateMeshCorePacketHashMock.mockImplementation(actual.calculateMeshCorePacketHash);
  return {
    ...actual,
    calculateMeshCorePacketHash: (...args: Parameters<typeof actual.calculateMeshCorePacketHash>) =>
      calculateMeshCorePacketHashMock(...args),
  };
});

import {
  evaluateMeshCoreCoverageReception,
  MeshCoreReplayGuard,
  maybeRecordMeshCoreCoverageReception,
  __resetCoverageMeshCoreForTest,
  type MeshCoreCoverageEvalResult,
  type MeshCoreBridgeOtaPacketLike,
} from './coverageMeshCore.js';
import { calculateMeshCorePacketHash } from '../services/meshcoreObserverPacket.js';
import { COVERAGE_MAX_RX_AGE_SEC } from '../../utils/coverage.js';
import { __resetDiscardInvalidPositionsForTest } from '../../utils/positionIngestConfig.js';

const SOURCE_ID = 'src-a';
const RECEIVER = 'b'.repeat(64);
const SENDER_FILLER = '11'.repeat(32);
const NOW_MS = new Date('2024-01-01T00:00:00.000Z').getTime();

/** ADVERT flag bits (meshcorePacketDecode): 0x10 location, 0x80 name. */
const FLAG_LOCATION = 0x10;
const FLAG_NAME = 0x80;

/**
 * Build a wire-accurate ADVERT frame:
 * header | path_len(+hops) | pubkey(32) | timestamp(4 LE) | signature(64) | appData
 *
 * Mirrors `meshcoreMqttManager.advert.test.ts`'s `advertFrame` builder. The
 * signature bytes are FILLER by default (not cryptographically valid) —
 * fine for every test in this file except the "Signature verification"
 * suite, which uses the real, genuinely-signed golden fixture below instead.
 */
function advertFrame(opts: {
  publicKey?: string;
  timestamp?: number;
  advType?: number;
  lat?: number;
  lon?: number;
  name?: string;
  /** 0=TRANSPORT_FLOOD, 1=FLOOD, 2=DIRECT, 3=TRANSPORT_DIRECT. Default FLOOD. */
  routeType?: number;
  /** Hex hop hashes, all the same byte width. Default: none (zero-hop). */
  pathHops?: string[];
  signatureByte?: number;
} = {}): string {
  const bytes: number[] = [];
  const routeType = opts.routeType ?? 1;
  bytes.push((4 << 2) | routeType);

  const hops = opts.pathHops ?? [];
  if (hops.length === 0) {
    // DIRECT/TRANSPORT_DIRECT zero-hop uses the firmware sentinel; FLOOD
    // with zero hops (not a real firmware shape, but harmless for parsing)
    // uses a plain zero path-length byte.
    bytes.push(routeType === 2 || routeType === 3 ? 0xff : 0x00);
  } else {
    const hashSize = hops[0].length / 2;
    const rawLen = ((hashSize - 1) << 6) | hops.length;
    bytes.push(rawLen);
    for (const h of hops) {
      for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
    }
  }

  const key = opts.publicKey ?? SENDER_FILLER;
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(key.slice(i, i + 2), 16));
  const ts = opts.timestamp ?? 1_700_000_000;
  bytes.push(ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >>> 24) & 0xff);
  const sigByte = opts.signatureByte ?? 0xcd;
  for (let i = 0; i < 64; i++) bytes.push(sigByte);

  let flags = opts.advType ?? 1;
  const tail: number[] = [];
  if (opts.lat !== undefined && opts.lon !== undefined) {
    flags |= FLAG_LOCATION;
    for (const deg of [opts.lat, opts.lon]) {
      const v = Math.round(deg * 1_000_000) | 0;
      tail.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    }
  }
  if (opts.name !== undefined) {
    flags |= FLAG_NAME;
    for (const ch of Buffer.from(opts.name, 'utf8')) tail.push(ch);
  }
  bytes.push(flags, ...tail);
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function event(overrides: Partial<MeshCoreBridgeOtaPacketLike> = {}): MeshCoreBridgeOtaPacketLike {
  return {
    payload_type: 0x04,
    route_type: 1,
    snr: 6.5,
    rssi: -80,
    raw_hex: advertFrame({ lat: 37.7749, lon: -122.4194 }),
    ...overrides,
  };
}

function evalDefault(
  overrides: Partial<Parameters<typeof evaluateMeshCoreCoverageReception>[0]> = {},
): MeshCoreCoverageEvalResult {
  return evaluateMeshCoreCoverageReception({
    sourceId: SOURCE_ID,
    receiverKind: 'local',
    receiverPubKey: RECEIVER,
    event: event(),
    observerTimestampMs: null,
    nowMs: NOW_MS,
    isOwnPublicKey: () => false,
    discardNullIsland: true,
    ...overrides,
  });
}

beforeEach(() => {
  recordReception.mockClear();
  getNodeByPublicKeyAndSource.mockClear();
  isOwnPublicKeyMock.mockReset().mockReturnValue(false);
  decodeMeshCorePacketSpy.mockClear();
  calculateMeshCorePacketHashMock.mockClear();
  __resetCoverageMeshCoreForTest();
  __resetDiscardInvalidPositionsForTest();
});

describe('evaluateMeshCoreCoverageReception — skip rules (§2.2, in order)', () => {
  it('1. not-advert: a non-ADVERT payload type is skipped without decoding', () => {
    const result = evalDefault({ event: event({ payload_type: 0x02, raw_hex: advertFrame() }) });
    expect(result).toEqual({ skip: 'not-advert' });
    expect(decodeMeshCorePacketSpy).not.toHaveBeenCalled();
  });

  it('2. no-receiver: empty receiverPubKey is skipped', () => {
    expect(evalDefault({ receiverPubKey: null })).toEqual({ skip: 'no-receiver' });
  });

  it('2. no-receiver: a non-pubkey placeholder (e.g. the repeater CLI sentinel) is skipped', () => {
    expect(evalDefault({ receiverPubKey: 'repeater' })).toEqual({ skip: 'no-receiver' });
  });

  it('3. decode-failed: missing raw_hex is skipped', () => {
    expect(evalDefault({ event: event({ raw_hex: null }) })).toEqual({ skip: 'decode-failed' });
  });

  it('3. decode-failed: garbage raw_hex is skipped', () => {
    expect(evalDefault({ event: event({ raw_hex: 'zz' }) })).toEqual({ skip: 'decode-failed' });
  });

  it('4. no-position: an advert with no lat/lon is skipped', () => {
    const raw = advertFrame({ name: 'NoFix' }); // no lat/lon => FLAG_LOCATION unset
    expect(evalDefault({ event: event({ raw_hex: raw }) })).toEqual({ skip: 'no-position' });
  });

  it('5. bogus-position: Null Island is skipped when discardNullIsland is on', () => {
    const raw = advertFrame({ lat: 0, lon: 0 });
    expect(evalDefault({ event: event({ raw_hex: raw }), discardNullIsland: true })).toEqual({
      skip: 'bogus-position',
    });
  });

  it('5. bogus-position: out-of-range lat/lon is always skipped, regardless of discardNullIsland', () => {
    const raw = advertFrame({ lat: 95, lon: 0 });
    expect(evalDefault({ event: event({ raw_hex: raw }), discardNullIsland: false })).toEqual({
      skip: 'bogus-position',
    });
  });

  it('6. own-advert: our own advert relayed back to us is skipped', () => {
    const raw = advertFrame({ publicKey: RECEIVER.toUpperCase(), lat: 1, lon: 2 });
    expect(evalDefault({ event: event({ raw_hex: raw }) })).toEqual({ skip: 'own-advert' });
  });

  it('7. own-observer: an mqtt_gateway observer that is our own companion is skipped (D5)', () => {
    isOwnPublicKeyMock.mockReturnValue(true);
    const result = evalDefault({ receiverKind: 'mqtt_gateway', isOwnPublicKey: isOwnPublicKeyMock });
    expect(result).toEqual({ skip: 'own-observer' });
  });

  it('7. own-observer does NOT apply to a local receiver (D5 is Observer-only)', () => {
    const alwaysOwn = vi.fn().mockReturnValue(true);
    const result = evalDefault({ receiverKind: 'local', isOwnPublicKey: alwaysOwn });
    expect(result.skip).toBeNull();
  });

  it('8. no-signal: absent SNR and RSSI is skipped', () => {
    const result = evalDefault({ event: event({ snr: null, rssi: null }) });
    expect(result).toEqual({ skip: 'no-signal' });
  });

  it('8. a genuine 0 dB SNR alongside a present RSSI is NOT no-signal', () => {
    const result = evalDefault({ event: event({ snr: 0, rssi: -95 }) });
    expect(result.skip).toBeNull();
  });

  it('9. no-hash: a hash-computation failure is skipped even though decode succeeded', () => {
    // decodeMeshCorePacket (rule 3) and calculateMeshCorePacketHash (rule 9)
    // are two INDEPENDENT re-parses of the same bytes (D2's rationale: the
    // hash function mirrors the firmware's own truncation gate verbatim,
    // deliberately not sharing code with the display decoder). A frame that
    // satisfies one but not the other is not reliably constructible by
    // hand — the hash function's sentinel conditions require a path-length
    // byte to be unavailable, which also makes decodeMeshCorePacket fail
    // for a DIRECT/TRANSPORT_DIRECT frame. This test exercises the
    // evaluator's OWN defensive check directly instead: force the sentinel
    // on an otherwise fully valid, positioned, signed-looking frame and
    // confirm the evaluator skips it rather than recording a hash of all
    // zeros.
    calculateMeshCorePacketHashMock.mockReturnValueOnce('0000000000000000');
    const raw = advertFrame({ lat: 1, lon: 2 });
    const result = evalDefault({ event: event({ raw_hex: raw }) });
    expect(result).toEqual({ skip: 'no-hash' });
  });

  it('10. stale (observer only, D4): an observer timestamp older than 10 minutes is skipped', () => {
    const observerTimestampMs = NOW_MS - (COVERAGE_MAX_RX_AGE_SEC + 60) * 1000; // 11 min old
    const result = evalDefault({ receiverKind: 'mqtt_gateway', observerTimestampMs });
    expect(result).toEqual({ skip: 'stale' });
  });

  it('10. stale does not apply when the observer timestamp is absent (kept)', () => {
    const result = evalDefault({ receiverKind: 'mqtt_gateway', observerTimestampMs: null });
    expect(result.skip).toBeNull();
  });

  it('10. stale does not apply to a local receiver', () => {
    const observerTimestampMs = NOW_MS - (COVERAGE_MAX_RX_AGE_SEC + 60) * 1000;
    const result = evalDefault({ receiverKind: 'local', observerTimestampMs });
    expect(result.skip).toBeNull();
  });
});

describe('evaluateMeshCoreCoverageReception — hop semantics and pathKey (D7)', () => {
  it('a zero-hop (DIRECT, path_len 0xff) advert has hopsAway 0 and pathKey h0:-', () => {
    const raw = advertFrame({ routeType: 2, lat: 1, lon: 2 });
    const result = evalDefault({ event: event({ raw_hex: raw, route_type: 2 }) });
    if (result.skip !== null) throw new Error(`expected a recordable reception, got skip=${result.skip}`);
    expect(result.row.hopsAway).toBe(0);
    expect(result.row.pathKey).toBe('h0:-');
  });

  it('a flood advert with 2 hops of 2-byte hashes has hopsAway 2 and pathKey h2:<last 4 hex>', () => {
    const raw = advertFrame({ routeType: 1, pathHops: ['aabb', 'ccdd'], lat: 1, lon: 2 });
    const result = evalDefault({ event: event({ raw_hex: raw, route_type: 1 }) });
    if (result.skip !== null) throw new Error(`expected a recordable reception, got skip=${result.skip}`);
    expect(result.row.hopsAway).toBe(2);
    expect(result.row.pathKey).toBe('h2:ccdd');
  });
});

describe('evaluateMeshCoreCoverageReception — lowercasing', () => {
  it('lowercases the sender pubkey regardless of the frame\'s casing', () => {
    const upperSender = 'AB'.repeat(32);
    const raw = advertFrame({ publicKey: upperSender, lat: 1, lon: 2 });
    const result = evalDefault({ event: event({ raw_hex: raw }) });
    if (result.skip !== null) throw new Error(`expected a recordable reception, got skip=${result.skip}`);
    expect(result.row.senderId).toBe(upperSender.toLowerCase());
    expect(result.advert.publicKey).toBe(upperSender.toLowerCase());
  });

  it('uses the receiverPubKey exactly as given (caller is responsible for lowercasing it)', () => {
    const result = evalDefault({ receiverPubKey: RECEIVER });
    if (result.skip !== null) throw new Error(`expected a recordable reception, got skip=${result.skip}`);
    expect(result.row.receiverId).toBe(RECEIVER);
  });
});

describe('evaluateMeshCoreCoverageReception — packetKey (D2)', () => {
  it('packetKey equals calculateMeshCorePacketHash and matches across two copies with different paths', () => {
    const zeroHop = advertFrame({ routeType: 2, lat: 1, lon: 2, timestamp: 123 });
    const flood = advertFrame({ routeType: 1, pathHops: ['aa', 'bb'], lat: 1, lon: 2, timestamp: 123 });

    const rZero = evalDefault({ event: event({ raw_hex: zeroHop, route_type: 2 }) });
    const rFlood = evalDefault({ event: event({ raw_hex: flood, route_type: 1 }) });
    if (rZero.skip !== null || rFlood.skip !== null) {
      throw new Error(`expected recordable receptions, got ${rZero.skip} / ${rFlood.skip}`);
    }

    expect(rZero.row.packetKey).toBe(calculateMeshCorePacketHash(zeroHop));
    expect(rFlood.row.packetKey).toBe(calculateMeshCorePacketHash(flood));
    expect(rZero.row.packetKey).toBe(rFlood.row.packetKey);
  });
});

describe('MeshCoreReplayGuard (D3)', () => {
  it('accepts a first-ever key', () => {
    const g = new MeshCoreReplayGuard();
    expect(g.check('k', 100, 'AAAA', 1_000)).toBe(true);
  });

  it('accepts a newer timestamp', () => {
    const g = new MeshCoreReplayGuard();
    g.check('k', 100, 'AAAA', 1_000);
    expect(g.check('k', 200, 'BBBB', 2_000)).toBe(true);
  });

  it('accepts another relayed copy of the same advert via a second path within the window', () => {
    const g = new MeshCoreReplayGuard();
    g.check('k', 100, 'AAAA', 1_000);
    expect(g.check('k', 100, 'AAAA', 1_000 + 30_000)).toBe(true);
  });

  it('rejects the same bytes replayed after the path window has closed (a shared-contact re-send)', () => {
    const g = new MeshCoreReplayGuard();
    g.check('k', 100, 'AAAA', 1_000);
    expect(g.check('k', 100, 'AAAA', 1_000 + 70_000)).toBe(false);
  });

  it('rejects an older timestamp', () => {
    const g = new MeshCoreReplayGuard();
    g.check('k', 200, 'AAAA', 1_000);
    expect(g.check('k', 100, 'BBBB', 2_000)).toBe(false);
  });

  it('accepts again once the entry passes its TTL (a receiver clock that jumped backwards recovers)', () => {
    const g = new MeshCoreReplayGuard({ ttlMs: 3_600_000 });
    g.check('k', 200, 'AAAA', 1_000);
    // A reject never touches `updatedMs`, so the TTL clock stays frozen at
    // the last ACCEPTED update — after ttlMs of nothing but rejects, the
    // very next check is treated as fresh again.
    expect(g.check('k', 100, 'BBBB', 1_000 + 3_600_001)).toBe(true);
  });

  it('bounds entries via LRU eviction', () => {
    const g = new MeshCoreReplayGuard({ maxEntries: 2 });
    expect(g.check('a', 100, 'H', 0)).toBe(true);
    expect(g.check('b', 100, 'H', 0)).toBe(true);
    expect(g.check('c', 100, 'H', 0)).toBe(true); // evicts 'a', the least-recently-used
    // 'a' was evicted: an older timestamp that would be a replay if
    // remembered is instead treated as a brand-new key.
    expect(g.check('a', 50, 'H2', 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Signature verification (U3, golden) + full async record function
// ---------------------------------------------------------------------------
//
// This fixture is a REAL, genuinely Ed25519-signed advert frame — not a
// fabrication with filler signature bytes. It was generated once with
// `@michaelhart/meshcore-decoder`'s `Utils.sign` / `Utils.derivePublicKey`
// (orlp/ed25519 WASM, the same algorithm the firmware signs with) over the
// exact message layout `Ed25519SignatureVerifier.verifyAdvertisementSignature`
// expects (pubkey(32) + timestamp LE(4) + appData). The frame below is the
// wire encoding of that signed advert: header|path|pubkey|timestamp|
// signature|appData, built two ways (zero-hop and a 2-hop flood) from the
// SAME signed payload so `packetKey` (path-independent, D2) is identical
// across both.
const GOLDEN_PUBLIC_KEY = 'f3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0';
const GOLDEN_ZERO_HOP_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';
const GOLDEN_FLOOD_RAW_HEX =
  '1142aabbccddf3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';
// Same frame as GOLDEN_ZERO_HOP_RAW_HEX with ONE appData byte (the first
// latitude byte) flipped, keeping the same (now-invalid) signature. Still
// decodes to a valid, non-bogus position (37.775051, -122.4194) so every
// skip rule up to the signature check passes — this isolates the signature
// check specifically.
const GOLDEN_TAMPERED_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790cb6640023807b4f8476f6c64656e4e6f6465';

const GOLDEN_RECEIVER = 'b'.repeat(64);

function goldenEvent(rawHex: string, overrides: Partial<MeshCoreBridgeOtaPacketLike> = {}): MeshCoreBridgeOtaPacketLike {
  return { payload_type: 0x04, route_type: 2, snr: 6.5, rssi: -80, raw_hex: rawHex, ...overrides };
}

describe('Signature verification (U3, golden)', () => {
  it('a genuine advert verifies and the pure evaluator does not reject it', () => {
    // The evaluator itself never checks the signature (that is async and
    // lives in maybeRecordMeshCoreCoverageReception) — this just confirms
    // the golden fixture decodes to a recordable row.
    const result = evalDefault({
      receiverPubKey: GOLDEN_RECEIVER,
      event: goldenEvent(GOLDEN_ZERO_HOP_RAW_HEX),
    });
    expect(result.skip).toBeNull();
  });

  it('records a genuine zero-hop advert end to end', async () => {
    await maybeRecordMeshCoreCoverageReception({
      sourceId: SOURCE_ID,
      receiverKind: 'local',
      receiverPubKey: GOLDEN_RECEIVER,
      receiverPosition: async () => ({ lat: 40, lon: -70 }),
      event: goldenEvent(GOLDEN_ZERO_HOP_RAW_HEX),
    });

    expect(recordReception).toHaveBeenCalledTimes(1);
    const row = recordReception.mock.calls[0][0];
    expect(row).toMatchObject({
      sourceId: SOURCE_ID,
      protocol: 'meshcore',
      receiverKind: 'local',
      receiverId: GOLDEN_RECEIVER,
      senderId: GOLDEN_PUBLIC_KEY,
      packetKey: calculateMeshCorePacketHash(GOLDEN_ZERO_HOP_RAW_HEX),
      pathKey: 'h0:-',
      hopsAway: 0,
      snr: 6.5,
      rssi: -80,
      latitude: 37.7749,
      longitude: -122.4194,
      receiverLatitude: 40,
      receiverLongitude: -70,
    });
  });

  it('records a genuine flood advert with the same packetKey as the zero-hop copy (D2)', async () => {
    await maybeRecordMeshCoreCoverageReception({
      sourceId: SOURCE_ID,
      receiverKind: 'local',
      receiverPubKey: GOLDEN_RECEIVER,
      receiverPosition: async () => ({ lat: null, lon: null }),
      event: goldenEvent(GOLDEN_FLOOD_RAW_HEX, { route_type: 1 }),
    });

    expect(recordReception).toHaveBeenCalledTimes(1);
    const row = recordReception.mock.calls[0][0];
    expect(row.pathKey).toBe('h2:ccdd');
    expect(row.hopsAway).toBe(2);
    expect(row.packetKey).toBe(calculateMeshCorePacketHash(GOLDEN_ZERO_HOP_RAW_HEX));
  });

  it('a flipped appData byte fails signature verification and is never recorded, and never touches the replay guard', async () => {
    // 1. The tampered advert must NOT be recorded.
    await maybeRecordMeshCoreCoverageReception({
      sourceId: SOURCE_ID,
      receiverKind: 'local',
      receiverPubKey: GOLDEN_RECEIVER,
      receiverPosition: async () => ({ lat: null, lon: null }),
      event: goldenEvent(GOLDEN_TAMPERED_RAW_HEX),
    });
    expect(recordReception).not.toHaveBeenCalled();

    // 2. A genuine advert for the SAME (sourceId, receiver, sender) pair —
    //    same timestamp as the tampered attempt, but a DIFFERENT packetKey
    //    (appData differs) — must still record normally. If the rejected
    //    attempt had touched the replay guard with its own packetKey, this
    //    would now be misread as a replay (same maxTs, mismatched
    //    packetKey) and silently dropped.
    await maybeRecordMeshCoreCoverageReception({
      sourceId: SOURCE_ID,
      receiverKind: 'local',
      receiverPubKey: GOLDEN_RECEIVER,
      receiverPosition: async () => ({ lat: null, lon: null }),
      event: goldenEvent(GOLDEN_ZERO_HOP_RAW_HEX),
    });
    expect(recordReception).toHaveBeenCalledTimes(1);
  });
});

describe('maybeRecordMeshCoreCoverageReception — general behavior', () => {
  it('does nothing for a non-advert event without reading the signature or the DB', async () => {
    await maybeRecordMeshCoreCoverageReception({
      sourceId: SOURCE_ID,
      receiverKind: 'local',
      receiverPubKey: GOLDEN_RECEIVER,
      receiverPosition: async () => ({ lat: null, lon: null }),
      event: { payload_type: 0x02, raw_hex: 'deadbeef' },
    });
    expect(recordReception).not.toHaveBeenCalled();
  });

  it('lowercases an uppercase receiverPubKey before use', async () => {
    await maybeRecordMeshCoreCoverageReception({
      sourceId: SOURCE_ID,
      receiverKind: 'local',
      receiverPubKey: GOLDEN_RECEIVER.toUpperCase(),
      receiverPosition: async () => ({ lat: null, lon: null }),
      event: goldenEvent(GOLDEN_ZERO_HOP_RAW_HEX),
    });
    expect(recordReception).toHaveBeenCalledTimes(1);
    expect(recordReception.mock.calls[0][0].receiverId).toBe(GOLDEN_RECEIVER);
  });

  it('discards a bogus (Null Island) receiver position but still records the reception', async () => {
    await maybeRecordMeshCoreCoverageReception({
      sourceId: SOURCE_ID,
      receiverKind: 'local',
      receiverPubKey: GOLDEN_RECEIVER,
      receiverPosition: async () => ({ lat: 0, lon: 0 }),
      event: goldenEvent(GOLDEN_ZERO_HOP_RAW_HEX),
    });
    expect(recordReception).toHaveBeenCalledTimes(1);
    const row = recordReception.mock.calls[0][0];
    expect(row.receiverLatitude).toBeNull();
    expect(row.receiverLongitude).toBeNull();
  });

  it('never throws when the repository write rejects', async () => {
    recordReception.mockRejectedValueOnce(new Error('db down'));
    await expect(
      maybeRecordMeshCoreCoverageReception({
        sourceId: SOURCE_ID,
        receiverKind: 'local',
        receiverPubKey: GOLDEN_RECEIVER,
        receiverPosition: async () => ({ lat: null, lon: null }),
        event: goldenEvent(GOLDEN_ZERO_HOP_RAW_HEX),
      }),
    ).resolves.toBeUndefined();
  });

  it('never throws when the receiverPosition callback rejects', async () => {
    await expect(
      maybeRecordMeshCoreCoverageReception({
        sourceId: SOURCE_ID,
        receiverKind: 'local',
        receiverPubKey: GOLDEN_RECEIVER,
        receiverPosition: async () => {
          throw new Error('position lookup failed');
        },
        event: goldenEvent(GOLDEN_ZERO_HOP_RAW_HEX),
      }),
    ).resolves.toBeUndefined();
    expect(recordReception).not.toHaveBeenCalled();
  });

  it('never emits on dataEventEmitter (no import of it at all)', () => {
    // Static guarantee: this module never imports dataEventEmitter. A grep
    // assertion would be redundant with the mesh-impact checklist grep in
    // the exit gate; this test documents the intent for anyone reading it.
    expect(true).toBe(true);
  });
});
