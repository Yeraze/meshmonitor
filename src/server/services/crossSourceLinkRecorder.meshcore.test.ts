/**
 * Cross-source link recorder (#5561): the MeshCore OTA / Observer path,
 * end to end through `maybeRecordMeshCoreLink` with the database mocked at
 * its four seams (source list, persisted identities, the link write).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  pubKeys: new Map<string, string>(),
  ownKeys: [] as string[],
  recordHearing: vi.fn(),
}));

vi.mock('../../services/database.js', () => {
  const db = {
    sources: {
      getAllSources: vi.fn(async () => [
        { id: 'mc-a', enabled: true }, { id: 'mc-b', enabled: true }, { id: 'mc-c', enabled: true }, { id: 'obs', enabled: true },
      ]),
    },
    settings: { getLocalNodeNumForSource: vi.fn(async () => null) },
    meshcore: { getLocalNodePublicKeysBySource: vi.fn(async () => new Map(h.pubKeys)) },
    crossSourceLinks: { recordHearing: h.recordHearing },
    ignoredNodes: { isIgnoredCached: vi.fn(() => false) },
  };
  return { default: db, databaseService: db };
});
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn().mockReturnValue(null), getAllManagers: vi.fn().mockReturnValue([]) },
}));
vi.mock('../utils/ownNodes.js', () => ({
  isOwnNodeNum: () => false,
  isOwnPublicKey: (k: string) => h.ownKeys.includes(k.toLowerCase()),
}));

import { maybeRecordMeshCoreLink, __resetCrossSourceLinkRecorderForTest } from './crossSourceLinkRecorder.js';

// Genuinely Ed25519-signed adverts (from coverageMeshCore.test.ts): same
// signed payload as a zero-hop frame, a 2-hop flood (hops aabb, ccdd), and a
// tampered zero-hop frame with an invalid signature.
const GOLDEN_PUBLIC_KEY = 'f3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0';
const GOLDEN_ZERO_HOP_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';
const GOLDEN_FLOOD_RAW_HEX =
  '1142aabbccddf3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';
const GOLDEN_TAMPERED_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790cb6640023807b4f8476f6c64656e4e6f6465';

const KEY_B = 'bb' + '11'.repeat(31);
const KEY_C = 'ccdd' + '22'.repeat(30); // matches the flood's LAST hop
const KEY_AABB = 'aabb' + '33'.repeat(30); // matches only the FIRST hop
const OBSERVER = 'ee' + '44'.repeat(31);
const NOW = 1_760_000_000_000;

beforeEach(() => {
  __resetCrossSourceLinkRecorderForTest();
  h.recordHearing.mockReset();
  h.recordHearing.mockResolvedValue(undefined);
  h.ownKeys = [];
  h.pubKeys = new Map([['mc-a', GOLDEN_PUBLIC_KEY], ['mc-b', KEY_B], ['mc-c', KEY_C]]);
});

const local = (rawHex: string, extra: Record<string, unknown> = {}) =>
  maybeRecordMeshCoreLink({
    sourceId: 'mc-b', receiverKind: 'local', receiverPubKey: KEY_B.toUpperCase(),
    event: { raw_hex: rawHex, snr: 7.5, rssi: -70 }, nowMs: NOW, ...extra,
  });

describe('maybeRecordMeshCoreLink (#5561)', () => {
  it('a signed zero-hop advert from source A heard by companion B: origin edge over RF', async () => {
    await local(GOLDEN_ZERO_HOP_RAW_HEX);
    expect(h.recordHearing).toHaveBeenCalledTimes(1);
    expect(h.recordHearing).toHaveBeenCalledWith({
      txSourceId: 'mc-a', txNodeId: GOLDEN_PUBLIC_KEY, kind: 'origin',
      rxSourceId: 'mc-b', rxNodeId: KEY_B, protocol: 'meshcore', transportClass: 'rf',
      snr: 7.5, rssi: -70, heardAt: NOW,
    });
  });

  it('the same packet heard again is counted once', async () => {
    await local(GOLDEN_ZERO_HOP_RAW_HEX);
    await local(GOLDEN_ZERO_HOP_RAW_HEX);
    expect(h.recordHearing).toHaveBeenCalledTimes(1);
  });

  it('a flooded (2-hop) copy is no origin edge, but its LAST hop is a relay edge', async () => {
    await local(GOLDEN_FLOOD_RAW_HEX);
    expect(h.recordHearing).toHaveBeenCalledTimes(1);
    expect(h.recordHearing.mock.calls[0][0]).toMatchObject({ txSourceId: 'mc-c', txNodeId: KEY_C, kind: 'relay' });
  });

  it('a source matching only an EARLIER hop gets no edge', async () => {
    h.pubKeys = new Map([['mc-a', GOLDEN_PUBLIC_KEY], ['mc-b', KEY_B], ['mc-c', KEY_AABB]]);
    await local(GOLDEN_FLOOD_RAW_HEX);
    expect(h.recordHearing).not.toHaveBeenCalled();
  });

  it('a forged advert (bad signature) claiming source A records nothing', async () => {
    await local(GOLDEN_TAMPERED_RAW_HEX);
    expect(h.recordHearing).not.toHaveBeenCalled();
  });

  it('an Observer hearing it is an mqtt_gateway edge ending at the observer', async () => {
    await maybeRecordMeshCoreLink({
      sourceId: 'obs', receiverKind: 'mqtt_gateway', receiverPubKey: OBSERVER,
      event: { raw_hex: GOLDEN_ZERO_HOP_RAW_HEX, snr: 3, rssi: null }, observerTimestampMs: NOW - 1000, nowMs: NOW,
    });
    expect(h.recordHearing.mock.calls[0][0]).toMatchObject({
      txSourceId: 'mc-a', rxSourceId: 'obs', rxNodeId: OBSERVER, transportClass: 'mqtt_gateway', kind: 'origin',
    });
  });

  it('skips an Observer that is one of our own companions, and a stale Observer capture', async () => {
    h.ownKeys = [OBSERVER];
    await maybeRecordMeshCoreLink({
      sourceId: 'obs', receiverKind: 'mqtt_gateway', receiverPubKey: OBSERVER,
      event: { raw_hex: GOLDEN_ZERO_HOP_RAW_HEX, snr: 3 }, nowMs: NOW,
    });
    h.ownKeys = [];
    await maybeRecordMeshCoreLink({
      sourceId: 'obs', receiverKind: 'mqtt_gateway', receiverPubKey: OBSERVER,
      event: { raw_hex: GOLDEN_ZERO_HOP_RAW_HEX, snr: 3 }, observerTimestampMs: NOW - 3_600_000, nowMs: NOW,
    });
    expect(h.recordHearing).not.toHaveBeenCalled();
  });

  it('a companion hearing its own source\'s advert, a missing receiver key, or junk hex records nothing and never throws', async () => {
    await maybeRecordMeshCoreLink({
      sourceId: 'mc-a', receiverKind: 'local', receiverPubKey: GOLDEN_PUBLIC_KEY,
      event: { raw_hex: GOLDEN_ZERO_HOP_RAW_HEX, snr: 1 }, nowMs: NOW,
    });
    await local(GOLDEN_ZERO_HOP_RAW_HEX, { receiverPubKey: null });
    await local('zz');
    expect(h.recordHearing).not.toHaveBeenCalled();
  });

  it('a failing write is swallowed', async () => {
    h.recordHearing.mockRejectedValue(new Error('db down'));
    await expect(local(GOLDEN_ZERO_HOP_RAW_HEX)).resolves.toBeUndefined();
  });
});
