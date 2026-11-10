/**
 * Tests for MeshCoreManager's DIRECT MESSAGE "heard repeaters" self-echo
 * correlation (#6194) — the direct-message analogue of the channel echo
 * correlation (#3700/#3979).
 *
 * When a nearby repeater re-floods one of OUR outgoing DMs, the device hears it
 * as an inbound TXT_MSG (0x02) OTA packet whose relay-hash chain names the
 * relaying repeaters. A DM body is PKI-encrypted and we hold no shared key, so
 * unlike the channel path we can NOT decrypt and exact-match the plaintext.
 * Instead we match on the packet's plaintext 1-byte `src_hash` / `dest_hash`
 * prefixes plus the time window: our own re-flooded DM carries
 * `src_hash == first byte of OUR key` and `dest_hash == first byte of the
 * RECIPIENT's key`.
 *
 * CRITICAL: those prefixes are only 1 byte, so two pending DMs to recipients
 * that share a first byte collide. We attribute ONLY when exactly one pending
 * send matches and SKIP on any ambiguity — a wrong attribution is worse than
 * none.
 *
 * This is a receive/correlation-only feature: it sends NO packets (it observes
 * re-flooded copies we already receive), so it has zero mesh/airtime impact.
 *
 * Two layers are covered:
 *  - `findDmEchoMatch` (pure): unique match, skip-on-ambiguity, window expiry,
 *    direct/zero-hop skip, non-self reject, dest-mismatch reject, dedup.
 *  - `correlateDmEcho` + `handleBridgeEvent('ota_packet')` (integration):
 *    records repeaters and emits `meshcore:channel-heard`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2';
import {
  deriveMeshCoreDmSecret,
  tryDecodeDmTextPayload,
  encodeDmTextPayload,
} from './utils/meshcoreDmCrypto.js';

const recordHeardRepeater = vi.fn();
const getHeardRepeatersForMessage = vi.fn();
const isEnabled = vi.fn().mockResolvedValue(false);
const emitMeshCoreChannelHeard = vi.fn();
const getChannelById = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      recordHeardRepeater: (...args: unknown[]) => recordHeardRepeater(...args),
      getHeardRepeatersForMessage: (...args: unknown[]) => getHeardRepeatersForMessage(...args),
    },
    channels: {
      getChannelById: (...args: unknown[]) => getChannelById(...args),
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

const TXT_MSG = 0x02;
const SELF_KEY = 'aa' + '0'.repeat(62); // first byte 'aa'
const PEER_BB = 'bb' + '1'.repeat(62);  // first byte 'bb'

/**
 * Build a raw MeshCore TXT_MSG OTA frame (hex) that `decodeMeshCorePacket` can
 * parse: header (FLOOD + TXT_MSG) + packed path-len + 1-byte relay hashes +
 * payload (`[dest_hash:1][src_hash:1][ciphertext]`).
 */
function buildDmOtaFrame(destHash: string, srcHash: string, cipherHex: string, hops: string[]): string {
  const header = 0x01 | (TXT_MSG << 2); // FLOOD (0x01) + payload type 0x02 => 0x09
  const bytes = [header, hops.length & 0x3f, ...hops.map((h) => parseInt(h, 16) & 0xff)];
  const payload = Buffer.concat([
    Buffer.from([parseInt(destHash, 16) & 0xff, parseInt(srcHash, 16) & 0xff]),
    Buffer.from(cipherHex, 'hex'),
  ]);
  return Buffer.concat([Buffer.from(bytes), payload]).toString('hex');
}

/** Build an `ota_packet` bridge payload for a TXT_MSG DM echo. */
function makeDmEcho(opts: {
  destHash?: string;
  srcHash?: string;
  cipherHex?: string;
  hops: string[];
  snr?: number;
}): Record<string, unknown> {
  const destHash = opts.destHash ?? 'bb';
  const srcHash = opts.srcHash ?? 'aa';
  const cipherHex = opts.cipherHex ?? 'deadbeefdeadbeef';
  return {
    payload_type: TXT_MSG,
    path_hops: opts.hops,
    snr: opts.snr,
    raw_hex: buildDmOtaFrame(destHash, srcHash, cipherHex, opts.hops),
  };
}

type PendingDm = { toPublicKey: string; sentAt: number; senderTimestamp: number };
function pending(entries: Array<[string, Partial<PendingDm> & { toPublicKey: string; sentAt: number }]>): Map<string, PendingDm> {
  return new Map(entries.map(([id, e]) => [id, { senderTimestamp: 0, ...e }]));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('MeshCoreManager.findDmEchoMatch (pure, 1-byte prefix + window)', () => {
  const WINDOW = 30_000;
  const opts = { selfPublicKey: SELF_KEY };

  it('attributes a DM echo to the single pending send whose recipient matches', () => {
    const now = 1_000_000;
    const p = pending([['dm-a', { toPublicKey: PEER_BB, sentAt: now - 2_000 }]]);
    const data = makeDmEcho({ destHash: 'bb', srcHash: 'aa', hops: ['a3', '7f'] });
    const match = MeshCoreManager.findDmEchoMatch(data, p, now, WINDOW, opts);
    expect(match).not.toBeNull();
    expect(match!.messageId).toBe('dm-a');
    expect(match!.pathHops).toEqual(['a3', '7f']);
    expect(match!.lastHop).toBe('7f');
    expect(typeof match!.echoKey).toBe('string');
  });

  it('SKIPS on ambiguity: two pending DMs whose recipients share a first byte', () => {
    const now = 1_000_000;
    const peer1 = 'bb' + '1'.repeat(62);
    const peer2 = 'bb' + '2'.repeat(62); // same first byte 'bb'
    const p = pending([
      ['dm-1', { toPublicKey: peer1, sentAt: now - 1_000 }],
      ['dm-2', { toPublicKey: peer2, sentAt: now - 2_000 }],
    ]);
    const data = makeDmEcho({ destHash: 'bb', srcHash: 'aa', hops: ['a3'] });
    // A wrong attribution is worse than none → null, not the oldest.
    expect(MeshCoreManager.findDmEchoMatch(data, p, now, WINDOW, opts)).toBeNull();
  });

  it('ignores direct/zero-hop packets with no relay chain', () => {
    const now = 1_000_000;
    const p = pending([['dm-a', { toPublicKey: PEER_BB, sentAt: now }]]);
    expect(
      MeshCoreManager.findDmEchoMatch(makeDmEcho({ hops: [] }), p, now, WINDOW, opts),
    ).toBeNull();
  });

  it('rejects an echo whose src_hash is not ours (another radio sent it)', () => {
    const now = 1_000_000;
    const p = pending([['dm-a', { toPublicKey: PEER_BB, sentAt: now }]]);
    const data = makeDmEcho({ destHash: 'bb', srcHash: 'cc', hops: ['a3'] });
    expect(MeshCoreManager.findDmEchoMatch(data, p, now, WINDOW, opts)).toBeNull();
  });

  it('rejects an echo whose dest_hash matches no pending recipient', () => {
    const now = 1_000_000;
    const p = pending([['dm-a', { toPublicKey: PEER_BB, sentAt: now }]]);
    const data = makeDmEcho({ destHash: 'dd', srcHash: 'aa', hops: ['a3'] });
    expect(MeshCoreManager.findDmEchoMatch(data, p, now, WINDOW, opts)).toBeNull();
  });

  it('returns null when no pending send is within the window', () => {
    const now = 1_000_000;
    const p = pending([['dm-stale', { toPublicKey: PEER_BB, sentAt: now - (WINDOW + 1) }]]);
    const data = makeDmEcho({ hops: ['a3'] });
    expect(MeshCoreManager.findDmEchoMatch(data, p, now, WINDOW, opts)).toBeNull();
  });

  it('ignores non-TXT_MSG payload types', () => {
    const now = 1_000_000;
    const p = pending([['dm-a', { toPublicKey: PEER_BB, sentAt: now }]]);
    const data = { ...makeDmEcho({ hops: ['a3'] }), payload_type: 0x05 };
    expect(MeshCoreManager.findDmEchoMatch(data, p, now, WINDOW, opts)).toBeNull();
  });

  it('returns null when our own public key is unknown (can\'t confirm self-origin)', () => {
    const now = 1_000_000;
    const p = pending([['dm-a', { toPublicKey: PEER_BB, sentAt: now }]]);
    const data = makeDmEcho({ hops: ['a3'] });
    expect(MeshCoreManager.findDmEchoMatch(data, p, now, WINDOW, { selfPublicKey: null })).toBeNull();
  });

  it('dedups repeated relay hashes and keeps lastHop from the raw chain', () => {
    const now = 1_000_000;
    const p = pending([['dm-a', { toPublicKey: PEER_BB, sentAt: now }]]);
    const data = makeDmEcho({ hops: ['A3', 'a3', '7F', '7f', 'A3'] });
    const match = MeshCoreManager.findDmEchoMatch(data, p, now, WINDOW, opts);
    expect(match!.pathHops).toEqual(['a3', '7f']);
    expect(match!.lastHop).toBe('a3');
  });

  it('gives copies of one DM over different paths different echoKeys', () => {
    const now = 1_000_000;
    const p = pending([['dm-a', { toPublicKey: PEER_BB, sentAt: now }]]);
    const viaA = makeDmEcho({ hops: ['aa'] });
    const viaB = makeDmEcho({ hops: ['bc'] });
    const a = MeshCoreManager.findDmEchoMatch(viaA, p, now, WINDOW, opts);
    const b = MeshCoreManager.findDmEchoMatch(viaB, p, now, WINDOW, opts);
    const a2 = MeshCoreManager.findDmEchoMatch(viaA, p, now, WINDOW, opts);
    expect(a!.echoKey).not.toBe(b!.echoKey);
    expect(a2!.echoKey).toBe(a!.echoKey);
  });
});

// ── #6195: device-key-backed disambiguation of colliding DM echoes ──────────

const L = ed25519.Point.Fn.ORDER;
function numLE(b: Uint8Array): bigint {
  let r = 0n;
  for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]);
  return r;
}
/** orlp-style keypair from a deterministic seed byte. */
function orlpKeypair(seedByte: number): { privHex: string; pubHex: string } {
  const h = Buffer.from(sha512(Buffer.from([seedByte, seedByte ^ 0x5a, seedByte ^ 0xa5])));
  h[0] &= 248;
  h[31] &= 127;
  h[31] |= 64;
  const scalar = h.subarray(0, 32);
  const priv64 = Buffer.concat([scalar, h.subarray(32, 64)]);
  const pub = ed25519.Point.BASE.multiply(numLE(scalar) % L).toBytes();
  return { privHex: priv64.toString('hex'), pubHex: Buffer.from(pub).toString('hex') };
}
/** Find two keypairs whose public keys share a first byte (collide on destHash). */
function collidingPeers(): { peer1: ReturnType<typeof orlpKeypair>; peer2: ReturnType<typeof orlpKeypair> } {
  const byPrefix = new Map<string, ReturnType<typeof orlpKeypair>>();
  for (let i = 0; i < 5000; i++) {
    const kp = orlpKeypair(i % 256);
    // vary the seed fully across i so prefixes differ
    const kp2 = orlpKeypair((i * 131 + 17) & 0xff);
    for (const k of [kp, kp2]) {
      const prefix = k.pubHex.slice(0, 2);
      const prev = byPrefix.get(prefix);
      if (prev && prev.pubHex !== k.pubHex) return { peer1: prev, peer2: k };
      byPrefix.set(prefix, k);
    }
  }
  throw new Error('no colliding peers found (unexpected)');
}

describe('MeshCoreManager.findDmEchoMatch — #6195 device-key disambiguation', () => {
  const WINDOW = 30_000;
  const now = 1_000_000;

  function dmEchoWithCipher(destHash: string, srcHash: string, cipherHex: string): Record<string, unknown> {
    return {
      payload_type: TXT_MSG,
      path_hops: ['a3', '7f'],
      raw_hex: buildDmOtaFrame(destHash, srcHash, cipherHex, ['a3', '7f']),
    };
  }

  it('breaks a 1-byte-prefix tie by decrypting the echo to the true recipient', () => {
    const self = orlpKeypair(200);
    const { peer1, peer2 } = collidingPeers();
    const destHash = peer1.pubHex.slice(0, 2);
    const srcHash = self.pubHex.slice(0, 2);

    // The echo was a DM WE sent to peer1: ciphertext = encryptThenMAC under the
    // ECDH(self, peer1) secret.
    const shared1 = deriveMeshCoreDmSecret(self.privHex, peer1.pubHex)!;
    const cipherHex = encodeDmTextPayload(shared1, 'ping peer1', 1700);

    const pendingMap = new Map([
      ['dm-1', { toPublicKey: peer1.pubHex, sentAt: now - 1000, senderTimestamp: 1700, text: 'ping peer1' }],
      ['dm-2', { toPublicKey: peer2.pubHex, sentAt: now - 2000, senderTimestamp: 1701, text: 'ping peer2' }],
    ]);
    const decryptDm = (enc: string, peerPub: string) => {
      const s = deriveMeshCoreDmSecret(self.privHex, peerPub);
      return s ? tryDecodeDmTextPayload(enc, s) : null;
    };

    const match = MeshCoreManager.findDmEchoMatch(
      dmEchoWithCipher(destHash, srcHash, cipherHex),
      pendingMap,
      now,
      WINDOW,
      { selfPublicKey: self.pubHex, decryptDm },
    );
    expect(match).not.toBeNull();
    expect(match!.messageId).toBe('dm-1');
  });

  it('REGRESSION: the identical collision with NO decryptDm still bails (null), unchanged from #6194', () => {
    const self = orlpKeypair(200);
    const { peer1, peer2 } = collidingPeers();
    const destHash = peer1.pubHex.slice(0, 2);
    const srcHash = self.pubHex.slice(0, 2);
    const shared1 = deriveMeshCoreDmSecret(self.privHex, peer1.pubHex)!;
    const cipherHex = encodeDmTextPayload(shared1, 'ping peer1', 1700);

    const pendingMap = new Map([
      ['dm-1', { toPublicKey: peer1.pubHex, sentAt: now - 1000, senderTimestamp: 1700, text: 'ping peer1' }],
      ['dm-2', { toPublicKey: peer2.pubHex, sentAt: now - 2000, senderTimestamp: 1701, text: 'ping peer2' }],
    ]);

    // No decryptDm → identical behaviour to the #6194 heuristic: skip on ambiguity.
    const match = MeshCoreManager.findDmEchoMatch(
      dmEchoWithCipher(destHash, srcHash, cipherHex),
      pendingMap,
      now,
      WINDOW,
      { selfPublicKey: self.pubHex },
    );
    expect(match).toBeNull();
  });

  it('a single candidate is returned even with decryptDm present (heuristic path unchanged)', () => {
    const self = orlpKeypair(200);
    const peer = orlpKeypair(5);
    const destHash = peer.pubHex.slice(0, 2);
    const srcHash = self.pubHex.slice(0, 2);
    const shared = deriveMeshCoreDmSecret(self.privHex, peer.pubHex)!;
    const cipherHex = encodeDmTextPayload(shared, 'solo', 900);

    const pendingMap = new Map([
      ['dm-solo', { toPublicKey: peer.pubHex, sentAt: now - 500, senderTimestamp: 900, text: 'solo' }],
    ]);
    const decryptDm = vi.fn((enc: string, peerPub: string) => {
      const s = deriveMeshCoreDmSecret(self.privHex, peerPub);
      return s ? tryDecodeDmTextPayload(enc, s) : null;
    });

    const match = MeshCoreManager.findDmEchoMatch(
      dmEchoWithCipher(destHash, srcHash, cipherHex),
      pendingMap,
      now,
      WINDOW,
      { selfPublicKey: self.pubHex, decryptDm },
    );
    expect(match).not.toBeNull();
    expect(match!.messageId).toBe('dm-solo');
    // The single-candidate fast path does not need to decrypt at all.
    expect(decryptDm).not.toHaveBeenCalled();
  });
});

describe('MeshCoreManager — DM-heard correlation (integration)', () => {
  beforeEach(() => {
    recordHeardRepeater.mockReset();
    getHeardRepeatersForMessage.mockReset();
    emitMeshCoreChannelHeard.mockReset();
    isEnabled.mockResolvedValue(false);
    recordHeardRepeater.mockImplementation(async (r: any) => ({
      sourceId: r.sourceId,
      messageId: r.messageId,
      repeaterHash: r.repeaterHash,
      repeaterName: r.repeaterName ?? null,
      snr: r.snr ?? null,
      hops: r.hops ?? null,
      heardAt: r.heardAt,
      createdAt: r.heardAt,
    }));
  });

  function makeManager(sourceId = 'dm-src'): MeshCoreManager {
    const m = new MeshCoreManager(sourceId);
    (m as any).localNode = { publicKey: SELF_KEY, name: 'MyNode' };
    return m;
  }
  function registerDm(m: MeshCoreManager, messageId: string, toPublicKey: string): void {
    (m as any).registerPendingDmSend(messageId, toPublicKey, 0);
  }

  it('records repeaters and emits channel-heard for a matched DM echo', async () => {
    getHeardRepeatersForMessage.mockResolvedValue([
      { repeaterHash: 'a3', repeaterName: null, snr: null, hops: 0 },
      { repeaterHash: '7f', repeaterName: null, snr: 6, hops: 1 },
    ]);
    const m = makeManager();
    registerDm(m, 'sent-dm-1', PEER_BB);
    await (m as any).correlateDmEcho(makeDmEcho({ hops: ['a3', '7f'], snr: 6 }));

    expect(recordHeardRepeater).toHaveBeenCalledTimes(2);
    // SNR is credited to the LAST hop only (the repeater we heard directly).
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'dm-src', messageId: 'sent-dm-1', repeaterHash: 'a3', snr: null, hops: 0 }),
    );
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'dm-src', messageId: 'sent-dm-1', repeaterHash: '7f', snr: 6, hops: 1 }),
    );
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sent-dm-1' }),
      'dm-src',
    );
  });

  it('records NOTHING when two pending DMs collide on the recipient first byte', async () => {
    const m = makeManager();
    registerDm(m, 'sent-dm-1', 'bb' + '1'.repeat(62));
    registerDm(m, 'sent-dm-2', 'bb' + '2'.repeat(62));
    await (m as any).correlateDmEcho(makeDmEcho({ destHash: 'bb', hops: ['a3'] }));
    expect(recordHeardRepeater).not.toHaveBeenCalled();
    expect(emitMeshCoreChannelHeard).not.toHaveBeenCalled();
  });

  it('attributes a received copy at most once even if heard twice', async () => {
    getHeardRepeatersForMessage.mockResolvedValue([{ repeaterHash: 'a3', repeaterName: null, snr: 5, hops: 0 }]);
    const m = makeManager();
    registerDm(m, 'sent-dm-1', PEER_BB);
    const echo = makeDmEcho({ hops: ['a3'], snr: 5 });
    await (m as any).correlateDmEcho(echo);
    await (m as any).correlateDmEcho(echo); // exact same copy again
    expect(recordHeardRepeater).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledTimes(1);
  });

  it('records nothing when no pending DM send matches', async () => {
    const m = makeManager();
    await (m as any).correlateDmEcho(makeDmEcho({ hops: ['a3'] }));
    expect(recordHeardRepeater).not.toHaveBeenCalled();
    expect(emitMeshCoreChannelHeard).not.toHaveBeenCalled();
  });

  it('runs from handleBridgeEvent ota_packet (wiring)', async () => {
    getHeardRepeatersForMessage.mockResolvedValue([{ repeaterHash: 'a3', repeaterName: null, snr: 5, hops: 0 }]);
    getChannelById.mockResolvedValue(null);
    const m = makeManager();
    registerDm(m, 'sent-dm-1', PEER_BB);
    // @ts-expect-error - exercising private method
    m.handleBridgeEvent({ event_type: 'ota_packet', data: makeDmEcho({ hops: ['a3'], snr: 5 }) });
    await flush();
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'sent-dm-1', repeaterHash: 'a3' }),
    );
    expect(emitMeshCoreChannelHeard).toHaveBeenCalled();
  });
});
